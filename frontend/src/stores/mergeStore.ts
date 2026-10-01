import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import type { MergePlan, ParsedBundle, StoredBundle } from '../types/merge';
import { buildMergePlan, type LocalSnapshot } from '../utils/mergeEngine';

interface PendingSession {
  sessionId: string;
  storedA: StoredBundle;
  storedB: StoredBundle;
  plan: MergePlan;
}

interface MergeState {
  /** 待重试 / 待确认的会话（按两个暂存包重建） */
  sessions: PendingSession[];
  /** 已成功合并的历史，仅留最近记录 */
  history: { sessionId: string; mergedAt: number; clockNos: string[] }[];
  loaded: boolean;
}

export const useMergeStore = defineStore('merge', {
  state: (): MergeState => ({ sessions: [], history: [], loaded: false }),

  getters: {
    pendingSessions: (state) =>
      state.sessions.filter((s) => s.storedA.status !== 'merged' || s.storedB.status !== 'merged'),
  },

  actions: {
    /** 载入全部暂存包并按会话配成待处理合并 */
    async load() {
      const rows = await db.mergeBundles.orderBy('storedAt').toArray();
      const groups = new Map<string, StoredBundle[]>();
      for (const row of rows) {
        const list = groups.get(row.sessionId) ?? [];
        list.push(row);
        groups.set(row.sessionId, list);
      }
      const sessions: PendingSession[] = [];
      for (const [sessionId, pair] of groups) {
        if (pair.every((p) => p.status === 'merged')) continue;
        const storedA = pair.find((p) => p.side === 'A');
        const storedB = pair.find((p) => p.side === 'B');
        if (!storedA || !storedB) continue;
        const local = await readSnapshot();
        const plan = buildMergePlan(
          local,
          { fileName: storedA.fileName, bundle: storedA.payload },
          { fileName: storedB.fileName, bundle: storedB.payload },
        );
        sessions.push({ sessionId, storedA, storedB, plan });
      }
      this.sessions = sessions.sort((x, y) => y.storedA.storedAt - x.storedA.storedAt);
      this.loaded = true;
    },

    /**
     * 预演：不写库，只生成差异与合并计划（供“先列差异、确认前不动原档”）。
     */
    preview(local: LocalSnapshot, a: ParsedBundle, b: ParsedBundle): MergePlan {
      return buildMergePlan(local, a, b);
    },

    /**
     * 确认合并：先把两边的包原样暂存，再在一个 IndexedDB 事务里原子写入。
     * 写入失败时包保留为 failed，可重试；成功后标记 merged。
     */
    async commit(plan: MergePlan): Promise<{ ok: true } | { ok: false; error: string }> {
      if (!plan.sideA.bundle || !plan.sideB.bundle) {
        return { ok: false, error: '两个离线包都必须有效' };
      }
      if (plan.blocked) {
        return { ok: false, error: '存在阻断差异（如本机缺钟表），请先处理后重试' };
      }

      const sessionId = newId('mrg');
      const now = Date.now();
      const storedA: StoredBundle = {
        id: newId('bnd'),
        sessionId,
        fileName: plan.sideA.fileName,
        side: 'A',
        sourceTag: plan.sideA.bundle.sourceTag,
        payload: toPlain(plan.sideA.bundle),
        status: 'pending',
        storedAt: now,
        attempts: 0,
      };
      const storedB: StoredBundle = {
        id: newId('bnd'),
        sessionId,
        fileName: plan.sideB.fileName,
        side: 'B',
        sourceTag: plan.sideB.bundle.sourceTag,
        payload: toPlain(plan.sideB.bundle),
        status: 'pending',
        storedAt: now,
        attempts: 0,
      };
      // 先暂存两边的包（独立事务），保证之后写入失败包仍在
      await db.mergeBundles.bulkPut([toPlain(storedA), toPlain(storedB)]);

      const result = await this.writePlan(sessionId, plan);
      if (result.ok) {
        this.history.unshift({
          sessionId,
          mergedAt: Date.now(),
          clockNos: plan.clockNos,
        });
        this.history = this.history.slice(0, 20);
        await this.load();
      } else {
        await this.load();
      }
      return result;
    },

    /** 重试：用当前最新原档重建计划并写入；缺钟等阻断仍会挡住并提示 */
    async retry(sessionId: string): Promise<{ ok: boolean; error?: string }> {
      const session = this.sessions.find((s) => s.sessionId === sessionId);
      if (!session) return { ok: false, error: '未找到该合并会话' };
      const local = await readSnapshot();
      const plan = buildMergePlan(
        local,
        { fileName: session.storedA.fileName, bundle: session.storedA.payload },
        { fileName: session.storedB.fileName, bundle: session.storedB.payload },
      );
      session.plan = plan;
      if (plan.blocked) {
        const first = plan.diffs.find((d) => d.level === 'block');
        const error = first?.message ?? '仍存在阻断差异';
        // 阻断同样要在保留的两个包上留痕（独立事务，绝不碰业务原档）
        await this.markFailed(sessionId, error);
        await this.load();
        return { ok: false, error };
      }
      const result = await this.writePlan(sessionId, plan);
      if (!result.ok) await this.load();
      return result;
    },

    /** 在独立事务里把某次合并保留的两个包标记为 failed（用于失败留痕 / 重试） */
    async markFailed(sessionId: string, error: string): Promise<void> {
      try {
        await db.transaction('rw', db.mergeBundles, async () => {
          await db.mergeBundles
            .filter((r) => r.sessionId === sessionId)
            .modify((r) => {
              r.status = 'failed';
              r.lastError = error;
              r.attempts = (r.attempts ?? 0) + 1;
            });
        });
      } catch {
        /* 连标记都失败时，两个包本身仍原样保留在暂存表，可重试 */
      }
    },

    /** 丢弃已确认无用的暂存包（如缺钟无法处理，决定不合并） */
    async discard(sessionId: string) {
      const rows = await db.mergeBundles.filter((r) => r.sessionId === sessionId).toArray();
      await db.mergeBundles.bulkDelete(rows.map((r) => r.id));
      await this.load();
    },

    /** 真正写库：单事务原子提交，失败不改动原档；失败后把两边的包标记 failed 以便重试 */
    async writePlan(
      sessionId: string,
      plan: MergePlan,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
      if (!plan.sideA.bundle || !plan.sideB.bundle) return { ok: false, error: '离线包无效' };

      try {
        await db.transaction(
          'rw',
          db.clocks,
          db.parts,
          db.steps,
          db.tests,
          db.mergeBundles,
          async () => {
            for (const cp of plan.clocks) {
              // 事务内再次确认认领状态，避免计划过期
              const exists = await db.clocks.get(cp.clock.id);
              if (!exists && !cp.claimed) {
                throw new Error(`钟表「${cp.clockNo}」在本机仍不存在，已中止，原档未改动`);
              }
              await db.clocks.put(toPlain(cp.clock));
              for (const mp of cp.parts) await db.parts.put(toPlain(mp.part));
              for (const ms of cp.steps) await db.steps.put(toPlain(ms.step));
              for (const t of cp.tests) await db.tests.put(toPlain(t));
            }
            // 全部业务表写入成功后，才把两边的包标记为已合并
            await db.mergeBundles
              .filter((r) => r.sessionId === sessionId)
              .modify((r) => {
                r.status = 'merged';
                r.lastError = undefined;
                r.attempts = (r.attempts ?? 0) + 1;
              });
          },
        );
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 关键：在新的独立事务里标记失败，不能复用已中止事务的连接
        await this.markFailed(sessionId, message);
        return { ok: false, error: message };
      }
    },
  },
});

/** 读取本机四张表作为合并原档快照 */
export async function readSnapshot(): Promise<LocalSnapshot> {
  const [clocks, parts, steps, tests] = await Promise.all([
    db.clocks.toArray(),
    db.parts.toArray(),
    db.steps.toArray(),
    db.tests.toArray(),
  ]);
  return { clocks, parts, steps, tests };
}
