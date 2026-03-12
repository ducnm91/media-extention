<script lang="ts" setup>
import { onMounted, ref } from 'vue';

const maxTabs = ref<number | null>(null);
const segmentConcurrency = ref<number | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);

async function loadConfig() {
  try {
    loading.value = true;
    error.value = null;
    const stored = await browser.storage.sync.get([
      'maxParallelDownloadTabs',
      'segmentFetchConcurrency',
    ]);
    maxTabs.value =
      typeof stored.maxParallelDownloadTabs === 'number'
        ? stored.maxParallelDownloadTabs
        : 4;
    segmentConcurrency.value =
      typeof stored.segmentFetchConcurrency === 'number'
        ? stored.segmentFetchConcurrency
        : 8;
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : 'Không thể tải cấu hình hiện tại.';
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  if (maxTabs.value == null || segmentConcurrency.value == null) return;
  const mt = Math.max(1, Math.min(20, Math.floor(maxTabs.value)));
  const sc = Math.max(1, Math.min(64, Math.floor(segmentConcurrency.value)));
  try {
    saving.value = true;
    error.value = null;
    await browser.storage.sync.set({
      maxParallelDownloadTabs: mt,
      segmentFetchConcurrency: sc,
    });
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : 'Không thể lưu cấu hình. Thử lại.';
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  loadConfig();
});
</script>

<template>
  <div class="popup-root">
    <h1 class="title">HLS Downloader</h1>
    <p class="subtitle">Cấu hình tải song song</p>

    <div v-if="loading" class="section muted">Đang tải cấu hình...</div>

    <div v-else class="section">
      <label class="field">
        <div class="field-label">
          Số tab tải tối đa
          <span class="hint">(1–20)</span>
        </div>
        <input
          v-model.number="maxTabs"
          type="number"
          min="1"
          max="20"
          class="input"
        />
      </label>

      <label class="field">
        <div class="field-label">
          Số segment chạy song song
          <span class="hint">(1–64)</span>
        </div>
        <input
          v-model.number="segmentConcurrency"
          type="number"
          min="1"
          max="64"
          class="input"
        />
      </label>

      <button
        type="button"
        class="save-btn"
        :disabled="saving || maxTabs == null || segmentConcurrency == null"
        @click="saveConfig"
      >
        {{ saving ? 'Đang lưu...' : 'Lưu cấu hình' }}
      </button>

      <p v-if="error" class="error">
        {{ error }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.popup-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 260px;
  max-width: 320px;
}

.title {
  font-size: 18px;
  margin: 0;
}

.subtitle {
  margin: 0;
  font-size: 12px;
  opacity: 0.8;
}

.section {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.muted {
  font-size: 13px;
  opacity: 0.8;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
}

.field-label {
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.hint {
  font-size: 11px;
  opacity: 0.7;
}

.input {
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  padding: 4px 8px;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.1);
  color: inherit;
}

.input:focus {
  outline: none;
  border-color: #4c8dff;
}

.save-btn {
  margin-top: 6px;
  width: 100%;
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.5em 1em;
  font-size: 0.9em;
  font-weight: 500;
  background: linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%);
  color: #fff;
  cursor: pointer;
}

.save-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.error {
  margin: 0;
  margin-top: 4px;
  font-size: 11px;
  color: #ff8a80;
}
</style>
