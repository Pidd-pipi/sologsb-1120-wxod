import { mergeArchives, validatePackage, buildPackage, type ArchivePackage, type MergeBase } from '../src/utils/merge';
import type { Clock } from '../src/types/clock';
import type { MovementPart } from '../src/types/part';
import type { RepairStep } from '../src/types/step';
import type { TimekeepingTest } from '../src/types/test';

function makeClock(id: string, clockNo: string): Clock {
  return {
    id,
    clockNo,
    kind: '座钟',
    caliber: 'Junghans W278',
    origin: '德国',
    maker: 'Junghans',
    yearMade: '1932',
    caseMaterial: '木',
    size: '1',
    dialMark: '盘',
    acquireFrom: '藏家',
    conditionGrade: '三级',
    storagePos: 'A-1',
    createdAt: 1000,
  };
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log('  PASS:', msg);
  } else {
    failures++;
    console.error('  FAIL:', msg);
  }
}

// ---- 场景：两台平板回店合并同一台钟 ----
const baseClockId = 'clk_base';
const basePartId = 'prt_base_fatiao';
const baseStepId = 'stp_base_1';

const base: MergeBase = {
  clocks: [makeClock(baseClockId, 'CLK-001')],
  parts: [
    {
      id: basePartId,
      clockId: baseClockId,
      name: '发条',
      qtyNeeded: 1,
      position: '条盒内',
      wearState: '磨损',
      decision: '保留',
      sourceLot: '',
      dimension: 0.35,
    } as MovementPart,
  ],
  steps: [
    {
      id: baseStepId,
      clockId: baseClockId,
      stepType: '清洗',
      seq: 1,
      partIds: [basePartId],
      cleanSolvent: '石油醚',
      cleanMethod: '超声',
      oilType: '',
      oilPoints: '',
      torque: 0,
      troubleNote: '',
      operator: '祁仲言',
      startedAt: 1000,
      state: 'done',
    } as RepairStep,
  ],
  tests: [],
};

// 平板 A：新增宝石轴承零件 + 一道工序（操作人 A）
const pkgA: ArchivePackage = {
  format: 'gbclockrepair-package',
  version: 1,
  source: { deviceId: 'devA', deviceName: '一号平板', operator: '祁仲言', exportedAt: 2000 },
  clocks: [makeClock('clk_a', 'CLK-001')],
  parts: [
    {
      id: 'prt_a_baoshi',
      clockId: 'clk_a',
      name: '宝石轴承',
      qtyNeeded: 4,
      position: '二轮上下轴孔',
      wearState: '磨损',
      decision: '修配',
      sourceLot: 'JWL-18',
      dimension: 1.2,
    } as MovementPart,
  ],
  steps: [
    {
      id: 'stp_a_1',
      clockId: 'clk_a',
      stepType: '润滑',
      seq: 1,
      partIds: ['prt_a_baoshi'],
      cleanSolvent: '',
      cleanMethod: '',
      oilType: 'Moebius 9010',
      oilPoints: '二轮上下轴孔',
      torque: 0,
      troubleNote: '',
      operator: '祁仲言',
      startedAt: 3000,
      state: 'pending',
    } as RepairStep,
  ],
  tests: [],
};

// 平板 B：同一台钟，发条决定改为换新，新增一道关联发条的工序（操作人 B）
const pkgB: ArchivePackage = {
  format: 'gbclockrepair-package',
  version: 1,
  source: { deviceId: 'devB', deviceName: '二号平板', operator: '李师傅', exportedAt: 2000 },
  clocks: [makeClock('clk_b', 'CLK-001')],
  parts: [
    {
      id: 'prt_b_fatiao',
      clockId: 'clk_b',
      name: '发条',
      qtyNeeded: 1,
      position: '条盒内',
      wearState: '断裂',
      decision: '换新',
      sourceLot: 'MS-2024-07',
      dimension: 0.35,
    } as MovementPart,
  ],
  steps: [
    {
      id: 'stp_b_1',
      clockId: 'clk_b',
      stepType: '装配',
      seq: 1,
      partIds: ['prt_b_fatiao'],
      cleanSolvent: '',
      cleanMethod: '',
      oilType: '',
      oilPoints: '',
      torque: 0.6,
      troubleNote: '',
      operator: '李师傅',
      startedAt: 4000,
      state: 'pending',
    } as RepairStep,
  ],
  tests: [],
};

const result = mergeArchives(base, [pkgA, pkgB]);

console.log('\n== 钟表认领 ==');
assert(result.clocks.length === 1, '同一台钟按 clockNo 认领，不新增重复钟表');
assert(result.clocks[0].id === baseClockId, '认领后保留底库钟表 id');

console.log('\n== 零件合并 ==');
assert(result.parts.length === 2, '零件合并为 2 项（发条 + 宝石轴承）');
const fatiao = result.parts.find((p) => p.name === '发条')!;
assert(fatiao.decision === '换新', '发条处理决定已合并为「换新」');
const baoshi = result.parts.find((p) => p.name === '宝石轴承')!;
assert(baoshi.decision === '修配', '宝石轴承保留「修配」');

console.log('\n== 工序合并与顺序 ==');
assert(result.steps.length === 3, '两边工序都保留，共 3 道');
const seqs = result.steps.map((s) => s.seq).sort((a, b) => a - b);
assert(JSON.stringify(seqs) === '[1,2,3]', `顺序号重排为连续 1..N（实际 ${seqs.join(',')}）`);
const operators = result.steps.map((s) => s.operator).sort();
assert(JSON.stringify(operators) === '["李师傅","祁仲言","祁仲言"]', '两边操作人各自保留');

console.log('\n== 零件决定变更 -> 关联工序失效 ==');
const fatiaoSteps = result.steps.filter((s) => s.partIds.includes(fatiao.id));
assert(fatiaoSteps.length === 2, '关联发条的工序有 2 道（底库清洗 + B 装配）');
assert(fatiaoSteps.every((s) => s.invalid === true), '发条决定变更后，关联工序全部失效');
const baoshiSteps = result.steps.filter((s) => s.partIds.includes(baoshi.id));
assert(baoshiSteps.every((s) => !s.invalid), '宝石轴承决定未变，关联工序不失效');
assert(result.report.counts.stepsInvalidated === 2, '失效计数为 2');

console.log('\n== 变更报告 ==');
assert(result.report.counts.clocksClaimed === 2, '认领钟表计数 2');
assert(result.report.counts.decisionsChanged === 1, '处理决定变更计数 1');
assert(result.report.counts.stepsAdded === 2, '新增工序计数 2');

console.log('\n== 缺钟表 / 缺零件 / 无来源标记 ==');
const orphanPkg: ArchivePackage = {
  format: 'gbclockrepair-package',
  version: 1,
  // 无 source
  clocks: [makeClock('clk_orphan', 'CLK-ORPHAN')],
  parts: [
    {
      id: 'prt_orphan',
      clockId: 'clk_orphan',
      name: '螺丝',
      qtyNeeded: 1,
      position: '夹板',
      wearState: '完好',
      decision: '保留',
      sourceLot: '',
      dimension: 1,
    } as MovementPart,
  ],
  steps: [
    {
      id: 'stp_orphan_clock',
      clockId: 'clk_missing',
      stepType: '装配',
      seq: 1,
      partIds: [],
      cleanSolvent: '',
      cleanMethod: '',
      oilType: '',
      oilPoints: '',
      torque: 0,
      troubleNote: '',
      operator: '某人',
      startedAt: 5000,
      state: 'pending',
    } as RepairStep,
    {
      id: 'stp_orphan_part',
      clockId: 'clk_orphan',
      stepType: '装配',
      seq: 1,
      partIds: ['prt_missing'],
      cleanSolvent: '',
      cleanMethod: '',
      oilType: '',
      oilPoints: '',
      torque: 0,
      troubleNote: '',
      operator: '某人',
      startedAt: 5001,
      state: 'pending',
    } as RepairStep,
  ],
  tests: [],
};
const r2 = mergeArchives(base, [orphanPkg]);
const errorKinds = r2.report.errors.map((i) => i.kind);
assert(errorKinds.includes('missing-clock'), '缺钟表列为错误');
assert(errorKinds.includes('missing-part'), '缺零件列为错误');
assert(r2.report.warnings.some((i) => i.kind === 'no-source'), '旧档案无来源标记列为警告');
assert(r2.report.errors.length >= 2, '错误项在确认前列清');

console.log('\n== 非法文件 ==');
const badIssues = validatePackage({ foo: 1 }, 'bad.json');
assert(badIssues.some((i) => i.kind === 'bad-format'), '格式不正确的包被识别');

console.log('\n== 导出 ==');
const pkg = buildPackage(
  { deviceId: 'dev', deviceName: '台式机', operator: '祁仲言', exportedAt: 1 },
  base,
);
assert(pkg.format === 'gbclockrepair-package' && pkg.source?.deviceName === '台式机', '导出包含来源标记');

console.log(`\n${failures === 0 ? '全部通过 ✅' : `有 ${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
