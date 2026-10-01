<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useMergeStore } from '../stores/mergeStore';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import { useStepStore } from '../stores/stepStore';
import type { ArchivePackage } from '../utils/merge';

const router = useRouter();
const mergeStore = useMergeStore();
const clockStore = useClockStore();
const partStore = usePartStore();
const stepStore = useStepStore();

const exportForm = reactive({
  deviceName: '一号修复台',
  operator: '',
});

const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);

const hasResult = computed(() => !!mergeStore.result);
const hasErrors = computed(() => mergeStore.hasErrors);
const hasWarnings = computed(() => mergeStore.hasWarnings);

async function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  if (files.length === 0) return;
  importing.value = true;
  try {
    await mergeStore.importFiles(files);
  } finally {
    importing.value = false;
    // 允许重复选择同一文件
    if (fileInput.value) fileInput.value.value = '';
  }
}

function triggerPick() {
  fileInput.value?.click();
}

async function exportCurrent() {
  if (!exportForm.deviceName.trim()) {
    ElMessage.warning('请填写设备名称');
    return;
  }
  const operator = exportForm.operator.trim() || '未填';
  await mergeStore.exportCurrent({
    deviceId: `dev_${exportForm.deviceName.trim()}`,
    deviceName: exportForm.deviceName.trim(),
    operator,
    exportedAt: Date.now(),
  });
  ElMessage.success('档案包已导出');
}

async function confirmWrite() {
  const ok = await mergeStore.confirmWrite();
  if (ok) {
    ElMessage.success('合并完成，档案已写入');
    // 重新载入各 store，使台账/详情反映合并后的数据
    await Promise.all([clockStore.load(), partStore.load(), stepStore.load()]);
    mergeStore.discardStash();
    router.push('/clocks');
  } else {
    ElMessage.error('写入失败，已保留两边的包，可重试');
  }
}

async function retryWrite() {
  const ok = await mergeStore.retry();
  if (ok) {
    ElMessage.success('重试成功，档案已写入');
    await Promise.all([clockStore.load(), partStore.load(), stepStore.load()]);
    mergeStore.discardStash();
    router.push('/clocks');
  } else {
    ElMessage.error('重试仍失败，请检查浏览器存储后再试');
  }
}

function discardStash() {
  mergeStore.discardStash();
  ElMessage.info('已放弃未完成的合并');
}

function pkgLabel(pkg: ArchivePackage, i: number): string {
  return pkg.source?.deviceName || `档案包 ${i + 1}（无来源标记）`;
}

onMounted(() => {
  mergeStore.checkStashOnStartup();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>档案合并</h2>
      <el-tag type="info" effect="plain">两台平板离线回店合并</el-tag>
      <div class="spacer" />
      <el-button @click="router.push('/clocks')">返回台账</el-button>
    </div>

    <el-alert
      v-if="mergeStore.loadedFromStash && mergeStore.stash"
      type="warning"
      show-icon
      :closable="false"
      title="检测到上次未完成的合并"
      description="写入过程中发生中断，两边的档案包已保留。可继续重试写入，或放弃本次合并。"
      style="margin-bottom: 12px"
    >
      <div style="margin-top: 8px">
        <el-button type="primary" size="small" :loading="mergeStore.writing" @click="retryWrite">继续重试</el-button>
        <el-button size="small" @click="discardStash">放弃</el-button>
      </div>
    </el-alert>

    <el-alert
      type="info"
      show-icon
      :closable="false"
      title="合并规则"
      description="同一台钟按藏品号（clockNo）认领；两边新增的工序保留各自操作人与顺序，重排为连续顺序号；零件处理决定变更后，关联维修工序失效并按合并后数据重算。缺钟表、缺零件或旧档案没有来源标记时先列清差异，确认前不动原档。"
      style="margin-bottom: 12px"
    />

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>导出当前档案包</strong></template>
        <el-form label-width="90px">
          <el-form-item label="设备名称">
            <el-input v-model="exportForm.deviceName" placeholder="如 一号修复台" />
          </el-form-item>
          <el-form-item label="操作人">
            <el-input v-model="exportForm.operator" placeholder="选填，随档案包标记" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="exportCurrent">导出档案包（JSON）</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><strong>导入离线档案包</strong></template>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          multiple
          style="display: none"
          @change="onPickFiles"
        />
        <el-button type="primary" plain :loading="importing" @click="triggerPick">选择档案包文件（可多选）</el-button>
        <div v-if="mergeStore.packages.length" class="pkg-list">
          <div v-for="(pkg, i) in mergeStore.packages" :key="i" class="pkg-item">
            <el-tag size="small" :type="pkg.source ? 'success' : 'warning'">
              {{ pkg.source ? '有来源标记' : '无来源标记' }}
            </el-tag>
            <strong>{{ pkgLabel(pkg, i) }}</strong>
            <span class="muted">
              （{{ pkg.source?.operator || '未填操作人' }} ·
              {{ pkg.source ? new Date(pkg.source.exportedAt).toLocaleString('zh-CN') : '时间未知' }}）
            </span>
            <span class="muted">
              · 钟表 {{ pkg.clocks.length }} · 零件 {{ pkg.parts.length }} · 工序 {{ pkg.steps.length }} · 走时
              {{ pkg.tests.length }}
            </span>
          </div>
        </div>
        <el-empty v-else description="尚未选择档案包文件" :image-size="50" />
      </el-card>
    </div>

    <el-card v-if="hasResult" shadow="never" style="margin-top: 14px">
      <template #header>
        <div class="card-head">
          <strong>合并预览</strong>
          <el-tag size="small" type="info">共 {{ mergeStore.totalRecords }} 条记录</el-tag>
          <el-tag v-if="hasErrors" size="small" type="danger">差异 {{ mergeStore.report?.errors.length }} 项（需处理）</el-tag>
          <el-tag v-else-if="hasWarnings" size="small" type="warning">提醒 {{ mergeStore.report?.warnings.length }} 项</el-tag>
          <el-tag v-else size="small" type="success">无差异，可写入</el-tag>
        </div>
      </template>

      <div class="counts">
        <el-tag type="success">新增钟表 {{ mergeStore.report?.counts.clocksAdded }}</el-tag>
        <el-tag type="primary">认领钟表 {{ mergeStore.report?.counts.clocksClaimed }}</el-tag>
        <el-tag type="success">新增零件 {{ mergeStore.report?.counts.partsAdded }}</el-tag>
        <el-tag type="warning">处理决定变更 {{ mergeStore.report?.counts.decisionsChanged }}</el-tag>
        <el-tag type="success">新增工序 {{ mergeStore.report?.counts.stepsAdded }}</el-tag>
        <el-tag type="danger">工序失效 {{ mergeStore.report?.counts.stepsInvalidated }}</el-tag>
        <el-tag type="success">新增走时 {{ mergeStore.report?.counts.testsAdded }}</el-tag>
      </div>

      <el-alert
        v-if="hasErrors"
        type="error"
        show-icon
        :closable="false"
        title="存在缺失项，暂不能写入"
        description="请补全档案包后重新导入；确认前不会改动原档。"
        style="margin: 10px 0"
      />

      <el-tabs>
        <el-tab-pane :label="`差异与提醒（${mergeStore.report?.issues.length ?? 0}）`">
          <el-empty v-if="!hasErrors && !hasWarnings" description="无差异" :image-size="50" />
          <div v-else class="issue-list">
            <div
              v-for="(issue, i) in mergeStore.report?.issues"
              :key="i"
              class="issue-item"
              :class="issue.severity"
            >
              <el-tag size="small" :type="issue.severity === 'error' ? 'danger' : 'warning'">
                {{ issue.severity === 'error' ? '错误' : '提醒' }}
              </el-tag>
              <span>{{ issue.message }}</span>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane :label="`合并变更（${mergeStore.report?.changes.length ?? 0}）`">
          <el-empty v-if="mergeStore.report?.changes.length === 0" description="无变更" :image-size="50" />
          <div v-else class="change-list">
            <div v-for="(change, i) in mergeStore.report?.changes" :key="i" class="change-item">
              <el-tag size="small" effect="plain">{{ change.kind }}</el-tag>
              <span>{{ change.message }}</span>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>

      <div class="write-row">
        <el-button
          type="primary"
          :loading="mergeStore.writing"
          :disabled="hasErrors"
          @click="confirmWrite"
        >
          确认写入合并结果
        </el-button>
        <el-button v-if="mergeStore.writeError" type="warning" :loading="mergeStore.writing" @click="retryWrite">
          重试写入
        </el-button>
        <span v-if="mergeStore.writeError" class="muted error-text">写入失败：{{ mergeStore.writeError }}（两边的包已保留，可重试）</span>
      </div>
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
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: start;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.pkg-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pkg-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  background: #fafafa;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}
.issue-list,
.change-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 360px;
  overflow-y: auto;
}
.issue-item,
.change-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
}
.issue-item.error {
  background: #fef0f0;
  color: #c45656;
}
.issue-item.warning {
  background: #fdf6ec;
  color: #b88230;
}
.change-item {
  background: #f4f6f8;
  color: #4a5461;
}
.write-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.error-text {
  color: #c45656;
}
</style>
