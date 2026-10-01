import type { Clock } from '../types/clock';
import type { MovementPart } from '../types/part';
import type { RepairStep } from '../types/step';
import type { TimekeepingTest } from '../types/test';
import { BUNDLE_VERSION, type MergeBundle } from '../types/merge';
import { getLocalSourceTag } from './sourceTag';

/** 读取用户选择的离线包文件为文本 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

/** 导包文件名：gbclockrepair_来源_时间.json */
export function bundleFileName(bundle: MergeBundle): string {
  const stamp = new Date(bundle.exportedAt)
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  const safeTag = bundle.sourceTag.replace(/[\\/:*?"<>|\s]+/g, '_');
  return `gbclockrepair_${safeTag}_${stamp}.json`;
}

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 把本机档案（可限定藏品号）导出为离线数据包 */
export function exportBundle(
  local: {
    clocks: Clock[];
    parts: MovementPart[];
    steps: RepairStep[];
    tests: TimekeepingTest[];
  },
  note?: string,
  clockIds?: string[],
): MergeBundle {
  const pickClocks = clockIds && clockIds.length > 0 ? local.clocks.filter((c) => clockIds.includes(c.id)) : local.clocks;
  const ids = new Set(pickClocks.map((c) => c.id));
  const bundle: MergeBundle = {
    format: 'gbclockrepair-bundle',
    version: BUNDLE_VERSION,
    sourceTag: getLocalSourceTag(),
    note,
    exportedAt: Date.now(),
    clocks: pickClocks.map((c) => JSON.parse(JSON.stringify(c))),
    parts: local.parts.filter((p) => ids.has(p.clockId)).map((p) => JSON.parse(JSON.stringify(p))),
    steps: local.steps.filter((s) => ids.has(s.clockId)).map((s) => JSON.parse(JSON.stringify(s))),
    tests: local.tests.filter((t) => ids.has(t.clockId)).map((t) => JSON.parse(JSON.stringify(t))),
  };
  download(bundleFileName(bundle), JSON.stringify(bundle, null, 2));
  return bundle;
}
