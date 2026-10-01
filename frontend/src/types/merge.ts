import type { Clock } from './clock';
import type { MovementPart } from './part';
import type { RepairStep } from './step';
import type { TimekeepingTest } from './test';

/** 数据包结构版本 */
export const BUNDLE_VERSION = 1;

/** 离线数据包：一台平板/分店就某台（或多台）钟表导出的档案切片 */
export interface MergeBundle {
  /** 固定标识，用于识别文件格式 */
  format: 'gbclockrepair-bundle';
  version: number;
  /** 导出方来源标记，如 和平店-平板甲 */
  sourceTag: string;
  /** 导包说明（操作人/事由） */
  note?: string;
  exportedAt: number;
  clocks: Clock[];
  parts: MovementPart[];
  steps: RepairStep[];
  tests: TimekeepingTest[];
}

/** 解析后的包（附带解析错误） */
export interface ParsedBundle {
  fileName: string;
  bundle?: MergeBundle;
  error?: string;
}

export type DiffLevel = 'block' | 'warn' | 'info';

export type DiffKind =
  | 'missing-clock' // 另一方缺该钟表，无法认领
  | 'part-missing-side' // 零件只在一边登记
  | 'part-decision-conflict' // 两边零件处理决定不一致
  | 'missing-source-tag' // 旧档案缺来源标记
  | 'step-relink' // 工序因零件决定变更将失效
  | 'duplicate-step' // 两边判定为同一道工序
  | 'duplicate-test' // 两边判定为同一次走时测试
  | 'clock-field-conflict'; // 钟表主体字段两边不一致

export interface DiffEntry {
  level: DiffLevel;
  kind: DiffKind;
  clockNo: string;
  message: string;
  /** 关联零件业务键 / 工序指纹等，供确认与重算使用 */
  ref?: string;
}

/** 零件匹配后的合并结论 */
export interface MergedPart {
  /** 合并后落库的零件（id 已按本机重映射） */
  part: MovementPart;
  /** 来自哪一边 / 两边一致 */
  from: 'A' | 'B' | 'both';
  /** 两边决定是否冲突（冲突已按优先级定论） */
  decisionChanged: boolean;
  beforeDecision?: string;
  /** 业务键：名称 + 装配位置 */
  key: string;
}

/** 归并后的工序（顺序已按合并后数据重排） */
export interface MergedStep {
  step: RepairStep;
  from: 'A' | 'B' | 'both';
  /** 是否因关联零件决定一变而失效 */
  invalidated: boolean;
  /** 失效时关联的零件业务键 */
  invalidPartKeys: string[];
}

/** 单台钟表的合并计划 */
export interface ClockMergePlan {
  clockNo: string;
  /** 本机已有该钟（按藏品号认领成功） */
  localClock?: Clock;
  /** 合并后的钟表主体 */
  clock: Clock;
  /** 认领状态 */
  claimed: boolean;
  parts: MergedPart[];
  steps: MergedStep[];
  tests: TimekeepingTest[];
  diffs: DiffEntry[];
}

/** 一次双包合并的完整计划 */
export interface MergePlan {
  parsedAt: number;
  sideA: ParsedBundle;
  sideB: ParsedBundle;
  /** 参与合并的全部藏品号 */
  clockNos: string[];
  clocks: ClockMergePlan[];
  diffs: DiffEntry[];
  /** 是否存在阻断项（缺钟等），存在则禁止写原档 */
  blocked: boolean;
  /** 是否存在必须确认的警告（旧档无来源标记等） */
  needsConfirm: boolean;
}

/** 暂存包状态：写入失败后两边的包原样保留，可重试 */
export type StoredBundleStatus = 'pending' | 'failed' | 'merged';

export interface StoredBundle {
  id: string;
  /** 同一次合并的两个包共用一个会话号，重试时按会话配对 */
  sessionId: string;
  fileName: string;
  side: 'A' | 'B';
  sourceTag: string;
  payload: MergeBundle;
  status: StoredBundleStatus;
  storedAt: number;
  /** 最近一次写入失败原因 */
  lastError?: string;
  attempts: number;
}

/** 零件处理决定优先级：决定冲突时“换新 > 修配 > 保留” */
export const DECISION_RANK: Record<string, number> = {
  换新: 3,
  修配: 2,
  保留: 1,
};
