# Tài liệu flow & logic toàn bộ extension HLS Downloader

Tài liệu kỹ thuật mô tả luồng xử lý, message passing và state trong extension và server.

---

## 1. Kiến trúc tổng quan

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Trình duyệt                                                              │
│  ┌──────────────┐    ┌─────────────────────┐    ┌─────────────────────┐  │
│  │ Popup (Vue)  │    │ Background (SW)     │    │ Content Script      │  │
│  │ - Config     │───▶│ - Config CONFIG     │    │ - Nút Download/     │  │
│  │ - Số hàng đợi│    │ - lastM3u8ByTab     │◀──▶│   Kiểm tra/Batch    │  │
│  └──────────────┘    │ - batchQueue        │    │ - collectPageMeta   │  │
│                      │ - updateQueue       │    │ - runDownload...    │  │
│                      │ - webRequest (M3U8)  │    └─────────────────────┘  │
│                      │ - tabs.onUpdated     │              │               │
│                      │ - tabs.onRemoved     │              │               │
│                      └──────────┬───────────┘              │               │
│                                 │ fetch                    │ sendMessage   │
└─────────────────────────────────┼──────────────────────────┼──────────────┘
                                  ▼                          │
                    ┌─────────────────────────┐              │
                    │ Download Server (Node)   │              │
                    │ :8765                    │              │
                    │ - /filter-source-urls   │              │
                    │ - /update-metadata       │              │
                    │ - /segment, /finish      │              │
                    │ - /save                  │              │
                    │ - SEEN_SOURCE_URLS       │              │
                    │ - NEEDS_UPDATE_SOURCE_URLS               │
                    └─────────────────────────┘              │
                                                             │
                    Content script gửi message ──────────────┘
                    (DOWNLOAD_HLS, BATCH_QUEUE_URLS, UPDATE_METADATA, ...)
```

- **Popup**: Đọc/ghi config qua `browser.storage.sync`, gọi `GET_BATCH_QUEUE_COUNT` định kỳ.
- **Background**: Trung tâm: lưu M3U8 theo tab, xử lý hàng đợi batch/update, gọi server, gửi message xuống tab.
- **Content script**: Chạy trên mọi trang; inject nút, lắng nghe message từ background, gửi message lên background (DOWNLOAD_HLS, BATCH_QUEUE_URLS, UPDATE_METADATA, BATCH_DONE, ...).
- **Server**: Lọc URL, cập nhật metadata, nhận segment/finish/save để tạo MP4 và ghi jsonl.

---

## 2. Message types (Content Script ↔ Background)

| Message (Content → Background) | Ý nghĩa |
|---------------------------------|--------|
| `GET_LAST_M3U8` | Lấy URL M3U8 đã bắt cho tab hiện tại. |
| `GET_LAST_ERROR` | Lấy chuỗi lỗi gần nhất (sau DOWNLOAD_HLS false). |
| `GET_BATCH_QUEUE_COUNT` | Lấy `batchQueue.length` (popup dùng). |
| `INSPECT_M3U8` | Kiểm tra URL M3U8 (background fetch + parse), trả về báo cáo. |
| `BATCH_QUEUE_URLS` | Gửi `items: [{ url, thumbnailUrl? }]`; background gọi filter rồi đưa vào batchQueue + updateQueue. |
| `DOWNLOAD_HLS` | Bắt đầu tải: `url` (M3U8), `pageTitle`, `meta` (sourceUrl, actors, tags, views). |
| `BATCH_DONE` | Tab batch báo xong (thành công đóng tab từ background, hoặc lỗi từ content). Kèm `tabId` nếu có. |
| `UPDATE_METADATA` | Gửi `sourceUrl`, `views`, `tabId`; background gọi POST /update-metadata rồi đóng tab. |

| Message (Background → Content) | Ý nghĩa |
|--------------------------------|--------|
| `TRIGGER_DOWNLOAD` | Yêu cầu tab tự chạy runDownloadForBatch(); kèm `tabId`, `delayMs`. |
| `TRIGGER_UPDATE_METADATA` | Yêu cầu tab gửi UPDATE_METADATA (sourceUrl + views). |
| `HLS_SAVE_RESULT` | Báo đã lưu MP4 (success, mp4 filename). |
| `HLS_DOWNLOAD_PROGRESS` | Tiến độ tải segment (current/total). |
| `HLS_DOWNLOAD_START` | Bắt đầu nhận chunk: filename, totalChunks. |
| `HLS_DOWNLOAD_CHUNK` | Một chunk (buffer, index). |
| `HLS_DOWNLOAD_READY` | Đã gửi hết chunk; content ghép blob hoặc báo lỗi (và có thể gửi BATCH_DONE nếu isBatchTab). |

---

## 3. State chính

### 3.1. Background

| Biến | Ý nghĩa |
|------|--------|
| `lastM3u8ByTab` | Map tabId → URL M3U8 (cập nhật từ webRequest.onCompleted). |
| `CONFIG` | maxParallelDownloadTabs, segmentFetchConcurrency, autoTriggerDelaySec (từ storage.sync). |
| `activeDownloadTabs` | Set tabId đang tải (giới hạn theo CONFIG). |
| `activeDownloadTitles` | Set titleKey đang tải (tránh trùng title). |
| `batchQueue` | BatchItem[] (url, thumbnailUrl) chờ tải. |
| `batchTabIds` | Set tabId đang là tab batch. |
| `batchPendingTrigger` | Set tabId vừa load xong, chờ gửi TRIGGER_DOWNLOAD. |
| `batchTabIdToExtraMeta` | Map tabId → { thumbnailUrl } (gửi kèm khi save MP4). |
| `updateQueue` | BatchItem[] chờ cập nhật metadata. |
| `updateTabIds`, `updatePendingTrigger`, `updateTabIdToItem` | Tương tự batch nhưng cho luồng “chỉ cập nhật metadata”. |

### 3.2. Content script

| Biến | Ý nghĩa |
|------|--------|
| `downloadChunksByIndex`, `downloadFilename`, `downloadTotalChunks` | Ghép chunk khi fallback gửi .ts về tab. |
| `isBatchTab` | Tab được mở bởi batch (nhận TRIGGER_DOWNLOAD) → khi lỗi gửi BATCH_DONE. |
| `batchTabId` | tabId gửi kèm TRIGGER_DOWNLOAD, gửi lại trong BATCH_DONE. |

### 3.3. Server

| Biến | Ý nghĩa |
|------|--------|
| `SEEN_SOURCE_URLS` | Set URL đã chuẩn hóa (origin+pathname) có trong jsonl. |
| `NEEDS_UPDATE_SOURCE_URLS` | Set URL đã chuẩn hóa có record nhưng thiếu thumbnailPath hoặc views. |
| `normalizeSourceUrl(url)` | Chuẩn hóa URL → origin + pathname; dùng cho mọi so sánh. |

---

## 4. Flow: Tải một video (nút Download HLS)

1. User mở trang video, player request M3U8 → **webRequest.onCompleted** bắt URL → `lastM3u8ByTab.set(tabId, url)`.
2. User bấm **⬇ Download HLS** → content script:
   - Gọi `GET_LAST_M3U8` (hoặc `findStreamUrl()` nếu null).
   - Gọi `collectPageMetadata()` → sourceUrl, actors, tags, views.
   - Gửi **DOWNLOAD_HLS** với url, pageTitle, meta.
3. Background nhận DOWNLOAD_HLS:
   - Kiểm tra `activeDownloadTitles` (trùng title), `activeDownloadTabs.size` (vượt max).
   - Thêm tabId vào activeDownloadTabs, activeDownloadTitles; gọi `downloadHls(url, tabId, pageTitle)`.
4. **downloadHls**: fetch M3U8, parse playlist, fetch từng segment (song song theo CONFIG.segmentFetchConcurrency), gộp buffer.
5. Thử **trySaveSegmentsToServer** (POST /segment từng phần, rồi POST /finish với headers meta + X-Thumbnail-Url nếu có từ batchTabIdToExtraMeta).
6. Nếu finish thành công → gửi HLS_SAVE_RESULT xuống tab, **tabs.remove(tabId)** (nếu là flow lưu server), dọn activeDownloadTabs/activeDownloadTitles.
7. Nếu không dùng segment được → **trySaveToServer** (POST /save với buffer .ts + headers meta).
8. Nếu save cũng fail → **sendChunksToTab**: gửi HLS_DOWNLOAD_START, nhiều HLS_DOWNLOAD_CHUNK, HLS_DOWNLOAD_READY → content ghép blob và tải .ts xuống máy.
9. **finally**: luôn dọn activeDownloadTabs, activeDownloadTitles, batchTabIdToExtraMeta; notifyAllDownloadsDone nếu hết tab đang tải.

---

## 5. Flow: Quét và tải hàng loạt (batch)

### 5.1. Quét và lọc

1. User ở **trang danh sách** (vd. category xvideos), bấm **📋 Quét và tải hàng loạt**.
2. Content script: **collectVideoPageLinks()** → `[{ url, thumbnailUrl }, ...]` (url = origin+pathname, thumbnailUrl từ `img.src` trong `<a>`).
3. Gửi **BATCH_QUEUE_URLS** với `items`.
4. Background:
   - POST **/filter-source-urls** với `{ urls: items.map(i => i.url) }`.
   - Server: `normalizeSourceUrl` từng url; `filtered = urls không có trong SEEN_SOURCE_URLS`; `updateUrls = urls có trong NEEDS_UPDATE_SOURCE_URLS`.
   - Trả về `{ urls: filtered, updateUrls }`.
5. Background:
   - **toQueue** = filtered.map(url → { url, thumbnailUrl từ items }).
   - Merge vào **batchQueue** (chỉ thêm URL chưa có trong batchQueue).
   - **updateUrls** → merge vào **updateQueue** (chưa có thì thêm), gọi **processUpdateQueue()**.
   - Gọi **processBatchQueue()**.
   - Reply cho content: ok, total, queued, skipped, totalInQueue.

### 5.2. Mở tab và trigger tải (batch download)

1. **processBatchQueue()**: Trong khi `batchQueue.length > 0` và `batchTabIds.size < maxParallelDownloadTabs`:
   - shift một **item** (url, thumbnailUrl).
   - **tabs.create({ url: item.url })**.
   - Thêm tabId vào batchTabIds, batchPendingTrigger, batchTabIdToExtraMeta.set(tabId, { thumbnailUrl }).
2. **tabs.onUpdated**(tabId, status === "complete"):
   - Nếu tabId trong **batchPendingTrigger** → xóa khỏi batchPendingTrigger; sau **autoTriggerDelaySec** giây gửi **TRIGGER_DOWNLOAD** (kèm tabId) xuống tab.
3. Content script nhận **TRIGGER_DOWNLOAD**:
   - Set **isBatchTab = true**, **batchTabId = msg.tabId**.
   - Gọi **runDownloadForBatch()**: retry lấy M3U8 (GET_LAST_M3U8 + findStreamUrl) tối đa 5 lần, mỗi lần cách 3s; nếu có URL thì gửi **DOWNLOAD_HLS**.
4. Nếu DOWNLOAD_HLS thành công → flow giống mục 4; khi lưu MP4, background merge **thumbnailUrl** từ batchTabIdToExtraMeta vào meta và gửi X-Thumbnail-Url, X-Views lên server; sau đó **tabs.remove(tabId)**.
5. **tabs.onRemoved**(tabId): Nếu tabId trong batchTabIds → dọn batchTabIds, batchPendingTrigger, batchTabIdToExtraMeta → **processBatchQueue()** (mở tab tiếp).
6. Nếu runDownloadForBatch() thất bại → content gửi **BATCH_DONE** (tabId). Background: xóa tab khỏi batch, **tabs.remove(tabId)**, processBatchQueue().
7. Nếu lỗi “thiếu dữ liệu” (HLS_DOWNLOAD_READY nhưng chunk thiếu): content gửi **BATCH_DONE** (trước alert); background đóng tab và processBatchQueue().
8. Nếu downloadHls throw (catch): background cũng đóng tab batch và processBatchQueue().

### 5.3. Cập nhật metadata (update queue)

1. **processUpdateQueue()**: Lấy item từ updateQueue, **tabs.create({ url })**, đưa tabId vào updateTabIds, updatePendingTrigger, updateTabIdToItem.set(tabId, item).
2. **tabs.onUpdated**(tabId, complete) và tabId trong **updatePendingTrigger** → sau ~3s gửi **TRIGGER_UPDATE_METADATA** (tabId) xuống tab.
3. Content script: **collectPageMetadata()** → sourceUrl, views; gửi **UPDATE_METADATA** với sourceUrl, views, tabId.
4. Background: Lấy **thumbnailUrl** từ updateTabIdToItem.get(tabId); POST **/update-metadata** với sourceUrl, thumbnailUrl, views; sau đó **tabs.remove(tabId)**, dọn updateTabIds/updateTabIdToItem, **processUpdateQueue()**.

---

## 6. Flow: Server

### 6.1. Khởi động

- Đọc **videos-metadata.jsonl** (nếu có):
  - Mỗi dòng: parse JSON, `key = normalizeSourceUrl(obj.sourceUrl)`; `SEEN_SOURCE_URLS.add(key)`; nếu thiếu thumbnailPath hoặc views thì **NEEDS_UPDATE_SOURCE_URLS.add(key)**.

### 6.2. POST /filter-source-urls

- Body: `{ urls: string[] }`.
- `filtered = urls.filter(u => !SEEN_SOURCE_URLS.has(normalizeSourceUrl(u)))`.
- `updateUrls = urls.filter(u => NEEDS_UPDATE_SOURCE_URLS.has(normalizeSourceUrl(u)))`.
- Trả về `{ urls: filtered, updateUrls }`.

### 6.3. POST /update-metadata

- Body: `{ sourceUrl, thumbnailUrl?, views? }`.
- Đọc toàn bộ jsonl; tìm dòng có `normalizeSourceUrl(obj.sourceUrl) === normalizeSourceUrl(sourceUrl)`.
- Nếu có thumbnailUrl: tải ảnh về **thumbnails/<id>.jpg**, gán **thumbnailPath** (relative).
- Nếu có views: gán **views**.
- Ghi lại file; **NEEDS_UPDATE_SOURCE_URLS.delete(norm)**.

### 6.4. POST /segment + POST /finish

- Extension gửi từng segment lên /segment (X-Session-Id, X-Index, X-Total); sau đó POST /finish với headers meta (X-Source-Url, X-Page-Title, X-Actors, X-Tags, X-Thumbnail-Url, X-Views).
- Server: gộp segment bằng ffmpeg concat → MP4; nếu có X-Thumbnail-Url thì **downloadThumbnailToFile** → thumbnailPath; **appendMetadata** với id, title, filePath, sourceUrl, actors, tags, thumbnailPath?, views? (dùng normalizeSourceUrl khi kiểm tra trùng và add SEEN).

### 6.5. POST /save

- Body: buffer .ts; headers giống /finish.
- FFmpeg convert .ts → MP4; thumbnail + views tương tự; **appendMetadata**.

---

## 7. Chuẩn hóa URL

- **normalizeSourceUrl(url)** (server): `new URL(url).origin + new URL(url).pathname` (bỏ query, hash). Lỗi parse thì trả về chuỗi gốc.
- Dùng cho: SEEN_SOURCE_URLS, NEEDS_UPDATE_SOURCE_URLS, filter, update-metadata, appendMetadata (kiểm tra trùng và add key).
- Content script khi quét list đã dùng **origin + pathname** cho mỗi link; khi gửi UPDATE_METADATA dùng **window.location.href** (server vẫn normalize khi so sánh).

---

## 8. Popup

- **loadConfig**: storage.sync lấy maxParallelDownloadTabs, segmentFetchConcurrency, autoTriggerDelaySec → hiển thị và cho sửa.
- **saveConfig**: Ghi lại storage.sync (Background lắng storage.onChanged để cập nhật CONFIG).
- **fetchQueueCount**: Gửi GET_BATCH_QUEUE_COUNT → hiển thị "Hàng đợi: X video"; setInterval 1.5s khi popup mở, clear khi đóng.

---

*Tài liệu này mô tả đúng logic trong code tại thời điểm viết; khi sửa code nên cập nhật lại FLOW-LOGIC.md cho đồng bộ.*
