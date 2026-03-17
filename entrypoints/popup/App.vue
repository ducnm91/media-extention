<script lang="ts" setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';

const maxTabs = ref<number | null>(null);
const segmentConcurrency = ref<number | null>(null);
const autoTriggerDelaySec = ref<number | null>(null);
const minViews = ref<number | null>(1000000);
const maxViews = ref<number | null>(10_000_000_000);

type CategoryItem = { url: string; label: string; selected: boolean };
const categories = ref<CategoryItem[]>([]);

const queueCount = ref<number>(0);
const loading = ref(true);
const error = ref<string | null>(null);
const scanningCategories = ref(false);
const startingAutoscan = ref(false);
const batchPaused = ref(false);

let queuePollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchQueueCount() {
  try {
    const res = (await browser.runtime.sendMessage({
      type: 'GET_BATCH_QUEUE_COUNT',
    })) as { count?: number } | undefined;
    if (typeof res?.count === 'number') queueCount.value = res.count;
  } catch {
    // ignore
  }
}

async function loadConfig() {
  try {
    loading.value = true;
    error.value = null;
    const stored = await browser.storage.sync.get([
      'maxParallelDownloadTabs',
      'segmentFetchConcurrency',
      'autoTriggerDelaySec',
      'minViewsForAutoDownload',
      'maxViewsForAutoDownload',
      'autoscanCategories',
    ]);
    maxTabs.value =
      typeof stored.maxParallelDownloadTabs === 'number'
        ? stored.maxParallelDownloadTabs
        : 2;
    segmentConcurrency.value =
      typeof stored.segmentFetchConcurrency === 'number'
        ? stored.segmentFetchConcurrency
        : 8;
    autoTriggerDelaySec.value =
      typeof stored.autoTriggerDelaySec === 'number'
        ? stored.autoTriggerDelaySec
        : 5;
    minViews.value =
      typeof stored.minViewsForAutoDownload === 'number'
        ? stored.minViewsForAutoDownload
        : 1_000_000;
    maxViews.value =
      typeof stored.maxViewsForAutoDownload === 'number'
        ? stored.maxViewsForAutoDownload
        : 10_000_000_000;
    const storedCats = stored.autoscanCategories;
    if (Array.isArray(storedCats)) {
      categories.value = storedCats.map((c: any) => ({
        url: String(c.url || ''),
        label: String(c.label || ''),
        selected: !!c.selected,
      })).filter((c) => c.url && c.label);
    }
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : 'Không thể tải cấu hình hiện tại.';
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  if (
    maxTabs.value == null ||
    segmentConcurrency.value == null ||
    autoTriggerDelaySec.value == null ||
    minViews.value == null ||
    maxViews.value == null
  )
    return;
  const mt = Math.max(1, Math.min(20, Math.floor(maxTabs.value)));
  const sc = Math.max(1, Math.min(64, Math.floor(segmentConcurrency.value)));
  const delay = Math.max(1, Math.min(60, Math.floor(autoTriggerDelaySec.value)));
  const mv = Math.max(1000, Math.min(1_000_000_000, Math.floor(minViews.value)));
  const maxv = Math.max(
    mv + 1,
    Math.min(10_000_000_000, Math.floor(maxViews.value)),
  );
  try {
    error.value = null;
    await browser.storage.sync.set({
      maxParallelDownloadTabs: mt,
      segmentFetchConcurrency: sc,
      autoTriggerDelaySec: delay,
      minViewsForAutoDownload: mv,
      maxViewsForAutoDownload: maxv,
    });
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : 'Không thể lưu cấu hình. Thử lại.';
  }
}

async function scanCategoriesFromCurrentTab() {
  try {
    scanningCategories.value = true;
    error.value = null;
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!activeTab?.id) {
      error.value = 'Không tìm thấy tab hiện tại.';
      return;
    }
    const res = (await browser.runtime.sendMessage({
      type: 'SCAN_CATEGORIES_AT_INDEX',
      tabId: activeTab.id,
    })) as
      | {
          categories?: { url: string; label: string }[];
        }
      | undefined;
    const list = Array.isArray(res?.categories) ? res!.categories : [];
    categories.value = list.map((c) => ({
      ...c,
      // Mặc định bỏ chọn hết khi vừa quét danh sách chuyên mục
      selected: false,
    }));
    // auto lưu danh sách chuyên mục + trạng thái selected
    await browser.storage.sync.set({
      autoscanCategories: categories.value.map((c) => ({
        url: c.url,
        label: c.label,
        selected: c.selected,
      })),
    });
  } catch (e) {
    error.value =
      e instanceof Error
        ? e.message
        : 'Không thể quét danh sách chuyên mục. Mở đúng trang index rồi thử lại.';
  } finally {
    scanningCategories.value = false;
  }
}

async function startCategoryAutoscan() {
  if (!categories.value.length) return;
  const selected = categories.value.filter((c) => c.selected);
  if (!selected.length) {
    error.value = 'Hãy chọn ít nhất một chuyên mục.';
    return;
  }
  const mv = minViews.value ?? 1000000;
  const maxv = maxViews.value ?? 10_000_000_000;
  const minViewsClamped = Math.max(
    1000,
    Math.min(1_000_000_000, Math.floor(mv)),
  );
  const maxViewsClamped = Math.max(
    minViewsClamped + 1,
    Math.min(10_000_000_000, Math.floor(maxv)),
  );
  try {
    startingAutoscan.value = true;
    error.value = null;
    await browser.runtime.sendMessage({
      type: 'START_CATEGORY_AUTOSCAN',
      categories: selected.map((c) => c.url),
      minViews: minViewsClamped,
      maxViews: maxViewsClamped,
    });
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : 'Không thể bắt đầu autoscan chuyên mục.';
  } finally {
    startingAutoscan.value = false;
  }
}

async function pauseBatch() {
  try {
    await browser.runtime.sendMessage({ type: 'PAUSE_BATCH' });
    batchPaused.value = true;
  } catch {
    // ignore
  }
}

async function resumeBatch() {
  try {
    await browser.runtime.sendMessage({ type: 'RESUME_BATCH' });
    batchPaused.value = false;
  } catch {
    // ignore
  }
}

onMounted(() => {
  loadConfig();
  fetchQueueCount();
  queuePollTimer = setInterval(fetchQueueCount, 1500);

  // Auto-save cấu hình khi giá trị thay đổi
  watch(
    [maxTabs, segmentConcurrency, autoTriggerDelaySec, minViews, maxViews],
    () => {
      void saveConfig();
    },
  );

  // Auto-save trạng thái selected của chuyên mục
  watch(
    categories,
    async () => {
      try {
        await browser.storage.sync.set({
          autoscanCategories: categories.value.map((c) => ({
            url: c.url,
            label: c.label,
            selected: c.selected,
          })),
        });
      } catch {
        // ignore
      }
    },
    { deep: true },
  );
});

onUnmounted(() => {
  if (queuePollTimer) {
    clearInterval(queuePollTimer);
    queuePollTimer = null;
  }
});
</script>

<template>
  <div class="popup-root">
    <h1 class="title">HLS Downloader</h1>
    <p class="subtitle">Cấu hình tải song song</p>

    <div class="queue-row">
      <span class="queue-label">Hàng đợi:</span>
      <strong class="queue-value">{{ queueCount }} video</strong>
    </div>

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

      <label class="field">
        <div class="field-label">
          Delay tự trigger (giây)
          <span class="hint">(1–60, sau khi mở tab video)</span>
        </div>
        <input
          v-model.number="autoTriggerDelaySec"
          type="number"
          min="1"
          max="60"
          class="input"
        />
      </label>

      <label class="field">
        <div class="field-label">
          Min views để auto tải
          <span class="hint">(ví dụ 1000000)</span>
        </div>
        <input
          v-model.number="minViews"
          type="number"
          min="1000"
          class="input"
        />
      </label>

      <label class="field">
        <div class="field-label">
          Max views để auto tải
          <span class="hint">(ví dụ 100000000)</span>
        </div>
        <input
          v-model.number="maxViews"
          type="number"
          min="1000"
          class="input"
        />
      </label>

      <div class="section">
        <div class="field-label">Quét chuyên mục (xvideos)</div>
        <button
          type="button"
          class="save-btn"
          :disabled="scanningCategories"
          @click="scanCategoriesFromCurrentTab"
        >
          {{
            scanningCategories
              ? 'Đang quét chuyên mục...'
              : 'Lấy danh sách chuyên mục từ trang hiện tại'
          }}
        </button>

        <div v-if="categories.length" class="category-list">
          <label
            v-for="cat in categories"
            :key="cat.url"
            class="category-item"
          >
            <input type="checkbox" v-model="cat.selected" />
            <span class="category-label">{{ cat.label }}</span>
          </label>

          <button
            type="button"
            class="save-btn"
            :disabled="startingAutoscan"
            @click="startCategoryAutoscan"
          >
            {{
              startingAutoscan
                ? 'Đang bắt đầu autoscan...'
                : 'Bắt đầu scan & download'
            }}
          </button>
        </div>

        <div class="section">
          <div class="field-label">Điều khiển batch download</div>
          <button
            type="button"
            class="save-btn"
            :disabled="batchPaused"
            @click="pauseBatch"
          >
            Tạm dừng mở tab mới
          </button>
          <button
            type="button"
            class="save-btn"
            :disabled="!batchPaused"
            @click="resumeBatch"
          >
            Tiếp tục
          </button>
        </div>
      </div>

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

.queue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  font-size: 13px;
}

.queue-label {
  opacity: 0.9;
}

.queue-value {
  font-variant-numeric: tabular-nums;
}

.category-list {
  margin-top: 6px;
  max-height: 180px;
  overflow: auto;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.category-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.category-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
