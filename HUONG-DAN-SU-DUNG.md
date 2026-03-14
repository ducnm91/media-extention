# Hướng dẫn sử dụng extension HLS Downloader

Extension giúp tải video HLS (stream M3U8) từ các trang web, lưu thành file MP4 vào thư mục trong project, và quét/tải hàng loạt từ trang danh sách video (ví dụ xvideos).

---

## 1. Yêu cầu

- **Node.js** (để chạy server tải và build extension).
- **FFmpeg** (phần mềm trên máy, không phải thư viện npm) — dùng để ghép file .ts (segment) thành MP4. Cài trên máy:
  - **macOS:** `brew install ffmpeg`
  - **Windows:** tải từ [ffmpeg.org](https://ffmpeg.org/download.html) hoặc `winget install ffmpeg`, đảm bảo `ffmpeg` có trong PATH.
  - **Linux:** `sudo apt install ffmpeg` (Ubuntu/Debian) hoặc tương đương.
- **Trình duyệt** hỗ trợ extension (Chrome, Edge, Firefox với build tương ứng).

*Không cần cài thêm thư viện npm nào cho việc ghép video — server chỉ gọi lệnh `ffmpeg` có sẵn trên hệ thống.*

---

## 2. Cài đặt & chạy

### Build extension

```bash
npm install
npm run build
```

Với Chrome/Edge: mở `chrome://extensions` → **Developer mode** → **Load unpacked** → chọn thư mục `dist` (sau khi build) hoặc dùng `npm run dev` để development.

### Chạy server tải video (bắt buộc để lưu MP4 & metadata)

```bash
npm run download-server
```

Giữ terminal này chạy. Server lắng nghe tại **http://127.0.0.1:8765**. Nếu không chạy server:

- Extension vẫn tải được video nhưng **không lưu MP4** vào project (chỉ tải file .ts về thư mục Download của trình duyệt).
- Tính năng **Quét và tải hàng loạt** và **lọc video đã tải / cập nhật metadata** sẽ không hoạt động đúng (hoặc dùng toàn bộ link quét được, không bỏ qua đã tải).

---

## 3. Giao diện extension

### 3.1. Popup (bấm vào icon extension)

- **Hàng đợi: X video** — Số video đang chờ trong hàng đợi batch (cập nhật liên tục khi popup mở).
- **Số tab tải tối đa (1–20)** — Số tab được mở đồng thời khi tải hàng loạt. Mặc định: 4.
- **Số segment chạy song song (1–64)** — Số request segment đồng thời mỗi video. Mặc định: 8.
- **Delay tự trigger (giây) (1–60)** — Sau khi mở tab video, chờ bao nhiêu giây rồi mới tự bắt đầu tải. Mặc định: 5.
- **Lưu cấu hình** — Lưu các giá trị trên (đồng bộ qua tài khoản trình duyệt).

---

### 3.2. Nút trên trang web (góc phải dưới)

Extension inject ba nút lên các trang (tùy site có thể chỉ dùng được một số tính năng):

| Nút | Chức năng |
|-----|-----------|
| **⬇ Download HLS** | Tải video HLS của trang hiện tại. Extension tự bắt URL M3U8 (từ request hoặc trang). Nếu không bắt được, có thể dán URL M3U8 thủ công. |
| **🔍 Kiểm tra M3U8** | Kiểm tra URL M3U8 (độ dài, số stream, lỗi…) và hiển thị báo cáo (dùng để debug). |
| **📋 Quét và tải hàng loạt** | Chỉ có ý nghĩa trên **trang danh sách** (category, search…). Quét toàn bộ link video trên trang, gửi lên server lọc, rồi đưa vào hàng đợi để mở tab và tự tải từng video. |

---

## 4. Tải một video (trang video)

1. Mở **trang có phát video** (URL M3U8 được load khi xem).
2. Bấm **⬇ Download HLS**.
3. Extension sẽ:
   - Lấy URL M3U8 (đã bắt từ request hoặc tìm trên trang).
   - Tải các segment, gửi lên server (nếu server đang chạy).
   - Server gộp segment → MP4, lưu vào `download/` và ghi thêm một dòng metadata vào `download/videos-metadata.jsonl`.
4. Nếu **server không chạy**: video vẫn tải nhưng lưu dưới dạng file .ts vào thư mục Download của trình duyệt.
5. Khi tải xong (lưu MP4 qua server): tab có thể **tự đóng** (tùy cấu hình đã implement).

---

## 5. Quét và tải hàng loạt

### Cách dùng

1. **Chạy server**: `npm run download-server`.
2. Mở **trang danh sách video** (ví dụ trang category hoặc search trên xvideos).
3. Bấm **📋 Quét và tải hàng loạt**.
4. Extension sẽ:
   - Quét tất cả link video trên trang (và lấy URL ảnh thumbnail từ thẻ `img` trong link).
   - Gửi danh sách URL lên server.
   - Server **lọc**:
     - URL **chưa có** trong `videos-metadata.jsonl` → đưa vào hàng đợi **tải mới**.
     - URL **đã có** nhưng thiếu **thumbnail** hoặc **views** → đưa vào hàng đợi **cập nhật metadata** (chỉ mở trang, lấy views + thumbnail, không tải lại video).
   - **Cộng dồn** với hàng đợi hiện tại (có thể quét nhiều trang rồi mới bắt đầu tải).
5. Tự mở lần lượt từng tab (tối đa theo **Số tab tải tối đa**), chờ **Delay tự trigger** giây rồi tự kích hoạt tải (hoặc cập nhật metadata).
6. Video tải xong (hoặc cập nhật xong) → tab tự đóng → chuyển sang video/URL tiếp theo trong hàng đợi.

### Lưu ý

- Có thể quét **nhiều trang** (mở 3 trang list, bấm nút trên từng trang): tất cả link sẽ **cộng dồn** vào một hàng đợi, trùng URL chỉ tính một lần.
- Số **Hàng đợi** trong popup cập nhật theo thời gian thực khi popup đang mở.
- So sánh “đã tải” / “cùng video” dựa trên **URL chuẩn hóa** (origin + pathname, bỏ query/hash).

---

## 6. File lưu & metadata

- **Video MP4**: lưu trong thư mục **`download/`** (có thể đổi bằng biến môi trường `DOWNLOAD_DIR` khi chạy server).
- **Ảnh thumbnail**: tải từ trang list và lưu trong **`download/thumbnails/`** (tên file theo id trong metadata).
- **Metadata**: **`download/videos-metadata.jsonl`** — mỗi dòng là một JSON:
  - `id`, `title`, `fileName`, `filePath`, `sourceUrl`, `actors`, `tags`, `thumbnailPath` (nếu có), `views` (nếu có).

Extension và server dùng `sourceUrl` (đã chuẩn hóa) để:
- Tránh tải trùng video đã có trong file.
- Quyết định có cần **cập nhật bổ sung** thumbnail/views cho bản ghi cũ hay không.

---

## 7. Xử lý lỗi

- **“Không tìm thấy link video trên trang này”** — Đang ở trang không phải trang danh sách (hoặc site chưa được hỗ trợ quét link). Mở đúng trang category/search rồi thử lại.
- **“Đã quét X link nhưng không có video mới”** — Tất cả link đã có trong metadata; không có gì được thêm vào hàng đợi tải.
- **Tab mở nhưng không tự tải** — Thường do player chưa kịp request M3U8. Extension có retry vài lần; có thể tăng **Delay tự trigger** trong popup (ví dụ 8–10 giây).
- **Lỗi “thiếu dữ liệu” (0/N segment)** — Stream/network lỗi hoặc server không nhận đủ segment. Tab batch sẽ tự đóng và chuyển sang video tiếp theo.
- **Server không phản hồi** — Kiểm tra đã chạy `npm run download-server` và không chặn localhost. Extension cần host permission tới `http://127.0.0.1:8765` (đã cấu hình trong project).

---

## 8. Site được hỗ trợ đặc biệt

- **xvideos.com**: Quét link video trên trang list, lấy thumbnail từ `img` trong thẻ `<a>`, lấy **views** và **actors/tags** trên trang video; chuẩn hóa title (bỏ " - XVIDEOS.COM"). Các site khác vẫn dùng được nút **Download HLS** nếu trang có stream M3U8.

---

## 9. Lệnh hữu ích

```bash
npm run dev              # Chạy extension ở chế độ development
npm run build            # Build extension (thư mục dist)
npm run download-server  # Chạy server tải video & metadata (port 8765)
```

Nếu cần re-encode MP4 sang H.264 + AAC (để tương thích máy/trình phát): chạy server với `FORCE_COMPATIBLE_MP4=1`.
