/**
 * 档案包合并引擎
 *
 * 两台平板离线记录后回店合并：以「藏品号（clockNo）」认领同一台钟，
 * 合并两边新增的工序（保留各自操作人与顺序）、零件与走时测试。
 * 零件处理决定一变，关联维修工序即失效，并按合并后的数据重算顺序号。
 * 缺钟表、缺零件、旧档案没有来源标记时先列清差异，确认前不动原档。
 */
import type { Clock } from '../types/clock';
import type { MovementPart, PartDecision } from '../types/part';
import type { RepairStep } from '../types/step';
import type { TimekeepingTest } from '../types/test';
import { newId } from './id';

export const PACKAGE_FORMAT = 'gbclockrepair-package';
export const PACKAGE_VERSION = 1;

/** 档案包来源标记（哪台设备、谁导出的） */
export interface PackageSource {
  deviceId: string;
  deviceName: string;
  operator: string;
  exportedAt: number;
}

/** 离线档案包：一台设备导出的完整数据 */
export interface ArchivePackage {
  format: string;
  version: number;
  source?: PackageSource;
  clocks: Clock[];
  parts: MovementPart[];
  steps: RepairStep[];
  tests: TimekeepingTest[];
}

/** 合并底库（当前本地档案） */
export interface MergeBase {
  clocks: Clock[];
  parts: MovementPart[];
  steps: RepairStep[];
  tests: TimekeepingTest[];
}

export type IssueSeverity = 'error' | 'warning';

export interface MergeIssue {
  kind: 'missing-clock' | 'missing-part' | 'no-source' | 'bad-format';
  severity: IssueSeverity;
  message: string;
  /** 供界面定位的引用（clockNo / partId 等） */
  ref?: string;
}

export interface MergeChange {
  kind:
    | 'clock-added'
    | 'clock-claimed'
    | 'part-added'
    | 'part-decision-changed'
    | 'step-added'
    | 'step-invalidated'
    | 'test-added';
  message: string;
}

export interface MergeReport {
  issues: MergeIssue[];
  changes: MergeChange[];
  errors: MergeIssue[];
  warnings: MergeIssue[];
  counts: {
    clocksAdded: number;
    clocksClaimed: number;
    partsAdded: number;
    decisionsChanged: number;
    stepsAdded: number;
    stepsInvalidated: number;
    testsAdded: number;
  };
}

export interface MergeResult {
  clocks: Clock[];
  parts: MovementPart[];
  steps: RepairStep[];
  tests: TimekeepingTest[];
  report: MergeReport;
}

/** 零件在「同一台钟 + 名称 + 装配位置」下视为同一件（跨设备本地 id 不可信） */
function partKey(clockId: string, name: string, position: string): string {
  return `${clockId}::${name}::${position}`;
}

/** 校验解析后的 JSON 是否为合法档案包，返回问题清单 */
export function validatePackage(pkg: unknown, fileName: string): MergeIssue[] {
  const issues: MergeIssue[] = [];
  if (!pkg || typeof pkg !== 'object') {
    issues.push({
      kind: 'bad-format',
      severity: 'error',
      message: `文件「${fileName}」不是有效的档案包（内容不是对象）`,
    });
    return issues;
  }
  const p = pkg as Record<string, unknown>;
  if (p.format !== PACKAGE_FORMAT) {
    issues.push({
      kind: 'bad-format',
      severity: 'error',
      message: `文件「${fileName}」格式标记不正确（format 应为 ${PACKAGE_FORMAT}）`,
    });
  }
  for (const key of ['clocks', 'parts', 'steps', 'tests'] as const) {
    if (!Array.isArray(p[key])) {
      issues.push({
        kind: 'bad-format',
        severity: 'error',
        message: `文件「${fileName}」缺少 ${key} 数组，无法合并`,
      });
    }
  }
  const src = p.source as PackageSource | undefined;
  if (!src || !src.deviceName) {
    issues.push({
      kind: 'no-source',
      severity: 'warning',
      message: `文件「${fileName}」是旧档案，缺少来源标记（source），无法追溯操作设备与操作人`,
    });
  }
  return issues;
}

/** 合并两台（或多台）设备的档案包到同一份档案 */
export function mergeArchives(base: MergeBase, packages: ArchivePackage[]): MergeResult {
  const issues: MergeIssue[] = [];
  const changes: MergeChange[] = [];

  // 最终 id -> 记录
  const clocks = new Map<string, Clock>();
  const parts = new Map<string, MovementPart>();
  const steps = new Map<string, RepairStep>();
  const tests = new Map<string, TimekeepingTest>();

  // 藏品号 -> 最终 clockId（已认领）
  const claimedClockNo = new Map<string, string>();
  // 零件业务键 -> 最终 partId
  const partKeyMap = new Map<string, string>();
  // 底库零件业务键 -> 底库处理决定（用于最终比对是否变更）
  const baseDecisionByKey = new Map<string, PartDecision>();
  // 工序来源顺序（稳定排序用）
  const stepOrderMap = new Map<string, number>();
  let stepOrder = 0;

  // 灌入底库
  for (const c of base.clocks) {
    clocks.set(c.id, { ...c });
    claimedClockNo.set(c.clockNo, c.id);
  }
  for (const p of base.parts) {
    parts.set(p.id, { ...p });
    const key = partKey(p.clockId, p.name, p.position);
    partKeyMap.set(key, p.id);
    baseDecisionByKey.set(key, p.decision);
  }
  for (const s of base.steps) {
    steps.set(s.id, { ...s, invalid: s.invalid ?? false, invalidReason: s.invalidReason ?? '' });
    stepOrderMap.set(s.id, stepOrder++);
  }
  for (const t of base.tests) {
    tests.set(t.id, { ...t });
  }

  // 依次处理每个档案包
  packages.forEach((pkg, pkgIdx) => {
    const pkgLabel = pkg.source?.deviceName || `档案包 ${pkgIdx + 1}`;
    if (!pkg.source || !pkg.source.deviceName) {
      issues.push({
        kind: 'no-source',
        severity: 'warning',
        message: `「${pkgLabel}」是旧档案，缺少来源标记（source）`,
      });
    }

    // 钟表认领：按 clockNo 匹配底库或已处理包，否则新增
    const clockRemap = new Map<string, string>();
    for (const c of pkg.clocks) {
      const existingId = claimedClockNo.get(c.clockNo);
      if (existingId) {
        clockRemap.set(c.id, existingId);
        const existing = clocks.get(existingId)!;
        clocks.set(existingId, mergeClockFields(existing, c));
        changes.push({
          kind: 'clock-claimed',
          message: `按藏品号「${c.clockNo}」认领钟表（${pkgLabel}）`,
        });
      } else {
        const genId = newId('clk');
        clockRemap.set(c.id, genId);
        claimedClockNo.set(c.clockNo, genId);
        clocks.set(genId, { ...c, id: genId });
        changes.push({
          kind: 'clock-added',
          message: `新增钟表「${c.clockNo}」（${pkgLabel}）`,
        });
      }
    }

    // 零件：按（最终 clockId + 名称 + 位置）匹配；处理决定变更则记录
    const partRemap = new Map<string, string>();
    for (const p of pkg.parts) {
      const finalClockId = clockRemap.get(p.clockId);
      if (!finalClockId) {
        issues.push({
          kind: 'missing-clock',
          severity: 'error',
          message: `零件「${p.name}」（${p.position}）引用了档案包中缺失的钟表（clockId=${p.clockId}）`,
        });
        continue;
      }
      const key = partKey(finalClockId, p.name, p.position);
      const existingPartId = partKeyMap.get(key);
      if (existingPartId) {
        partRemap.set(p.id, existingPartId);
        const existing = parts.get(existingPartId)!;
        if (existing.decision !== p.decision) {
          changes.push({
            kind: 'part-decision-changed',
            message: `零件「${p.name}」处理决定由「${existing.decision}」改为「${p.decision}」（${pkgLabel}）`,
          });
        }
        parts.set(existingPartId, {
          ...existing,
          decision: p.decision,
          wearState: p.wearState,
          sourceLot: p.sourceLot || existing.sourceLot,
          qtyNeeded: p.qtyNeeded,
          dimension: p.dimension,
        });
      } else {
        const genId = newId('prt');
        partKeyMap.set(key, genId);
        partRemap.set(p.id, genId);
        parts.set(genId, { ...p, id: genId, clockId: finalClockId });
        changes.push({
          kind: 'part-added',
          message: `新增零件「${p.name}」（${p.position}）（${pkgLabel}）`,
        });
      }
    }

    // 工序：重映射 clockId / partIds，保留操作人及工序内容
    for (const s of pkg.steps) {
      const finalClockId = clockRemap.get(s.clockId);
      if (!finalClockId) {
        issues.push({
          kind: 'missing-clock',
          severity: 'error',
          message: `工序「${s.stepType} #${s.seq}」引用了档案包中缺失的钟表（clockId=${s.clockId}）`,
        });
        continue;
      }
      const finalPartIds: string[] = [];
      for (const pid of s.partIds ?? []) {
        const fp = partRemap.get(pid);
        if (fp) {
          finalPartIds.push(fp);
        } else {
          issues.push({
            kind: 'missing-part',
            severity: 'error',
            message: `工序「${s.stepType} #${s.seq}」引用了缺失的零件（partId=${pid}）`,
          });
        }
      }
      const genId = newId('stp');
      steps.set(genId, {
        ...s,
        id: genId,
        clockId: finalClockId,
        partIds: finalPartIds,
        invalid: false,
        invalidReason: '',
      });
      stepOrderMap.set(genId, stepOrder++);
      changes.push({
        kind: 'step-added',
        message: `新增工序「${s.stepType} #${s.seq}」（操作人 ${s.operator || '未填'}，${pkgLabel}）`,
      });
    }

    // 走时测试
    for (const t of pkg.tests) {
      const finalClockId = clockRemap.get(t.clockId);
      if (!finalClockId) {
        issues.push({
          kind: 'missing-clock',
          severity: 'error',
          message: `走时测试（${new Date(t.testedAt).toLocaleString('zh-CN')}）引用了档案包中缺失的钟表（clockId=${t.clockId}）`,
        });
        continue;
      }
      const genId = newId('tst');
      tests.set(genId, { ...t, id: genId, clockId: finalClockId });
      changes.push({
        kind: 'test-added',
        message: `新增走时测试（${new Date(t.testedAt).toLocaleString('zh-CN')}，${pkgLabel}）`,
      });
    }
  });

  // 找出最终处理决定相对底库发生变更的零件
  const decisionChangedPartIds = new Set<string>();
  for (const [key, finalPartId] of partKeyMap) {
    const baseDecision = baseDecisionByKey.get(key);
    if (baseDecision === undefined) continue; // 新增零件不视为变更
    const finalDecision = parts.get(finalPartId)?.decision;
    if (finalDecision && finalDecision !== baseDecision) {
      decisionChangedPartIds.add(finalPartId);
    }
  }

  // 关联工序失效
  for (const [sid, step] of steps) {
    if (step.partIds.some((pid) => decisionChangedPartIds.has(pid))) {
      steps.set(sid, {
        ...step,
        invalid: true,
        invalidReason: '零件处理决定变更，关联工序需重新确认',
      });
      changes.push({
        kind: 'step-invalidated',
        message: `工序「${step.stepType} #${step.seq}」因零件处理决定变更而失效`,
      });
    }
  }

  // 按钟表重算顺序号：稳定排序（startedAt -> 来源顺序），保留各边顺序，重排为 1..N 不跳号
  const byClock = new Map<string, RepairStep[]>();
  for (const s of steps.values()) {
    const arr = byClock.get(s.clockId) ?? [];
    arr.push(s);
    byClock.set(s.clockId, arr);
  }
  for (const [, arr] of byClock) {
    arr.sort((a, b) => {
      if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
      return (stepOrderMap.get(a.id) ?? 0) - (stepOrderMap.get(b.id) ?? 0);
    });
    arr.forEach((s, i) => {
      steps.set(s.id, { ...s, seq: i + 1 });
    });
  }

  return {
    clocks: Array.from(clocks.values()),
    parts: Array.from(parts.values()),
    steps: Array.from(steps.values()),
    tests: Array.from(tests.values()),
    report: buildReport(issues, changes),
  };
}

/** 合并钟表档案：底库已有字段不覆盖，仅补齐空字段 */
function mergeClockFields(base: Clock, incoming: Clock): Clock {
  const merged: Clock = { ...base };
  const bv = base as unknown as Record<string, unknown>;
  const iv = incoming as unknown as Record<string, unknown>;
  const mv = merged as unknown as Record<string, unknown>;
  for (const key of Object.keys(incoming) as (keyof Clock)[]) {
    if (key === 'id' || key === 'clockNo' || key === 'createdAt') continue;
    const baseVal = bv[key];
    const incVal = iv[key];
    if ((baseVal === '' || baseVal === null || baseVal === undefined) && incVal !== '' && incVal !== null && incVal !== undefined) {
      mv[key] = incVal;
    }
  }
  return merged;
}

function buildReport(issues: MergeIssue[], changes: MergeChange[]): MergeReport {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return {
    issues,
    changes,
    errors,
    warnings,
    counts: {
      clocksAdded: changes.filter((c) => c.kind === 'clock-added').length,
      clocksClaimed: changes.filter((c) => c.kind === 'clock-claimed').length,
      partsAdded: changes.filter((c) => c.kind === 'part-added').length,
      decisionsChanged: changes.filter((c) => c.kind === 'part-decision-changed').length,
      stepsAdded: changes.filter((c) => c.kind === 'step-added').length,
      stepsInvalidated: changes.filter((c) => c.kind === 'step-invalidated').length,
      testsAdded: changes.filter((c) => c.kind === 'test-added').length,
    },
  };
}

/** 把当前档案打包为离线档案包（含来源标记） */
export function buildPackage(source: PackageSource, base: MergeBase): ArchivePackage {
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    source,
    clocks: base.clocks.map((c) => ({ ...c })),
    parts: base.parts.map((p) => ({ ...p })),
    steps: base.steps.map((s) => ({ ...s })),
    tests: base.tests.map((t) => ({ ...t })),
  };
}

/** 触发浏览器下载档案包 JSON */
export function downloadPackage(pkg: ArchivePackage, fileName?: string): void {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download =
    fileName ?? `档案包_${pkg.source?.deviceName || 'export'}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const STASH_KEY = 'gbclockrepair:merge-stash';

/** 合并暂存：写入前保存，失败后保留两边的包并重试 */
export interface MergeStash {
  packages: ArchivePackage[];
  result: MergeResult;
  savedAt: number;
}

export function saveStash(stash: MergeStash): void {
  try {
    window.localStorage.setItem(STASH_KEY, JSON.stringify(stash));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function loadStash(): MergeStash | null {
  try {
    const raw = window.localStorage.getItem(STASH_KEY);
    return raw ? (JSON.parse(raw) as MergeStash) : null;
  } catch {
    return null;
  }
}

export function clearStash(): void {
  try {
    window.localStorage.removeItem(STASH_KEY);
  } catch {
    /* ignore */
  }
}
