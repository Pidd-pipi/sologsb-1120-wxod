/** 本机来源标记：标识记录是在哪台平板/分店录入的，离线合并时用来追溯操作人一侧 */

const LOCAL_TAG_KEY = 'gbclockrepair:source-tag';
export const DEFAULT_LOCAL_TAG = '本店主机';

export function getLocalSourceTag(): string {
  try {
    return window.localStorage.getItem(LOCAL_TAG_KEY)?.trim() || DEFAULT_LOCAL_TAG;
  } catch {
    return DEFAULT_LOCAL_TAG;
  }
}

export function setLocalSourceTag(tag: string): void {
  try {
    window.localStorage.setItem(LOCAL_TAG_KEY, tag.trim() || DEFAULT_LOCAL_TAG);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
