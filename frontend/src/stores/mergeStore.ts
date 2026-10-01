import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import {
  buildPackage,
  clearStash,
  downloadPackage,
  loadStash,
  mergeArchives,
  saveStash,
  validatePackage,
  type ArchivePackage,
  type MergeBase,
  type MergeIssue,
  type MergeReport,
  type MergeResult,
  type MergeStash,
  type PackageSource,
} from '../utils/merge';

interface MergeState {
  /** 已解析的档案包（两边的包都保留，写入失败也不清空） */
  packages: ArchivePackage[];
  /** 合并结果（预览用，确认前不写库） */
  result: MergeResult | null;
  report: MergeReport | null;
  writing: boolean;
  writeError: string;
  /** 写入前暂存，失败后可重试 */
  stash: MergeStash | null;
  loadedFromStash: boolean;
}

export const useMergeStore = defineStore('merge', {
  state: (): MergeState => ({
    packages: [],
    result: null,
    report: null,
    writing: false,
    writeError: '',
    stash: null,
    loadedFromStash: false,
  }),
  getters: {
    hasErrors: (state) => (state.report?.errors.length ?? 0) > 0,
    hasWarnings: (state) => (state.report?.warnings.length ?? 0) > 0,
    totalRecords: (state) =>
      state.result
        ? state.result.clocks.length + state.result.parts.length + state.result.steps.length + state.result.tests.length
        : 0,
  },
  actions: {
    async loadBase(): Promise<MergeBase> {
      const [clocks, parts, steps, tests] = await Promise.all([
        db.clocks.toArray(),
        db.parts.toArray(),
        db.steps.toArray(),
        db.tests.toArray(),
      ]);
      return { clocks, parts, steps, tests };
    },

    /** 读取并解析多个档案包文件，随后与当前底库合并预览 */
    async importFiles(files: File[]) {
      const packages: ArchivePackage[] = [];
      const fileIssues: MergeIssue[] = [];

      for (const file of files) {
        let json: unknown;
        try {
          json = JSON.parse(await file.text());
        } catch {
          fileIssues.push({
            kind: 'bad-format',
            severity: 'error',
            message: `文件「${file.name}」不是合法 JSON，无法解析`,
          });
          continue;
        }
        const issues = validatePackage(json, file.name);
        fileIssues.push(...issues);
        if (issues.some((i) => i.kind === 'bad-format' && i.severity === 'error')) {
          continue;
        }
        packages.push(json as ArchivePackage);
      }

      this.packages = packages;
      this.writeError = '';

      if (packages.length === 0) {
        this.result = null;
        this.report = {
          issues: fileIssues,
          changes: [],
          errors: fileIssues.filter((i) => i.severity === 'error'),
          warnings: fileIssues.filter((i) => i.severity === 'warning'),
          counts: {
            clocksAdded: 0,
            clocksClaimed: 0,
            partsAdded: 0,
            decisionsChanged: 0,
            stepsAdded: 0,
            stepsInvalidated: 0,
            testsAdded: 0,
          },
        };
        return;
      }

      const base = await this.loadBase();
      const result = mergeArchives(base, packages);
      // 文件解析阶段的问题并入报告
      result.report.issues = [...fileIssues, ...result.report.issues];
      result.report.errors = result.report.issues.filter((i) => i.severity === 'error');
      result.report.warnings = result.report.issues.filter((i) => i.severity === 'warning');
      this.result = result;
      this.report = result.report;
    },

    /** 把当前档案打包下载（含来源标记） */
    async exportCurrent(source: PackageSource) {
      const base = await this.loadBase();
      downloadPackage(buildPackage(source, base));
    },

    /** 确认写入：先暂存再事务写入；失败保留包与暂存，可重试 */
    async confirmWrite(): Promise<boolean> {
      if (!this.result) return false;
      this.writing = true;
      this.writeError = '';
      const stash: MergeStash = {
        packages: this.packages,
        result: this.result,
        savedAt: Date.now(),
      };
      saveStash(stash);
      this.stash = stash;
      try {
        const { clocks, parts, steps, tests } = this.result;
        await db.transaction('rw', db.clocks, db.parts, db.steps, db.tests, async () => {
          await db.clocks.bulkPut(toPlain(clocks));
          await db.parts.bulkPut(toPlain(parts));
          await db.steps.bulkPut(toPlain(steps));
          await db.tests.bulkPut(toPlain(tests));
        });
        clearStash();
        this.stash = null;
        this.writeError = '';
        return true;
      } catch (e) {
        // 写入失败：保留两边的包与暂存，界面可重试
        this.writeError = e instanceof Error ? e.message : String(e);
        return false;
      } finally {
        this.writing = false;
      }
    },

    /** 重试写入（沿用暂存的包与结果） */
    async retry(): Promise<boolean> {
      if (this.stash) {
        this.packages = this.stash.packages;
        this.result = this.stash.result;
        this.report = this.stash.result.report;
      }
      return this.confirmWrite();
    },

    /** 启动时检查是否有未完成的合并暂存 */
    checkStashOnStartup() {
      const s = loadStash();
      if (s) {
        this.stash = s;
        this.packages = s.packages;
        this.result = s.result;
        this.report = s.result.report;
        this.loadedFromStash = true;
      }
    },

    /** 放弃暂存并清空当前合并状态 */
    discardStash() {
      clearStash();
      this.stash = null;
      this.loadedFromStash = false;
      this.packages = [];
      this.result = null;
      this.report = null;
      this.writeError = '';
    },
  },
});
