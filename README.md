# 🎓 socraticai.study — Socratic AI Study Companion

Ứng dụng web hỗ trợ sinh viên học tập chủ động: hỏi đáp Socratic bám sát tài liệu, tạo Quiz trắc nghiệm thích ứng độ khó, ôn tập giãn cách (Leitner), tự động xếp lịch tự học và đồng bộ tiến độ trên đám mây.

## 1. Cấu trúc dự án
- `app.py`: Backend FastAPI (API Gemini, đọc PDF/DOCX/PPTX/TXT, thuật toán xếp lịch Heuristic, tạo/chấm Quiz, kết nối Supabase).
- `index.html`: Giao diện đa trang.
- `app.js`: Logic giao diện chính, chống XSS (`DOMPurify`), lưu tạm `localStorage`, Pomodoro, tài khoản Supabase.
- `progress.js`: Hệ thống điểm XP, chuỗi ngày học, hàng đợi ôn tập Leitner (1 → 3 → 7 → 14 ngày) và đồng bộ Cloud.
- `quiz.js`: Luồng làm Quiz, dự đoán điểm, điều chỉnh cấp độ 1–5 và màn hình **Hôm nay**.
- `week.js`: Lịch tuần dạng lưới hiển thị song song lịch học trên trường và buổi tự học.
- `test_scheduler.py`: Bộ kiểm thử tự động (`pytest`) cho thuật toán xếp lịch.
- `requirements.txt` & `render.yaml`: Cấu hình triển khai lên Render.

## 2. Thiết lập cơ sở dữ liệu (Supabase)
Trong **Supabase → SQL Editor**, chạy lần lượt:
1. File SQL gốc tạo bảng `timetable_entries`, `tasks` và hàm `save_my_data`, `delete_my_account`.
2. File `supabase_progress.sql` tạo bảng `learning_progress` và hàm `save_my_progress`.

## 3. Chạy trên máy cục bộ (Local)

    pip install -r requirements.txt
    export GEMINI_API_KEY="your_key"
    export SUPABASE_URL="https://xxxx.supabase.co"
    export SUPABASE_KEY="your_publishable_key"
    uvicorn app:app --reload --port 8501

Chạy kiểm thử thuật toán xếp lịch:

    pytest -v test_scheduler.py

## 4. Triển khai ổn định trên Render
1. Đẩy toàn bộ các file đã đóng gói lên một repository GitHub.
2. Vào Render → **New +** → **Blueprint** (hoặc **Web Service**) và chọn repo GitHub.
3. Nhập 3 biến môi trường: `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`.
4. Bấm **Deploy** để nhận đường dẫn cố định 24/7.

## 5. Đợt dùng thử (5–10 sinh viên)
- **Mục tiêu:** Kiểm tra độ ổn định thực tế trước khi thuyết trình.
- **Kịch bản test:**
  1. Đăng ký/Đăng nhập tài khoản mới.
  2. Tải 1 slide bài giảng (`.pdf`/`.pptx`), hỏi Socratic AI 2 câu, sau đó làm 1 bộ Quiz 5 câu.
  3. Nhập thử 2 môn học và 2 deadline, chạy **AI Scheduler** rồi mở trang **Lịch tuần**.
  4. Tải lại trang (F5) để kiểm tra dữ liệu không bị mất.
- **Ghi nhận phản hồi:** Lỗi phát sinh, tốc độ tạo Quiz, mức độ dễ hiểu của giao diện và đề xuất cải thiện.