import type { Clock } from '../types/clock';
import type { MovementPart } from '../types/part';
import type { RepairStep } from '../types/step';
import type { TimekeepingTest } from '../types/test';
import { newId } from './id';
import {
  BUNDLE_VERSION,
  DECISION_RANK,
  type ClockMergePlan,
  type DiffEntry,
  type DiffKind,
  type DiffLevel,
  type MergeBundle,
  type MergePlan,
  type MergedPart,
  type MergedStep,
  type ParsedBundle,
} from '../types/merge';

/** 本机档案快照（合并时的“原档”） */
export interface LocalSnapshot {
  clocks: Clock[];
  parts: MovementPart[];
  steps: RepairStep[];
  tests: TimekeepingTest[];
}

/** 零件业务键：同名 + 同装配位置视为同一个零件（跨设备 id 不同也能对上） */
export function partKey(part: Pick<MovementPart, 'name' | 'position'>): string {
  return `${part.name}§${(part.position || '').trim()}`;
}

/** 工序指纹：两道内容一致的工序视为同一道（分叉前的公共工序） */
export function stepFingerprint(step: RepairStep): string {
  return [
    step.stepType,
    step.operator.trim(),
    step.cleanSolvent.trim(),
    step.cleanMethod.trim(),
    step.oilType.trim(),
    step.oilPoints.trim(),
    step.torque,
    step.troubleNote.trim(),
  ].join('§');
}

/** 走时测试指纹：同一时刻同读数视为同一次测试 */
export function testFingerprint(test: TimekeepingTest): string {
  return [test.testedAt, test.rate, test.amplitude, test.beatError, test.powerReserve].join('§');
}

function diff(
  level: DiffLevel,
  kind: DiffKind,
  clockNo: string,
  message: string,
  ref?: string,
): DiffEntry {
  return { level, kind, clockNo, message, ref };
}

/** 校验并解析离线包文件内容 */
export function parseBundle(fileName: string, raw: string): ParsedBundle {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { fileName, error: '文件不是合法 JSON，无法解析' };
  }
  if (!data || typeof data !== 'object') {
    return { fileName, error: '文件内容结构不正确' };
  }
  const obj = data as Partial<MergeBundle>;
  if (obj.format !== 'gbclockrepair-bundle') {
    return { fileName, error: '缺少 gbclockrepair-bundle 标识，不是本系统的离线包' };
  }
  if (typeof obj.version !== 'number' || obj.version > BUNDLE_VERSION) {
    return { fileName, error: `数据包版本 ${obj.version ?? '未知'} 高于本机支持的 v${BUNDLE_VERSION}` };
  }
  if (!obj.sourceTag || typeof obj.sourceTag !== 'string') {
    return { fileName, error: '离线包缺少来源标记（sourceTag）' };
  }
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  const bundle: MergeBundle = {
    format: 'gbclockrepair-bundle',
    version: obj.version,
    sourceTag: obj.sourceTag,
    note: typeof obj.note === 'string' ? obj.note : undefined,
    exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : Date.now(),
    clocks: list(obj.clocks),
    parts: list(obj.parts),
    steps: list(obj.steps),
    tests: list(obj.tests),
  };
  return { fileName, bundle };
}

function hasSourceTag(tag: string | undefined): boolean {
  return typeof tag === 'string' && tag.trim().length > 0;
}

/** 零件决定冲突时按 换新 > 修配 > 保留 取定论 */
export function resolveDecision(a: MovementPart['decision'], b: MovementPart['decision']): MovementPart['decision'] {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

const CLOCK_FIELDS: (keyof Clock)[] = [
  'kind',
  'caliber',
  'origin',
  'maker',
  'yearMade',
  'caseMaterial',
  'size',
  'dialMark',
  'conditionGrade',
];

interface PartTriple {
  key: string;
  local?: MovementPart;
  a?: MovementPart;
  b?: MovementPart;
}

/**
 * 生成双包合并计划（纯计算，不写库）。
 * 规则：按藏品号认领；缺钟阻断；缺零件 / 旧档无来源标记先列差异；
 * 零件决定一变，关联工序失效；两边新增工序保留操作人并按时间归并顺序。
 */
export function buildMergePlan(
  local: LocalSnapshot,
  parsedA: ParsedBundle,
  parsedB: ParsedBundle,
): MergePlan {
  const plan: MergePlan = {
    parsedAt: Date.now(),
    sideA: parsedA,
    sideB: parsedB,
    clockNos: [],
    clocks: [],
    diffs: [],
    blocked: false,
    needsConfirm: false,
  };

  const a = parsedA.bundle;
  const b = parsedB.bundle;
  if (!a || !b) return plan;

  const localByNo = new Map(local.clocks.map((c) => [c.clockNo, c]));
  const aByNo = new Map(a.clocks.map((c) => [c.clockNo, c]));
  const bByNo = new Map(b.clocks.map((c) => [c.clockNo, c]));
  const clockNos = Array.from(new Set([...aByNo.keys(), ...bByNo.keys()]));
  plan.clockNos = clockNos;

  for (const clockNo of clockNos) {
    const aClock = aByNo.get(clockNo);
    const bClock = bByNo.get(clockNo);
    const localClock = localByNo.get(clockNo);
    const cp = buildClockPlan(clockNo, localClock, aClock, bClock, local, a, b);
    plan.clocks.push(cp);
    plan.diffs.push(...cp.diffs);
  }

  plan.blocked = plan.diffs.some((d) => d.level === 'block');
  plan.needsConfirm = plan.diffs.some((d) => d.level === 'warn');
  return plan;
}

function buildClockPlan(
  clockNo: string,
  localClock: Clock | undefined,
  aClock: Clock | undefined,
  bClock: Clock | undefined,
  local: LocalSnapshot,
  a: MergeBundle,
  b: MergeBundle,
): ClockMergePlan {
  const diffs: DiffEntry[] = [];

  // —— 认领：同一台钟按藏品号认领 ——
  if (!localClock) {
    diffs.push(
      diff(
        'block',
        'missing-clock',
        clockNo,
        `本机档案中没有藏品号「${clockNo}」，无法认领。请先在本机建档（或核对藏品号）后再合并`,
      ),
    );
  }
  if (!aClock || !bClock) {
    const onlySide = !aClock ? 'B' : 'A';
    if (localClock) {
      diffs.push(
        diff(
          'info',
          'missing-clock',
          clockNo,
          `另一台平板（${onlySide === 'A' ? 'B 包' : 'A 包'}）不含该钟，仅合并 ${onlySide} 包的增量`,
        ),
      );
    } else {
      diffs.push(
        diff(
          'block',
          'missing-clock',
          clockNo,
          `藏品号「${clockNo}」只出现在 ${onlySide} 包，另一方与本机均无此钟，不能确认是同一台`,
        ),
      );
    }
  }

  const mergedClockId = localClock?.id ?? aClock?.id ?? bClock?.id ?? newId('clk');
  const clock: Clock = localClock
    ? { ...localClock }
    : { ...(aClock ?? (bClock as Clock)), id: mergedClockId };

  // 钟表主体字段两边不一致（不阻断，保留本机值）
  if (aClock && bClock) {
    for (const field of CLOCK_FIELDS) {
      if (String(aClock[field] ?? '') !== String(bClock[field] ?? '')) {
        diffs.push(
          diff(
            'info',
            'clock-field-conflict',
            clockNo,
            `字段「${field}」两边不一致（A：${aClock[field] || '空'} / B：${bClock[field] || '空'}），保留本机值`,
            String(field),
          ),
        );
      }
    }
  }

  const localParts = local.parts.filter((p) => p.clockId === localClock?.id);
  const aParts = a.parts.filter((p) => p.clockId === aClock?.id);
  const bParts = b.parts.filter((p) => p.clockId === bClock?.id);

  // 零件来源标记检查（旧档无标记 → 先列差异，确认前不动原档）
  for (const p of [...localParts, ...aParts, ...bParts]) {
    if (!hasSourceTag(p.sourceTag)) {
      diffs.push(
        diff(
          'warn',
          'missing-source-tag',
          clockNo,
          `零件「${p.name} · ${p.position}」的旧档案没有来源标记，合并前请确认来源`,
          partKey(p),
        ),
      );
    }
  }

  // —— 零件：按 名称+位置 对齐 ——
  const triples = new Map<string, PartTriple>();
  const ensureTriple = (key: string): PartTriple => {
    let t = triples.get(key);
    if (!t) {
      t = { key };
      triples.set(key, t);
    }
    return t;
  };
  localParts.forEach((p) => (ensureTriple(partKey(p)).local = p));
  aParts.forEach((p) => (ensureTriple(partKey(p)).a = p));
  bParts.forEach((p) => (ensureTriple(partKey(p)).b = p));

  const mergedParts: MergedPart[] = [];
  /** 各侧旧零件 id → 合并后零件 id，供工序 partIds 重映射 */
  const partIdMap = new Map<string, string>();
  /** 失效判定：业务键 → 各侧原决定与最终决定 */
  const partDecisionTrace = new Map<
    string,
    { local?: string; a?: string; b?: string; final: string }
  >();

  for (const t of triples.values()) {
    const incoming = t.a ?? t.b;
    const base = t.local ?? incoming;
    let decision = base!.decision;
    let decisionChanged = false;
    let beforeDecision: string | undefined;

    if (t.a && t.b && t.a.decision !== t.b.decision) {
      const winner = resolveDecision(t.a.decision, t.b.decision);
      diffs.push(
        diff(
          'warn',
          'part-decision-conflict',
          clockNo,
          `零件「${base!.name} · ${base!.position}」处理决定两边不一致（A：${t.a.decision} / B：${t.b.decision}），按规则定论为「${winner}」`,
          t.key,
        ),
      );
      decision = winner;
    } else if (incoming && t.local && incoming.decision !== t.local.decision) {
      decision = incoming.decision;
    }

    if (t.local) {
      beforeDecision = t.local.decision;
      decisionChanged = decision !== t.local.decision;
      if (decisionChanged) {
        diffs.push(
          diff(
            'warn',
            'part-decision-conflict',
            clockNo,
            `零件「${base!.name} · ${base!.position}」处理决定由「${t.local.decision}」变为「${decision}」，关联维修工序将失效重算`,
            t.key,
          ),
        );
      }
    } else if (t.a && !t.b) {
      diffs.push(
        diff(
          'warn',
          'part-missing-side',
          clockNo,
          `零件「${base!.name} · ${base!.position}」仅 A 包（${a.sourceTag}）登记，B 包与本机原档均无，确认后新增`,
          t.key,
        ),
      );
    } else if (t.b && !t.a) {
      diffs.push(
        diff(
          'warn',
          'part-missing-side',
          clockNo,
          `零件「${base!.name} · ${base!.position}」仅 B 包（${b.sourceTag}）登记，A 包与本机原档均无，确认后新增`,
          t.key,
        ),
      );
    }

    const mergedId = t.local?.id ?? newId('prt');
    if (t.a) partIdMap.set(t.a.id, mergedId);
    if (t.b) partIdMap.set(t.b.id, mergedId);

    // 字段取值：本机优先，其次 A，再 B；决定采用定论
    const sourceOfFields = t.local ?? t.a ?? t.b!;
    const mergedPart: MovementPart = {
      ...sourceOfFields,
      id: mergedId,
      clockId: mergedClockId,
      decision: decision as MovementPart['decision'],
      sourceTag:
        t.local?.sourceTag ||
        t.a?.sourceTag ||
        t.b?.sourceTag ||
        sourceOfFields.sourceTag ||
        '',
    };
    mergedParts.push({
      part: mergedPart,
      from: t.local ? 'both' : t.a && t.b ? 'both' : t.a ? 'A' : 'B',
      decisionChanged,
      beforeDecision,
      key: t.key,
    });
    partDecisionTrace.set(t.key, {
      local: t.local?.decision,
      a: t.a?.decision,
      b: t.b?.decision,
      final: decision,
    });
  }

  const mergedPartById = new Map(mergedParts.map((mp) => [mp.part.id, mp]));

  // —— 工序：公共工序去重，两边新增工序保留各自操作人与顺序 ——
  const localSteps = local.steps
    .filter((s) => s.clockId === localClock?.id)
    .sort((x, y) => x.seq - y.seq);
  const aSteps = a.steps
    .filter((s) => s.clockId === aClock?.id)
    .sort((x, y) => (x.originSeq ?? x.seq) - (y.originSeq ?? y.seq) || x.startedAt - y.startedAt);
  const bSteps = b.steps
    .filter((s) => s.clockId === bClock?.id)
    .sort((x, y) => (x.originSeq ?? x.seq) - (y.originSeq ?? y.seq) || x.startedAt - y.startedAt);

  if (localSteps.some((s) => !hasSourceTag(s.sourceTag))) {
    diffs.push(
      diff('warn', 'missing-source-tag', clockNo, '本机部分维修工序没有来源标记，合并前请确认操作人归属'),
    );
  }

  const localFp = new Set(localSteps.map(stepFingerprint));
  const seenIncomingFp = new Set<string>();
  const newFromA: RepairStep[] = [];
  const newFromB: RepairStep[] = [];

  for (const s of aSteps) {
    const fp = stepFingerprint(s);
    if (localFp.has(fp)) continue; // 本机已有同一道（公共历史）
    if (seenIncomingFp.has(fp)) continue;
    if (bSteps.some((x) => stepFingerprint(x) === fp)) {
      seenIncomingFp.add(fp);
      diffs.push(
        diff('info', 'duplicate-step', clockNo, `A、B 包含同一道工序「${s.seq} ${s.stepType}（${s.operator}）」，只保留一份`),
      );
      // 两边都有的“新增”工序，归到 A 一次即可
    }
    newFromA.push(s);
  }
  for (const s of bSteps) {
    const fp = stepFingerprint(s);
    if (localFp.has(fp)) continue;
    if (seenIncomingFp.has(fp)) continue;
    newFromB.push(s);
  }

  // 跨设备按开工时间归并（稳定排序，各自一侧的相对顺序保持不变）
  const incoming = [
    ...newFromA.map((s): [RepairStep, 'A'] => [s, 'A']),
    ...newFromB.map((s): [RepairStep, 'B'] => [s, 'B']),
  ].sort(
    (x, y) =>
      x[0].startedAt - y[0].startedAt ||
      (x[1] === y[1] ? (x[0].originSeq ?? x[0].seq) - (y[0].originSeq ?? y[0].seq) : x[1] === 'A' ? -1 : 1),
  );

  const mergedSteps: MergedStep[] = [];
  let seq = 0;

  const remapAndInvalidate = (
    step: RepairStep,
    from: 'A' | 'B' | 'both',
    sideDecision: 'local' | 'a' | 'b',
  ): MergedStep => {
    const invalidPartKeys: string[] = [];
    const remappedIds: string[] = [];
    for (const oldId of step.partIds) {
      const newId = from === 'both' && sideDecision === 'local' ? oldId : partIdMap.get(oldId);
      const resolvedId = newId ?? oldId;
      const mp = mergedPartById.get(resolvedId);
      if (!mp) {
        diffs.push(
          diff(
            'info',
            'step-relink',
            clockNo,
            `工序「${step.stepType}（${step.operator}）」关联的零件在合并后档案中不存在，已解除该关联`,
          ),
        );
        continue;
      }
      remappedIds.push(resolvedId);
      const trace = partDecisionTrace.get(mp.key);
      const knownBefore = trace?.[sideDecision];
      if (trace && knownBefore !== undefined && trace.final !== knownBefore) {
        invalidPartKeys.push(mp.key);
      }
    }

    seq += 1;
    const invalidated = invalidPartKeys.length > 0;
    const next: RepairStep = {
      ...step,
      id: from === 'both' && sideDecision === 'local' ? step.id : newId('stp'),
      clockId: mergedClockId,
      seq,
      originSeq: step.originSeq ?? step.seq,
      partIds: remappedIds,
      sourceTag: step.sourceTag || (from === 'A' ? a.sourceTag : from === 'B' ? b.sourceTag : localClock?.sourceTag),
      state: invalidated ? 'invalid' : step.state === 'invalid' ? 'pending' : step.state,
      invalidReason: invalidated
        ? `关联零件决定变更：${invalidPartKeys
            .map((k) => {
              const mp = mergedParts.find((x) => x.key === k);
              return mp ? `${mp.part.name}·${mp.part.position}→「${mp.part.decision}」` : k;
            })
            .join('；')}`
        : undefined,
    };
    if (invalidated) {
      diffs.push(
        diff(
          'warn',
          'step-relink',
          clockNo,
          `工序 #${seq}「${step.stepType}（${step.operator}）」因关联零件决定变更已置为失效，需按新决定重做`,
          invalidPartKeys.join(','),
        ),
      );
    }
    return { step: next, from, invalidated, invalidPartKeys };
  };

  // 本机工序先占顺序（保持原序），新增工序续号
  for (const s of localSteps) mergedSteps.push(remapAndInvalidate(s, 'both', 'local'));
  for (const [s, side] of incoming) mergedSteps.push(remapAndInvalidate(s, side, side === 'A' ? 'a' : 'b'));

  // —— 走时测试：同读数去重，其余全部并入 ——
  const localTests = local.tests.filter((t) => t.clockId === localClock?.id);
  const aTests = a.tests.filter((t) => t.clockId === aClock?.id);
  const bTests = b.tests.filter((t) => t.clockId === bClock?.id);
  const mergedTests: TimekeepingTest[] = localTests.map((t) => ({ ...t }));
  const testSeen = new Set(localTests.map(testFingerprint));
  for (const [t, side] of [
    ...aTests.map((t): [TimekeepingTest, 'A'] => [t, 'A']),
    ...bTests.map((t): [TimekeepingTest, 'B'] => [t, 'B']),
  ]) {
    const fp = testFingerprint(t);
    if (testSeen.has(fp)) {
      diffs.push(
        diff('info', 'duplicate-test', clockNo, `${side === 'A' ? 'A' : 'B'} 包的走时测试（${new Date(t.testedAt).toLocaleString('zh-CN')}）与已有记录重复，跳过`),
      );
      continue;
    }
    testSeen.add(fp);
    mergedTests.push({
      ...t,
      id: newId('tst'),
      clockId: mergedClockId,
      sourceTag: t.sourceTag || (side === 'A' ? a.sourceTag : b.sourceTag),
    });
  }

  return {
    clockNo,
    localClock,
    clock,
    claimed: Boolean(localClock),
    parts: mergedParts,
    steps: mergedSteps,
    tests: mergedTests,
    diffs,
  };
}
