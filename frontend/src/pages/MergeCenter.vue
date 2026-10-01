<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import { useStepStore } from '../stores/stepStore';
import { useMergeStore, readSnapshot } from '../stores/mergeStore';
import { parseBundle, type LocalSnapshot } from '../utils/mergeEngine';
import { exportBundle, readFileAsText } from '../utils/bundle';
import { getLocalSourceTag, setLocalSourceTag } from '../utils/sourceTag';
import type { DiffEntry, MergePlan, ParsedBundle } from '../types/merge';

const clockStore = useClockStore();
const partStore = usePartStore();
const stepStore = useStepStore();
const mergeStore = useMergeStore();

const localTag = ref(getLocalSourceTag());
const fileA = ref<{ name: string; raw: string } | null>(null);
const fileB = ref<{ name: string; raw: string } | null>(null);
const parsedA = ref<ParsedBundle | null>(null);
const parsedB = ref<ParsedBundle | null>(null);
const plan = ref<MergePlan | null>(null);
const committing = ref(false);
const activeClock = ref('');
const confirmTick = ref(false);

const blockDiffs = computed(() => plan.value?.diffs.filter((d) => d.level === 'block') ?? []);
const warnDiffs = computed(() => plan.value?.diffs.filter((d) => d.level === 'warn') ?? []);
const infoDiffs = computed(() => plan.value?.diffs.filter((d) => d.level === 'info') ?? []);
const clockTabs = computed(() => plan.value?.clocks ?? []);

function diffTagType(level: DiffEntry['level']): 'error' | 'warning' | 'info' {
  if (level === 'block') return 'error';
  if (level === 'warn') return 'warning';
  return 'info';
}
function diffKindLabel(kind: DiffEntry['kind']): string {
  const map: Record<DiffEntry['kind'], string> = {
    'missing-clock': '缺钟表',
    'part-missing-side': '缺零件',
    'part-decision-conflict': '决定冲突',
    'missing-source-tag': '无来源标记',
    'step-relink': '工序失效',
    'duplicate-step': '工序重复',
    'duplicate-test': '测试重复',
    'clock-field-conflict': '字段差异',
  };
  return map[kind];
}
function stepRowClass({ row }: { row: { invalidated?: boolean } }): string {
  return row.invalidated ? 'invalid-row' : '';
}

async function pickFile(side: 'A' | 'B', file: File | undefined) {
  if (!file) return;
  const raw = await readFileAsText(file);
  const parsed = parseBundle(file.name, raw);
  if (side === 'A') {
    fileA.value = { name: file.name, raw };
    parsedA.value = parsed;
  } else {
    fileB.value = { name: file.name, raw };
    parsedB.value = parsed;
  }
  plan.value = null;
  confirmTick.value = false;
  if (parsed.error) ElMessage.error(`${file.name}：${parsed.error}`);
  else ElMessage.success(`${side} 包已读取：${parsed.bundle?.sourceTag}`);
}

async function analyze() {
  if (!parsedA.value?.bundle || !parsedB.value?.bundle) {
    ElMessage.error('请先选择两台平板导出的两个离线包');
    return;
  }
  const local = await readSnapshot();
  plan.value = mergeStore.preview(local, parsedA.value, parsedB.value);
  activeClock.value = plan.value.clocks[0]?.clockNo ?? '';
  confirmTick.value = false;
  if (plan.value.blocked) {
    ElMessage.error('存在阻断项，已列清差异，确认并处理前不会改动原档');
  } else if (plan.value.needsConfirm) {
    ElMessage.warning('差异已列出，请逐条确认后再写入');
  } else {
    ElMessage.success('预检通过，无阻断 / 待确认差异');
  }
}

async function confirmMerge() {
  if (!plan.value) return;
  if (plan.value.blocked) {
    ElMessage.error('仍有阻断项（如缺钟表），不能写入。请先处理后重试');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认把两边档案合并写入本机？共 ${plan.value.clockNos.length} 台钟、${warnDiffs.value.length} 条需确认差异。`,
      '合并前最后确认',
      { type: 'warning', confirmButtonText: '确认写入', cancelButtonText: '再看看' },
    );
  } catch {
    return;
  }
  committing.value = true;
  const result = await mergeStore.commit(plan.value);
  committing.value = false;
  if (result.ok) {
    ElMessage.success('合并写入成功');
    plan.value = null;
    parsedA.value = null;
    parsedB.value = null;
    fileA.value = null;
    fileB.value = null;
    confirmTick.value = false;
    await Promise.all([clockStore.load(), partStore.load(), stepStore.load()]);
  } else {
    ElMessage.error(`写入失败，两边的包已保留，可在下方重试：${result.error}`);
  }
}

async function retrySession(sessionId: string) {
  committing.value = true;
  const result = await mergeStore.retry(sessionId);
  committing.value = false;
  if (result.ok) {
    ElMessage.success('重试合并成功');
    await Promise.all([clockStore.load(), partStore.load(), stepStore.load()]);
  } else {
    ElMessage.error(`重试未成功，包仍保留：${result.error}`);
  }
}

async function discardSession(sessionId: string) {
  try {
    await ElMessageBox.confirm('丢弃这次合并的两个暂存包？丢弃后无法再重试。', '确认丢弃', {
      type: 'warning',
    });
  } catch {
    return;
  }
  await mergeStore.discard(sessionId);
  ElMessage.success('已丢弃暂存包');
}

function exportLocal() {
  exportBundle(
    {
      clocks: clockStore.items,
      parts: partStore.items,
      steps: stepStore.items,
      tests: stepStore.tests,
    },
    '回店合并前导出',
  );
  ElMessage.success('已导出本机离线包');
}

function saveTag() {
  setLocalSourceTag(localTag.value);
  localTag.value = getLocalSourceTag();
  ElMessage.success(`本机来源标记已设为「${localTag.value}」`);
}

onMounted(async () => {
  await Promise.all([clockStore.load(), partStore.load(), stepStore.load(), mergeStore.load()]);
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>离线档案合并</h2>
      <el-tag type="info" effect="plain">同一台钟按藏品号认领</el-tag>
      <div class="spacer" />
      <el-input v-model="localTag" style="width: 200px" placeholder="本机来源标记" />
      <el-button @click="saveTag">保存标记</el-button>
      <el-button type="primary" @click="exportLocal">导出本机离线包</el-button>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="流程：两台平板的包 → 预检列差异（缺钟表 / 缺零件 / 旧档无来源标记）→ 确认后写入。确认前不动原档；写入失败两边的包原样保留，可重试。"
      style="margin-bottom: 12px"
    />

    <!-- 1. 选包 -->
    <el-card shadow="never">
      <template #header><strong>第一步 · 选择两台平板的离线包</strong></template>
      <div class="pickers">
        <div class="picker">
          <div class="picker-title">A 包（平板一）</div>
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept="application/json,.json"
            :on-change="(f: any) => pickFile('A', f.raw)"
          >
            <el-button>选择 A 包文件</el-button>
          </el-upload>
          <div v-if="parsedA" class="picker-meta">
            <el-tag v-if="!parsedA.error" type="success" size="small">{{ parsedA.bundle?.sourceTag }}</el-tag>
            <el-tag v-else type="danger" size="small">{{ parsedA.error }}</el-tag>
            <span class="fname">{{ fileA?.name }}</span>
          </div>
        </div>
        <div class="picker">
          <div class="picker-title">B 包（平板二）</div>
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept="application/json,.json"
            :on-change="(f: any) => pickFile('B', f.raw)"
          >
            <el-button>选择 B 包文件</el-button>
          </el-upload>
          <div v-if="parsedB" class="picker-meta">
            <el-tag v-if="!parsedB.error" type="success" size="small">{{ parsedB.bundle?.sourceTag }}</el-tag>
            <el-tag v-else type="danger" size="small">{{ parsedB.error }}</el-tag>
            <span class="fname">{{ fileB?.name }}</span>
          </div>
        </div>
        <el-button
          type="primary"
          size="large"
          :disabled="!parsedA?.bundle || !parsedB?.bundle"
          @click="analyze"
        >
          预检并列出差异
        </el-button>
      </div>
    </el-card>

    <!-- 2. 差异总览 -->
    <el-card v-if="plan" shadow="never">
      <template #header>
        <div class="card-head">
          <strong>第二步 · 差异清单（确认前不写原档）</strong>
          <el-tag type="error">阻断 {{ blockDiffs.length }}</el-tag>
          <el-tag type="warning">待确认 {{ warnDiffs.length }}</el-tag>
          <el-tag type="info">提示 {{ infoDiffs.length }}</el-tag>
        </div>
      </template>

      <el-alert
        v-if="plan.blocked"
        type="error"
        :closable="false"
        show-icon
        title="存在阻断项：通常是本机缺该藏品号的钟表。请先在台账建档后再点预检 / 重试，原档尚未改动。"
        style="margin-bottom: 10px"
      />

      <el-table :data="plan.diffs" size="small" border max-height="260">
        <el-table-column label="级别" width="90">
          <template #default="{ row }">
            <el-tag :type="diffTagType(row.level)" size="small">
              {{ row.level === 'block' ? '阻断' : row.level === 'warn' ? '待确认' : '提示' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="110">
          <template #default="{ row }">{{ diffKindLabel(row.kind) }}</template>
        </el-table-column>
        <el-table-column prop="clockNo" label="藏品号" width="150" />
        <el-table-column prop="message" label="说明" min-width="360" />
      </el-table>

      <div class="confirm-bar">
        <el-checkbox v-model="confirmTick" :disabled="plan.blocked">
          我已核对上述差异，确认零件决定与来源无误
        </el-checkbox>
        <el-button
          type="primary"
          :loading="committing"
          :disabled="plan.blocked || !confirmTick"
          @click="confirmMerge"
        >
          确认并写入合并
        </el-button>
      </div>
    </el-card>

    <!-- 3. 分钟合并明细 -->
    <el-card v-if="plan && clockTabs.length" shadow="never">
      <template #header><strong>第三步 · 合并后档案预览（按钟表）</strong></template>
      <el-tabs v-model="activeClock">
        <el-tab-pane v-for="cp in clockTabs" :key="cp.clockNo" :name="cp.clockNo">
          <template #label>
            <span :class="{ 'tab-block': !cp.claimed }">{{ cp.clockNo }}{{ cp.claimed ? '' : '（缺钟）' }}</span>
          </template>

          <div v-if="!cp.claimed" class="missing">
            本机无此藏品号，下列内容仅预览，不会写入。请先到「钟表台账」建档。
          </div>

          <h4>零件（{{ cp.parts.length }}）— 决定冲突按 换新 &gt; 修配 &gt; 保留 定论</h4>
          <el-table :data="cp.parts" size="small" border>
            <el-table-column prop="part.name" label="零件" width="110" />
            <el-table-column prop="part.position" label="位置" min-width="140" />
            <el-table-column label="最终决定" width="100">
              <template #default="{ row }">
                <el-tag :type="row.decisionChanged ? 'danger' : 'success'" size="small">{{ row.part.decision }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="原决定" width="90">
              <template #default="{ row }">{{ row.beforeDecision || '—' }}</template>
            </el-table-column>
            <el-table-column label="来源" width="80">
              <template #default="{ row }">{{ row.from === 'both' ? '两边' : row.from }}</template>
            </el-table-column>
            <el-table-column prop="part.sourceLot" label="来源批号" min-width="120" />
          </el-table>

          <h4>维修工序（{{ cp.steps.length }}）— 新增工序保留各自操作人与归并顺序</h4>
          <el-table :data="cp.steps" size="small" border :row-class-name="stepRowClass">
            <el-table-column label="新序号" width="80">
              <template #default="{ row }">#{{ row.step.seq }}</template>
            </el-table-column>
            <el-table-column label="原序号" width="80">
              <template #default="{ row }">{{ row.step.originSeq ?? row.step.seq }}</template>
            </el-table-column>
            <el-table-column prop="step.stepType" label="类型" width="90" />
            <el-table-column prop="step.operator" label="操作人" width="100" />
            <el-table-column label="来源" width="90">
              <template #default="{ row }">{{ row.from === 'both' ? '本机' : row.from + ' 包' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="150">
              <template #default="{ row }">
                <el-tag v-if="row.invalidated" type="danger" size="small">已失效·待重做</el-tag>
                <el-tag v-else size="small">{{ row.step.state === 'done' ? '已完成' : '待办' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="失效原因" min-width="220">
              <template #default="{ row }">{{ row.step.invalidReason || '—' }}</template>
            </el-table-column>
          </el-table>

          <h4>走时测试（{{ cp.tests.length }}）</h4>
          <el-table :data="cp.tests" size="small" border>
            <el-table-column label="时间" min-width="170">
              <template #default="{ row }">{{ new Date(row.testedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column prop="rate" label="日差" width="90" />
            <el-table-column prop="amplitude" label="摆幅" width="90" />
            <el-table-column prop="conclusion" label="结论" min-width="120" />
            <el-table-column prop="sourceTag" label="来源" min-width="120" />
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 4. 待重试 / 失败暂存 -->
    <el-card v-if="mergeStore.pendingSessions.length" shadow="never">
      <template #header>
        <div class="card-head">
          <strong>待处理的合并（两边的包已保留）</strong>
          <el-tag type="warning">{{ mergeStore.pendingSessions.length }} 组</el-tag>
        </div>
      </template>
      <el-table :data="mergeStore.pendingSessions" size="small" border>
        <el-table-column label="A 包 / B 包" min-width="240">
          <template #default="{ row }">
            <div>{{ row.storedA.sourceTag }}：{{ row.storedA.fileName }}</div>
            <div>{{ row.storedB.sourceTag }}：{{ row.storedB.fileName }}</div>
          </template>
        </el-table-column>
        <el-table-column label="藏品号" min-width="180">
          <template #default="{ row }">{{ row.plan.clockNos.join('、') }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.plan.blocked ? 'danger' : 'warning'" size="small">
              {{ row.plan.blocked ? '有阻断' : row.storedA.lastError ? '写入失败' : '待确认' }}
            </el-tag>
            <div class="attempts">已尝试 {{ row.storedA.attempts }} 次</div>
          </template>
        </el-table-column>
        <el-table-column label="最近失败原因" min-width="220">
          <template #default="{ row }">{{ row.storedA.lastError || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="180">
          <template #default="{ row }">
            <el-button size="small" type="primary" :loading="committing" @click="retrySession(row.sessionId)">
              重试
            </el-button>
            <el-button size="small" @click="discardSession(row.sessionId)">丢弃</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.pickers {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  flex-wrap: wrap;
}
.picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.picker-title {
  font-weight: 600;
}
.picker-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 320px;
}
.fname {
  font-size: 12px;
  color: #7b8592;
  word-break: break-all;
}
.confirm-bar {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 16px;
}
.tab-block {
  color: #d93025;
  font-weight: 700;
}
.missing {
  margin-bottom: 10px;
  color: #d93025;
}
h4 {
  margin: 16px 0 8px;
}
.attempts {
  font-size: 12px;
  color: #7b8592;
}
:deep(.invalid-row) {
  background: #fef0f0;
}
</style>
