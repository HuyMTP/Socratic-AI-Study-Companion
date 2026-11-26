import os, re, math, io, json, random, requests
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
from typing import List, Dict, Any
import pandas as pd
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel

# ============================================================
# 1. KHỞI TẠO BACKEND FASTAPI
# ============================================================
app = FastAPI(title="AI Student Assistant")

# ============================================================
# 2. CẤU HÌNH VÀ HẰNG SỐ
# ============================================================
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TZ = ZoneInfo("Asia/Ho_Chi_Minh")

MAX_DOC_CHARS = 400_000        # độ dài tối đa của phần tài liệu gửi cho AI
HISTORY_TURNS = 10             # số tin nhắn gần nhất gửi kèm cho AI
MAX_MESSAGES_IN = 60           # số tin nhắn tối đa chấp nhận từ trình duyệt
MAX_MESSAGE_CHARS = 8_000      # độ dài tối đa của một tin nhắn
MAX_FILES = 5                  # số file mỗi lần tải lên
MAX_FILE_MB = 20               # dung lượng tối đa mỗi file
ALLOWED_EXT = {".pdf", ".docx", ".pptx", ".txt"}

MODES = ["Giải thích khái niệm", "Tóm tắt tài liệu", "Tạo câu hỏi ôn tập"]
LEVELS = ["Dễ hiểu (như mới học lần đầu)", "Vừa phải", "Chuyên sâu"]

MODE_HINT = {
    MODES[0]: "Nhiệm vụ: giải thích khái niệm hoặc câu hỏi của người học. Cấu trúc gợi ý: định nghĩa ngắn → giải thích → ví dụ → lỗi thường gặp (nếu có).",
    MODES[1]: "Nhiệm vụ: tóm tắt tài liệu thành các ý chính có cấu trúc rõ ràng, ý quan trọng nhất đặt trước. Nếu người học nêu phạm vi cụ thể (chương, trang), chỉ tóm tắt phạm vi đó.",
    MODES[2]: "Nhiệm vụ: tạo 5 câu hỏi ôn tập trắc nghiệm (A-D) bám sát tài liệu, từ dễ đến khó. Chỉ liệt kê câu hỏi, KHÔNG nêu đáp án. Chỉ chấm và giải thích sau khi người học trả lời.",
}
LEVEL_HINT = {
    LEVELS[0]: "Giải thích thật dễ hiểu như cho người mới học lần đầu: ngôn ngữ đời thường, ví dụ gần gũi, giải thích thuật ngữ khi dùng.",
    LEVELS[1]: "Giải thích ở mức vừa phải: dùng thuật ngữ chính kèm định nghĩa ngắn và một ví dụ.",
    LEVELS[2]: "Giải thích chuyên sâu, chính xác: đi vào cơ chế, điều kiện áp dụng, chứng minh nếu phù hợp; giả định người học đã có kiến thức nền.",
}

PEDAGOGY_RULES = """
Bạn là gia sư hướng dẫn học tập.
Cần tuân theo phương pháp sư phạm giúp hỗ trợ việc ghi nhớ và thấu hiểu khái niệm.
Các quy tắc bạn cần tuân theo như sau:
1. Khi người dùng đưa ra câu hỏi về 1 khái niệm chung, hãy trả lời ngắn gọn, đúng trọng tâm rồi đặt ra câu hỏi ngược để kích thích người đọc suy nghĩ.
2. Khi người dùng nhờ giải quyết bài tập hộ, không đưa ra đáp án, phải đưa ra gợi ý liên quan rồi hướng dẫn người dùng giải quyết. Hãy tăng sự trợ giúp cho người đọc nếu họ liên tục gặp khó, bắt đầu từ (1) là đưa ra gợi ý, (2) là đưa ra ví dụ, (3) là đưa ra giải thích và chỉ tiết lộ đáp án đúng khi người dùng đưa ra 1 đáp án gần đúng hoặc hợp lý.
3. Khi người dùng trả lời sai, hãy hỏi cách họ suy nghĩ, để hiểu rằng họ đang gặp vấn đề gì: thiếu thông tin cần thiết, hiểu nhầm hoặc đang nhìn vấn đề sai cách.
4. Các câu trả lời đưa ra ngắn gọn, hợp lý, không giảng đạo, thân thiện với người dùng.
"""

DAY_NAMES = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"]
WINDOWS = {"Sáng": (6 * 60, 12 * 60), "Chiều": (12 * 60, 18 * 60), "Tối": (18 * 60, 22 * 60 + 30)}
MAX_SESSION, MIN_SESSION, BUFFER = 90, 30, 15

TIMETABLE_HEADERS = ["Môn học", "Thứ", "Giờ bắt đầu", "Giờ kết thúc", "Phòng"]
DEADLINE_HEADERS = ["Công việc", "Môn học", "Hạn (dd/mm)", "Số giờ ước tính"]
TT_KEYS = ["subject", "weekday", "start_time", "end_time", "room"]
TASK_KEYS = ["title", "subject", "due", "hours"]
MAX_TT_ROWS, MAX_TASKS, MIN_PASSWORD = 30, 50, 8     # phải khớp với file SQL

# ============================================================
# 3. GỌI AI (GEMINI)
# ============================================================
def _api_key():
    return os.environ.get("GEMINI_API_KEY", "").strip()

def _friendly_error(resp):
    try:
        detail = resp.json().get("error", {}).get("message", "")
    except Exception:
        detail = resp.text[:200]
    code = resp.status_code
    if code in (400, 401, 403):
        return f"⚠️ API key không hợp lệ hoặc chưa được cấp quyền ({code}). Chi tiết: {detail}"
    if code == 404:
        return f"⚠️ Không tìm thấy model `{GEMINI_MODEL}`. Hãy kiểm tra lại tên model. Chi tiết: {detail}"
    if code == 429:
        return "⚠️ Đã chạm giới hạn số lượt gọi AI. Đợi khoảng 1 phút rồi thử lại."
    if code >= 500:
        return "⚠️ Máy chủ Gemini đang quá tải hoặc gặp sự cố. Thử lại sau ít phút."
    return f"⚠️ Lỗi {code}: {detail}"

def call_gemini(system_prompt, messages, temperature=0.4, json_mode=False):
    """messages: [{"role": "user"|"assistant", "content": "..."}]. Lỗi trả về chuỗi bắt đầu bằng ⚠️.
    json_mode=True yêu cầu AI trả về JSON thuần (dùng cho quiz)."""
    if not _api_key():
        return "⚠️ Chưa cấu hình Gemini API Key."
    contents = [
        {"role": "user" if m["role"] == "user" else "model", "parts": [{"text": m["content"]}]}
        for m in messages
    ]
    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {"temperature": temperature},
    }
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"
    try:
        resp = requests.post(
            API_URL.format(model=GEMINI_MODEL),
            headers={"x-goog-api-key": _api_key(), "Content-Type": "application/json"},
            json=body, timeout=120,
        )
    except requests.RequestException as e:
        return f"⚠️ Không kết nối được tới Gemini: {e}"
    if resp.status_code != 200:
        return _friendly_error(resp)
    data = resp.json()
    try:
        parts = data["candidates"][0]["content"]["parts"]
        text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
        return text or "⚠️ AI không trả về nội dung. Hãy thử hỏi lại."
    except (KeyError, IndexError):
        reason = data.get("promptFeedback", {}).get("blockReason", "không rõ")
        return f"⚠️ AI không thể trả lời câu hỏi này (lý do: {reason}). Hãy thử diễn đạt lại."

def normalize_history(messages):
    """Làm sạch lịch sử chat để Gemini chấp nhận: bỏ tin rỗng, gộp tin liên tiếp cùng vai, bắt đầu bằng người dùng."""
    cleaned = []
    for m in messages[-HISTORY_TURNS:]:
        role = "user" if m.get("role") == "user" else "assistant"
        text = str(m.get("content", "")).strip()[:MAX_MESSAGE_CHARS]
        if not text:
            continue
        if cleaned and cleaned[-1]["role"] == role:
            cleaned[-1]["content"] += "\n\n" + text
        else:
            cleaned.append({"role": role, "content": text})
    while cleaned and cleaned[0]["role"] != "user":
        cleaned.pop(0)
    return cleaned

# ============================================================
# 4. ĐỌC TÀI LIỆU
# ============================================================
def read_uploaded_file(file_obj):
    """Trả về (văn bản, lỗi)."""
    name = file_obj.name
    ext = os.path.splitext(name)[1].lower()
    file_obj.seek(0)
    try:
        if ext == ".pdf":
            from pypdf import PdfReader
            pages = []
            for i, page in enumerate(PdfReader(file_obj).pages, 1):
                t = (page.extract_text() or "").strip()
                if t:
                    pages.append(f"[Trang {i}]\n{t}")
            return "\n\n".join(pages), ""
        elif ext == ".docx":
            import docx
            d = docx.Document(file_obj)
            lines = [p.text for p in d.paragraphs if p.text.strip()]
            for table in d.tables:
                for row in table.rows:
                    lines.append(" | ".join(c.text.strip() for c in row.cells))
            return "\n".join(lines), ""
        elif ext == ".pptx":
            from pptx import Presentation
            slides = []
            for i, slide in enumerate(Presentation(file_obj).slides, 1):
                texts = [sh.text_frame.text for sh in slide.shapes if sh.has_text_frame and sh.text_frame.text.strip()]
                if texts:
                    slides.append(f"[Slide {i}]\n" + "\n".join(texts))
            return "\n\n".join(slides), ""
        else:
            return file_obj.read().decode("utf-8", errors="ignore"), ""
    except Exception as e:
        return "", f"Không đọc được '{name}': {e}"

def extract_documents(files):
    """Trả về (danh sách {name, content}, danh sách cảnh báo). Mỗi file một mục để giao diện xóa từng file."""
    docs, notes, total = [], [], 0
    for f in files:
        text, err = read_uploaded_file(f)
        if err:
            notes.append(err)
            continue
        if not text.strip():
            notes.append(f"'{f.name}' không có lớp chữ số hóa (ảnh scan hoặc trống).")
            continue
        room = MAX_DOC_CHARS - total
        if room <= 0:
            notes.append(f"Bỏ qua '{f.name}' vì tổng dung lượng tài liệu vượt mức cho phép.")
            continue
        if len(text) > room:
            text = text[:room]
            notes.append(f"'{f.name}' quá dài, chỉ trích xuất phần đầu.")
        total += len(text)
        docs.append({"name": f.name, "content": f"=== TÀI LIỆU: {f.name} ===\n{text}"})
    return docs, notes

def build_system_prompt(mode, level, context):
    doc_part = ("--- TÀI LIỆU CỦA NGƯỜI HỌC ---\n" + context if context else "Người học chưa tải tài liệu nào.")
    return (
        "Bạn là trợ lý học tập cho sinh viên Việt Nam. Luôn trả lời bằng tiếng Việt "
        "(giữ thuật ngữ tiếng Anh khi cần, kèm giải thích).\n"
        f"{MODE_HINT[mode]}\n{LEVEL_HINT[level]}\n{PEDAGOGY_RULES}\n"
        "Quy tắc:\n"
        "- Khi có tài liệu: ưu tiên dựa vào tài liệu và ghi nguồn dạng (Trang N) hoặc (Slide N) nếu có.\n"
        "- Không bịa số liệu, trích dẫn hay công thức.\n"
        "- Trình bày ngắn gọn, dùng Markdown.\n\n"
        f"{doc_part}\nNhắc lại: luôn tuân theo phần PHƯƠNG PHÁP SƯ PHẠM ở trên."
    )

# ============================================================
# 5. THUẬT TOÁN HEURISTIC XẾP LỊCH
# ============================================================
def _s(x):
    return "" if x is None or (isinstance(x, float) and math.isnan(x)) else str(x).strip()

def clean_table(df, headers):
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=headers)
    keep = df.iloc[:, 0].map(_s) != ""
    return df[keep].reset_index(drop=True)

def to_df(rows, headers, max_rows):
    """Chuẩn hóa dữ liệu từ trình duyệt thành bảng đúng số cột, giới hạn số dòng và độ dài ô."""
    fixed = []
    for row in (rows or [])[:max_rows]:
        cells = [str(c)[:200] for c in list(row)[:len(headers)]]
        cells += [""] * (len(headers) - len(cells))
        fixed.append(cells)
    return pd.DataFrame(fixed, columns=headers)

def parse_weekday(s):
    s = _s(s).lower()
    if not s: return None
    if "cn" in s or "chủ" in s: return 6
    m = re.search(r"\d", s)
    return int(m.group()) - 2 if (m and 2 <= int(m.group()) <= 7) else None

def parse_time(s):
    m = re.match(r"^\s*(\d{1,2})\s*[:hH]\s*(\d{0,2})\s*$", _s(s))
    if not m: return None
    h, mi = int(m.group(1)), int(m.group(2) or 0)
    return h * 60 + mi if h < 24 and mi < 60 else None

def parse_due(s, today):
    m = re.match(r"^\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{2,4}))?\s*$", _s(s))
    if not m: return None
    d, mo = int(m.group(1)), int(m.group(2))
    y = int(m.group(3)) if m.group(3) else today.year
    if y < 100: y += 2000
    try:
        due = date(y, mo, d)
        if not m.group(3) and due < today and (today - due).days > 60:
            due = date(y + 1, mo, d)
        return due
    except ValueError:
        return None

def parse_hours(s):
    try:
        h = float(_s(s).replace(",", "."))
        return h if h > 0 else None
    except ValueError:
        return None

def free_blocks(day_classes, earliest):
    lo, hi = WINDOWS["Sáng"][0], WINDOWS["Tối"][1]
    cursor, free = max(lo, earliest), []
    for s, e in sorted((s - BUFFER, e + BUFFER) for s, e in day_classes):
        if s > cursor:
            free.append((cursor, min(s, hi)))
        cursor = max(cursor, e)
    if cursor < hi:
        free.append((cursor, hi))
    blocks = []
    for a, b in free:
        for name, (ws, we) in WINDOWS.items():
            s, e = max(a, ws), min(b, we)
            if e - s >= MIN_SESSION:
                blocks.append([s, e, name])
    return blocks

def take_time(blocks, minutes, preferred):
    blocks.sort(key=lambda b: (0 if b[2] == preferred else 1, b[0]))
    got = []
    for b in blocks:
        while minutes >= MIN_SESSION and b[1] - b[0] >= MIN_SESSION:
            length = min(MAX_SESSION, minutes, b[1] - b[0])
            got.append((b[0], b[0] + length))
            b[0] += length
            minutes -= length
        if minutes < MIN_SESSION:
            break
    return got

def build_schedule(timetable_df, deadlines_df, hours_per_day, preferred, now=None):
    now = now or datetime.now(TZ)
    today = now.date()
    problems, classes, tasks = [], {}, []

    for _, r in clean_table(timetable_df, ["Môn học"] * 5).iterrows():
        wd, s, e = parse_weekday(r.iloc[1]), parse_time(r.iloc[2]), parse_time(r.iloc[3])
        if wd is None or s is None or e is None or s >= e:
            problems.append(f"Bỏ qua TKB '{_s(r.iloc[0])}': thứ/giờ chưa hợp lệ.")
            continue
        classes.setdefault(wd, []).append((s, e))

    for _, r in clean_table(deadlines_df, ["Công việc"] * 4).iterrows():
        name, subject = _s(r.iloc[0]), _s(r.iloc[1])
        due, hrs = parse_due(r.iloc[2], today), parse_hours(r.iloc[3])
        if due is None or hrs is None or due < today:
            problems.append(f"Bỏ qua công việc '{name}': hạn chót hoặc số giờ không hợp lệ.")
        else:
            tasks.append({"name": name + (f" ({subject})" if subject else ""), "due": due, "left": int(math.ceil(hrs * 2)) * 30})

    if not tasks:
        return pd.DataFrame(columns=["Ngày", "Khung giờ", "Nội dung"]), problems

    last_day = min(max(t["due"] for t in tasks), today + timedelta(days=90))
    rows, d = [], today
    while d <= last_day and any(t["left"] > 0 for t in tasks):
        earliest = ((now.hour * 60 + now.minute + 30 + 29) // 30) * 30 if d == today else 0
        blocks = free_blocks(classes.get(d.weekday(), []), earliest)
        capacity = int(hours_per_day * 60)
        active = sorted((t for t in tasks if t["left"] > 0 and t["due"] >= d), key=lambda t: t["due"])
        for t in active:
            if capacity < MIN_SESSION:
                break
            days_left = max(1, (t["due"] - d).days)
            quota = int(math.ceil(t["left"] / days_left / 30)) * 30
            got = take_time(blocks, min(quota, t["left"], capacity), preferred)
            used = sum(e - s for s, e in got)
            t["left"] -= used
            capacity -= used
            rows += [(d, s, e, t["name"]) for s, e in got]
        d += timedelta(days=1)

    for t in tasks:
        if t["left"] > 0:
            problems.append(f"Chưa đủ thời gian cho '{t['name']}': thiếu {t['left']/60:g}h trước {t['due']:%d/%m}.")
    rows.sort()
    table = pd.DataFrame(
        [[f"{DAY_NAMES[d.weekday()]} {d:%d/%m}", f"{s//60:02d}:{s%60:02d}–{e//60:02d}:{e%60:02d}", name] for d, s, e, name in rows],
        columns=["Ngày", "Khung giờ", "Nội dung"]
    )
    return table, problems


# ============================================================
# 5b. QUIZ: tạo câu hỏi có cấu trúc, chọn phần tài liệu liên quan, độ khó thích ứng
# ============================================================
QUIZ_CONTEXT_CHARS = 60_000    # chỉ gửi phần tài liệu liên quan (nhanh và rẻ hơn gửi cả tài liệu)
QUIZ_DEFAULT_N = 5
MIN_LEVEL, MAX_LEVEL = 1, 5
UP_THRESHOLD, DOWN_THRESHOLD = 0.85, 0.60     # điểm xuất phát, cần chỉnh theo dữ liệu thử nghiệm

LEVEL_DESC = {
    1: "Nhớ: hỏi định nghĩa, thuật ngữ, thông tin nêu trực tiếp trong tài liệu.",
    2: "Hiểu: nhận ra ý nghĩa, phân biệt các khái niệm gần nhau.",
    3: "Áp dụng: tình huống hoặc ví dụ đơn giản cần dùng khái niệm để trả lời.",
    4: "Phân tích: so sánh, tìm nguyên nhân, điều kiện áp dụng; các lựa chọn sai phải hợp lý, dễ nhầm.",
    5: "Vận dụng cao: nhiều bước suy luận, kết hợp nhiều ý, có bẫy hiểu lầm phổ biến.",
}
STOPWORDS = {"và", "là", "của", "các", "một", "những", "trong", "cho", "với", "để", "có", "được", "khi", "này", "đó", "the", "and", "of"}
CHUNK_SPLIT = re.compile(r"(?=\[Trang \d+\]|\[Slide \d+\]|=== TÀI LIỆU:)")

def next_level(level, correct, total):
    """Độ khó thích ứng: đúng nhiều thì tăng, sai nhiều thì giảm. Trả về (cấp_mới, 'up'|'down'|'same')."""
    level = min(max(int(level), MIN_LEVEL), MAX_LEVEL)
    if total <= 0:
        return level, "same"
    accuracy = correct / total
    if accuracy >= UP_THRESHOLD and level < MAX_LEVEL:
        return level + 1, "up"
    if accuracy <= DOWN_THRESHOLD and level > MIN_LEVEL:
        return level - 1, "down"
    return level, "same"

def split_chunks(text, size=3000):
    """Cắt tài liệu thành các đoạn nhỏ, ưu tiên cắt theo nhãn [Trang N] / [Slide N].
    Trang dài hơn `size` được cắt tiếp, và mỗi đoạn con vẫn giữ nhãn trang để AI ghi đúng nguồn."""
    chunks = []
    for part in CHUNK_SPLIT.split(text):
        part = part.strip()
        if not part:
            continue
        if len(part) <= size:
            chunks.append(part)
            continue
        header = ""
        first, _, rest = part.partition("\n")
        if re.fullmatch(r"\[(?:Trang|Slide) \d+\]", first.strip()):
            header, part = first.strip() + "\n", rest
        pieces = []
        for line in re.split(r"\n+", part):          # dòng quá dài (không xuống dòng) bị cắt cứng
            pieces += [line[i:i + size] for i in range(0, len(line), size)] or [""]
        buf = ""
        for piece in pieces:
            if buf and len(buf) + len(piece) + 1 > size:
                chunks.append((header + buf).strip())
                buf = ""
            buf += piece + "\n"
        if buf.strip():
            chunks.append((header + buf).strip())
    return chunks

def select_relevant(context, topic, max_chars, rng=random):
    """Chọn phần tài liệu đưa cho AI. Có chủ đề: lấy các đoạn chứa nhiều từ khóa nhất.
    Không có chủ đề: lấy một cửa sổ liên tục ở vị trí ngẫu nhiên (để mỗi lần ra đề khác nhau)."""
    if len(context) <= max_chars:
        return context
    chunks = split_chunks(context)
    topic = (topic or "").strip().lower()
    keywords = {w for w in re.findall(r"\w+", topic) if len(w) >= 2 and w not in STOPWORDS}
    scores = []
    for i, c in enumerate(chunks):
        low = c.lower()
        score = sum(min(low.count(k), 5) for k in keywords) + (5 if topic and topic in low else 0)
        scores.append((score, i))
    chosen, total = [], 0
    if keywords and any(s > 0 for s, _ in scores):
        for score, i in sorted(scores, key=lambda x: (-x[0], x[1])):
            if score > 0 and total + len(chunks[i]) <= max_chars:
                chosen.append(i)
                total += len(chunks[i])
    else:
        start = rng.randrange(len(chunks))
        for i in range(start, len(chunks)):
            if total + len(chunks[i]) > max_chars:
                break
            chosen.append(i)
            total += len(chunks[i])
    if not chosen:
        return context[:max_chars]
    return "\n\n".join(chunks[i] for i in sorted(chosen))

def build_quiz_prompt(context, topic, level, n):
    focus = f"\nTập trung vào chủ đề: {topic}." if topic else ""
    return (
        "Bạn là người ra đề trắc nghiệm cho sinh viên Việt Nam. Chỉ dùng thông tin có trong TÀI LIỆU bên dưới.\n"
        f"Hãy tạo đúng {n} câu hỏi trắc nghiệm ở cấp độ {level}/5. {LEVEL_DESC[level]}{focus}\n"
        "Trả về DUY NHẤT một JSON hợp lệ (không dùng markdown, không thêm chữ nào khác) theo dạng:\n"
        '{"questions": [{"question": "...", "options": ["...", "...", "...", "..."], "answer_index": 0, '
        '"explanation": "...", "source": "Trang 3"}]}\n'
        "Quy tắc: mỗi câu có đúng 4 lựa chọn khác nhau và chỉ một đáp án đúng (answer_index từ 0 đến 3); "
        "các lựa chọn sai phải hợp lý; không dùng 'tất cả đều đúng' hoặc 'không đáp án nào đúng'; không lặp ý giữa các câu; "
        "explanation gồm 1 đến 3 câu giải thích vì sao đáp án đúng và vì sao dễ nhầm; "
        "source là trang hoặc slide chứa thông tin (ví dụ 'Trang 3' hoặc 'Slide 5'), để rỗng nếu không xác định được. "
        "Viết bằng tiếng Việt.\n\n"
        "--- TÀI LIỆU ---\n" + context
    )

def parse_quiz(text, n):
    """Đọc JSON từ AI, kiểm tra từng câu, xáo trộn thứ tự lựa chọn (tránh đáp án đúng luôn ở một vị trí)."""
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    try:
        data = json.loads(raw)
    except ValueError:
        s, e = raw.find("{"), raw.rfind("}")
        if s == -1 or e <= s:
            raise ValueError("phản hồi không phải JSON")
        data = json.loads(raw[s:e + 1])
    items = data.get("questions") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise ValueError("thiếu danh sách câu hỏi")
    good = []
    for q in items:
        try:
            question = str(q["question"]).strip()
            options = [str(o).strip() for o in q["options"]]
            idx = int(q["answer_index"])
            explanation = str(q.get("explanation", "")).strip()
            source = str(q.get("source", "")).strip()
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if not question or len(options) != 4 or any(not o for o in options) or len(set(options)) != 4 or not 0 <= idx <= 3:
            continue
        order = list(range(4))
        random.shuffle(order)
        good.append({"question": question, "options": [options[i] for i in order],
                     "answer_index": order.index(idx), "explanation": explanation, "source": source})
    if len(good) < 3:
        raise ValueError("không đủ câu hỏi hợp lệ")
    return good[:n]

def generate_quiz(context, topic, level, n):
    """Trả về (danh sách câu hỏi, lỗi). Thử lại một lần nếu AI trả về định dạng sai."""
    level = min(max(int(level), MIN_LEVEL), MAX_LEVEL)
    system = build_quiz_prompt(select_relevant(context, topic, QUIZ_CONTEXT_CHARS), topic, level, n)
    last_error = ""
    for _ in range(2):
        reply = call_gemini(system, [{"role": "user", "content": f"Hãy tạo {n} câu hỏi trắc nghiệm."}],
                            temperature=0.6, json_mode=True)
        if reply.startswith("⚠️"):
            return None, reply
        try:
            return parse_quiz(reply, n), ""
        except ValueError as e:
            last_error = str(e)
    return None, f"⚠️ AI trả về định dạng chưa hợp lệ ({last_error}). Hãy thử lại."

# ============================================================
# 6. TẦNG DỮ LIỆU SUPABASE
# ============================================================
SESSION_EXPIRED = "Phiên đăng nhập đã hết hạn, hãy đăng nhập lại."

def _url(): return os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
def _key(): return os.environ.get("SUPABASE_KEY", "").strip()
def _configured(): return bool(_url() and _key())

def _headers(token=None):
    h = {"apikey": _key(), "Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h

def _msg_from(resp):
    try:
        d = resp.json()
        return str(d.get("msg") or d.get("error_description") or d.get("message") or d.get("error") or "")
    except Exception:
        return resp.text[:200]

def _auth_error(resp):
    msg = _msg_from(resp)
    low = msg.lower()
    if resp.status_code == 429 or "rate limit" in low:
        return "Gửi quá nhiều yêu cầu, hãy thử lại sau ít phút."
    if "invalid login" in low:
        return "Email hoặc mật khẩu không đúng."
    if "not confirmed" in low:
        return "Bạn cần bấm liên kết xác nhận trong email trước khi đăng nhập."
    if "already" in low and "registered" in low:
        return "Email này đã được đăng ký."
    if "password" in low and ("short" in low or "least" in low or "weak" in low):
        return "Mật khẩu chưa đạt yêu cầu (quá ngắn hoặc quá yếu)."
    return f"Lỗi {resp.status_code}: {msg}"

def _data_error(resp):
    msg = _msg_from(resp)
    text = resp.text.lower()
    if resp.status_code == 401 or "jwt expired" in text:
        return SESSION_EXPIRED
    if "pgrst205" in text or "pgrst202" in text or "schema cache" in text:
        return "Chưa thiết lập cơ sở dữ liệu: hãy chạy file SQL trong Supabase (SQL Editor)."
    if resp.status_code == 400 and msg:
        return f"Không thực hiện được: {msg}"
    return f"Lỗi {resp.status_code}: {msg}"

def _check_credentials(email, password):
    if not _configured():
        return "Chưa cấu hình Supabase (SUPABASE_URL và SUPABASE_KEY)."
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", (email or "").strip()):
        return "Email không hợp lệ."
    if len(password or "") < MIN_PASSWORD:
        return f"Mật khẩu cần ít nhất {MIN_PASSWORD} ký tự."
    return ""

def sb_sign_up(email, password):
    err = _check_credentials(email, password)
    if err:
        return False, err
    try:
        r = requests.post(f"{_url()}/auth/v1/signup", headers=_headers(),
                          json={"email": email.strip(), "password": password}, timeout=30)
    except requests.RequestException as e:
        return False, f"Không kết nối được tới Supabase: {e}"
    if r.status_code not in (200, 201):
        return False, _auth_error(r)
    if r.json().get("access_token"):
        return True, "Đăng ký thành công! Hãy chuyển sang Đăng nhập."
    return True, "Đăng ký thành công! Hãy kiểm tra email để xác nhận, rồi chuyển sang Đăng nhập."

def sb_sign_in(email, password):
    err = _check_credentials(email, password)
    if err:
        return False, err, None
    try:
        r = requests.post(f"{_url()}/auth/v1/token", params={"grant_type": "password"}, headers=_headers(),
                          json={"email": email.strip(), "password": password}, timeout=30)
    except requests.RequestException as e:
        return False, f"Không kết nối được tới Supabase: {e}", None
    if r.status_code != 200:
        return False, _auth_error(r), None
    d = r.json()
    session = {"access_token": d["access_token"], "refresh_token": d.get("refresh_token", ""),
               "user_id": d["user"]["id"], "email": d["user"].get("email", email.strip())}
    return True, "Đăng nhập thành công!", session

def sb_refresh(session):
    """Đổi refresh_token lấy phiên mới. Trả về phiên mới hoặc None nếu không gia hạn được."""
    token = session.get("refresh_token")
    if not token:
        return None
    try:
        r = requests.post(f"{_url()}/auth/v1/token", params={"grant_type": "refresh_token"},
                          headers=_headers(), json={"refresh_token": token}, timeout=30)
    except requests.RequestException:
        return None
    if r.status_code != 200:
        return None
    d = r.json()
    return {"access_token": d["access_token"], "refresh_token": d.get("refresh_token", token),
            "user_id": d["user"]["id"], "email": d["user"].get("email", session.get("email", ""))}

def _supabase_request(session, method, path, **kwargs):
    """Gọi Supabase kèm token. Nếu token hết hạn (401) thì gia hạn một lần rồi gọi lại.
    Trả về (phản hồi, phiên_mới_nếu_vừa_gia_hạn)."""
    refreshed = None
    for attempt in range(2):
        resp = requests.request(method, f"{_url()}{path}", headers=_headers(session["access_token"]),
                                timeout=30, **kwargs)
        if resp.status_code != 401 or attempt == 1:
            return resp, refreshed
        refreshed = sb_refresh(session)
        if not refreshed:
            return resp, None
        session = refreshed
    return resp, refreshed

def sb_load(session):
    """Trả về (hàng_tkb, hàng_việc, lỗi, phiên_mới_nếu_vừa_gia_hạn)."""
    new_session = None
    try:
        results = []
        for table, keys in (("timetable_entries", TT_KEYS), ("tasks", TASK_KEYS)):
            r, refreshed = _supabase_request(session, "GET", f"/rest/v1/{table}",
                                             params={"select": ",".join(keys), "order": "sort_order.asc"})
            if refreshed:
                session = new_session = refreshed
            if r.status_code != 200:
                return None, None, _data_error(r), new_session
            results.append([[_s(row.get(k)) for k in keys] for row in r.json()])
        return results[0], results[1], "", new_session
    except requests.RequestException as e:
        return None, None, f"Không kết nối được tới Supabase: {e}", new_session

def sb_save(session, tt_rows, task_rows):
    """Lưu toàn bộ trong một giao dịch. Trả về (lỗi, phiên_mới). Lỗi rỗng nghĩa là thành công."""
    if len(tt_rows) > MAX_TT_ROWS or len(task_rows) > MAX_TASKS:
        return f"Vượt giới hạn: tối đa {MAX_TT_ROWS} dòng thời khóa biểu và {MAX_TASKS} việc cần làm.", None
    payload = {"p_tt": [dict(zip(TT_KEYS, row)) for row in tt_rows],
               "p_tasks": [dict(zip(TASK_KEYS, row)) for row in task_rows]}
    try:
        r, refreshed = _supabase_request(session, "POST", "/rest/v1/rpc/save_my_data", json=payload)
    except requests.RequestException as e:
        return f"Không kết nối được tới Supabase: {e}", None
    return ("" if r.status_code in (200, 204) else _data_error(r)), refreshed

def sb_delete_account(session):
    """Xóa tài khoản và toàn bộ dữ liệu. Trả về (lỗi, phiên_mới)."""
    try:
        r, refreshed = _supabase_request(session, "POST", "/rest/v1/rpc/delete_my_account", json={})
    except requests.RequestException as e:
        return f"Không kết nối được tới Supabase: {e}", None
    return ("" if r.status_code in (200, 204) else _data_error(r)), refreshed


# ============================================================
# 6b. TIẾN ĐỘ HỌC (XP, chuỗi ngày, hàng đợi ôn tập): kiểm tra dữ liệu và đồng bộ Supabase
# ============================================================
PROGRESS_MAX_REVIEW = 150          # phải khớp với MAX_REVIEW_ITEMS trong progress.js
PROGRESS_MAX_BYTES = 450_000       # phải nhỏ hơn giới hạn trong hàm SQL save_my_progress
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

def _int(x, lo=0, hi=10**9, default=0):
    try:
        return min(max(int(float(x)), lo), hi)
    except (TypeError, ValueError):
        return default

def sanitize_progress(data):
    """Dữ liệu tiến độ đến từ trình duyệt nên không được tin: chỉ giữ các trường biết trước, ép kiểu và giới hạn kích thước."""
    if not isinstance(data, dict):
        raise ValueError("tiến độ không hợp lệ")
    levels = {}
    raw_levels = data.get("levels")
    for k, v in list((raw_levels if isinstance(raw_levels, dict) else {}).items())[:100]:
        levels[str(k)[:150]] = _int(v, 1, 5, 2)
    history = []
    for h in (data.get("history") if isinstance(data.get("history"), list) else [])[-100:]:
        if isinstance(h, dict):
            history.append({"t": _int(h.get("t")), "key": str(h.get("key", ""))[:150], "level": _int(h.get("level"), 1, 5, 2),
                            "correct": _int(h.get("correct"), 0, 50), "total": _int(h.get("total"), 0, 50),
                            "predicted": _int(h.get("predicted"), 0, 50)})
    activity = [a for a in (data.get("activity") if isinstance(data.get("activity"), list) else []) if isinstance(a, str) and DATE_RE.match(a)][-120:]
    review = []
    for r in (data.get("review") if isinstance(data.get("review"), list) else [])[:PROGRESS_MAX_REVIEW]:
        if not isinstance(r, dict):
            continue
        options = r.get("options")
        due = r.get("due")
        if not (isinstance(options, list) and len(options) == 4 and isinstance(due, str) and DATE_RE.match(due)):
            continue
        try:
            idx = int(r.get("answer_index"))
        except (TypeError, ValueError):
            continue
        question = str(r.get("q", "")).strip()[:400]
        if not 0 <= idx <= 3 or not question:      # đáp án ngoài khoảng 0-3: bỏ câu, không ép về giá trị khác
            continue
        review.append({"id": str(r.get("id", ""))[:40], "q": question, "options": [str(o)[:160] for o in options],
                       "answer_index": idx, "explanation": str(r.get("explanation", ""))[:400],
                       "source": str(r.get("source", ""))[:60], "key": str(r.get("key", ""))[:150],
                       "box": _int(r.get("box"), 1, 4, 1), "due": due, "added": _int(r.get("added"))})
    owner = data.get("owner")
    out = {"v": 1, "owner": str(owner)[:60] if isinstance(owner, str) and owner else None,
           "updatedAt": _int(data.get("updatedAt"), 0, 10**14), "levels": levels, "history": history,
           "xp": _int(data.get("xp"), 0, 10**7), "activity": activity, "review": review,
           "mastered": _int(data.get("mastered"), 0, 10**6)}
    if len(json.dumps(out, ensure_ascii=False).encode("utf-8")) > PROGRESS_MAX_BYTES:
        raise ValueError("tiến độ quá lớn")
    return out

def sb_load_progress(session):
    """Trả về (tiến độ hoặc None, lỗi, phiên_mới)."""
    try:
        r, refreshed = _supabase_request(session, "GET", "/rest/v1/learning_progress", params={"select": "data"})
    except requests.RequestException as e:
        return None, f"Không kết nối được tới Supabase: {e}", None
    if r.status_code != 200:
        return None, _data_error(r), refreshed
    rows = r.json()
    if not rows:
        return None, "", refreshed
    try:
        return sanitize_progress(rows[0]["data"]), "", refreshed
    except (ValueError, KeyError, TypeError):
        return None, "", refreshed        # dữ liệu cũ hỏng: coi như chưa có, bản mới sẽ ghi đè

def sb_save_progress(session, data):
    try:
        r, refreshed = _supabase_request(session, "POST", "/rest/v1/rpc/save_my_progress", json={"p_data": data})
    except requests.RequestException as e:
        return f"Không kết nối được tới Supabase: {e}", None
    return ("" if r.status_code in (200, 204) else _data_error(r)), refreshed

# ============================================================
# 7. CÁC ENDPOINT API
#    Dùng "def" (không "async def") cho endpoint có gọi mạng kiểu chặn (requests):
#    FastAPI sẽ tự chạy chúng trong luồng riêng nên không làm treo người dùng khác.
# ============================================================
class FileAdapter(io.BytesIO):
    def __init__(self, content: bytes, name: str):
        super().__init__(content)
        self.name = name

class AuthPayload(BaseModel):
    email: str
    password: str

class SessionPayload(BaseModel):
    session: Dict[str, Any]

class SavePayload(BaseModel):
    session: Dict[str, Any]
    timetable: List[List[str]]
    deadlines: List[List[str]]

class ChatPayload(BaseModel):
    mode: str
    level: str
    context_text: str
    messages: List[Dict[str, str]]

class SchedulePayload(BaseModel):
    timetable: List[List[str]]
    deadlines: List[List[str]]
    hours_per_day: float
    preferred: str

class ProgressSavePayload(BaseModel):
    session: Dict[str, Any]
    progress: Dict[str, Any]

class QuizPayload(BaseModel):
    context_text: str
    topic: str = ""
    level: int = 2
    n: int = QUIZ_DEFAULT_N

class QuizResultPayload(BaseModel):
    level: int
    correct: int
    total: int

def _valid_session(session):
    return isinstance(session, dict) and bool(session.get("access_token"))

def _expired_reply():
    return {"ok": False, "expired": True, "error": SESSION_EXPIRED}

@app.post("/api/auth/login")
def api_login(req: AuthPayload):
    ok, msg, sess = sb_sign_in(req.email, req.password)
    tt = tasks = None
    if ok and sess:
        tt, tasks, _, refreshed = sb_load(sess)
        sess = refreshed or sess
    return {"ok": ok, "message": msg, "session": sess, "timetable": tt, "deadlines": tasks}

@app.post("/api/auth/signup")
def api_signup(req: AuthPayload):
    ok, msg = sb_sign_up(req.email, req.password)
    return {"ok": ok, "message": msg}

@app.post("/api/auth/delete")
def api_delete(req: SessionPayload):
    if not _valid_session(req.session):
        return _expired_reply()
    err, refreshed = sb_delete_account(req.session)
    return {"ok": not err, "expired": err == SESSION_EXPIRED, "error": err, "session": refreshed}

@app.post("/api/db/load")
def api_load(req: SessionPayload):
    if not _valid_session(req.session):
        return _expired_reply()
    tt, tasks, err, refreshed = sb_load(req.session)
    return {"ok": not err, "expired": err == SESSION_EXPIRED, "error": err,
            "session": refreshed, "timetable": tt, "deadlines": tasks}

@app.post("/api/db/save")
def api_save(req: SavePayload):
    if not _valid_session(req.session):
        return _expired_reply()
    tt_rows = clean_table(to_df(req.timetable, TIMETABLE_HEADERS, MAX_TT_ROWS + 10), TIMETABLE_HEADERS).values.tolist()
    dl_rows = clean_table(to_df(req.deadlines, DEADLINE_HEADERS, MAX_TASKS + 10), DEADLINE_HEADERS).values.tolist()
    err, refreshed = sb_save(req.session, tt_rows, dl_rows)
    return {"ok": not err, "expired": err == SESSION_EXPIRED, "error": err, "session": refreshed}

@app.post("/api/upload")
async def api_upload(files: List[UploadFile] = File(...)):
    warnings, adapted = [], []
    if len(files) > MAX_FILES:
        warnings.append(f"Chỉ nhận tối đa {MAX_FILES} file mỗi lần, các file còn lại bị bỏ qua.")
    for f in files[:MAX_FILES]:
        name = re.sub(r"[\r\n=]+", " ", os.path.basename(f.filename or "tai-lieu"))[:120]
        if os.path.splitext(name)[1].lower() not in ALLOWED_EXT:
            warnings.append(f"Bỏ qua '{name}': chỉ nhận file .pdf, .docx, .pptx, .txt.")
            continue
        raw = await f.read()
        if len(raw) > MAX_FILE_MB * 1024 * 1024:
            warnings.append(f"Bỏ qua '{name}': file lớn hơn {MAX_FILE_MB} MB.")
            continue
        adapted.append(FileAdapter(raw, name))
    docs, notes = await run_in_threadpool(extract_documents, adapted)
    return {
        "docs": docs,
        "context_text": "\n\n".join(d["content"] for d in docs),
        "warnings": warnings + notes,
        "file_count": len(docs),
        "file_names": [d["name"] for d in docs],
    }

@app.post("/api/chat")
def api_chat(req: ChatPayload):
    if req.mode not in MODE_HINT or req.level not in LEVEL_HINT:
        return {"reply": "⚠️ Chế độ hoặc mức độ không hợp lệ."}
    if len(req.context_text) > MAX_DOC_CHARS:
        return {"reply": "⚠️ Tài liệu quá dài, hãy xóa bớt tài liệu ở My Materials."}
    if req.mode in (MODES[1], MODES[2]) and not req.context_text.strip():
        return {"reply": "⚠️ Chế độ này cần tài liệu bài giảng. Hãy vào trang **My Materials** ở thanh menu trái để tải file lên trước nhé!"}
    history = normalize_history(req.messages[-MAX_MESSAGES_IN:])
    if not history or history[-1]["role"] != "user":
        return {"reply": "⚠️ Không có câu hỏi hợp lệ để gửi."}
    return {"reply": call_gemini(build_system_prompt(req.mode, req.level, req.context_text), history)}

@app.post("/api/progress/save")
def api_progress_save(req: ProgressSavePayload):
    if not _valid_session(req.session):
        return _expired_reply()
    try:
        data = sanitize_progress(req.progress)
    except ValueError as e:
        return {"ok": False, "expired": False, "error": f"Không lưu được tiến độ: {e}."}
    err, refreshed = sb_save_progress(req.session, data)
    return {"ok": not err, "expired": err == SESSION_EXPIRED, "error": err, "session": refreshed}

@app.post("/api/progress/load")
def api_progress_load(req: SessionPayload):
    if not _valid_session(req.session):
        return _expired_reply()
    data, err, refreshed = sb_load_progress(req.session)
    return {"ok": not err, "expired": err == SESSION_EXPIRED, "error": err, "progress": data, "session": refreshed}

@app.post("/api/quiz/generate")
def api_quiz_generate(req: QuizPayload):
    if not req.context_text.strip():
        return {"ok": False, "error": "⚠️ Quiz cần tài liệu bài giảng. Hãy tải file ở My Materials trước."}
    if len(req.context_text) > MAX_DOC_CHARS:
        return {"ok": False, "error": "⚠️ Tài liệu quá dài."}
    n = min(max(req.n, 3), 10)
    questions, err = generate_quiz(req.context_text, req.topic.strip()[:120], req.level, n)
    if err:
        return {"ok": False, "error": err}
    return {"ok": True, "questions": questions}

@app.post("/api/quiz/result")
def api_quiz_result(req: QuizResultPayload):
    total = min(max(req.total, 0), 50)
    correct = min(max(req.correct, 0), total)
    new_level, change = next_level(req.level, correct, total)
    return {"new_level": new_level, "change": change, "accuracy": round(correct / total, 2) if total else 0}

@app.post("/api/schedule")
def api_schedule(req: SchedulePayload):
    preferred = req.preferred if req.preferred in WINDOWS else "Tối"
    hours = min(max(req.hours_per_day, 0.5), 12.0)
    tt_df = to_df(req.timetable, TIMETABLE_HEADERS, MAX_TT_ROWS)
    dl_df = to_df(req.deadlines, DEADLINE_HEADERS, MAX_TASKS)
    sched_df, warnings = build_schedule(tt_df, dl_df, hours, preferred)
    return {"schedule": sched_df.to_dict(orient="records"), "warnings": warnings}

# ============================================================
# 8. PHỤC VỤ GIAO DIỆN (nhiều trang, truy cập trực tiếp từng đường dẫn)
# ============================================================
VALID_PAGES = {
    "", "dashboard", "socratic-ai", "my-materials", "quiz", "week", "study-calendar", "tasks-deadlines",
    "ai-scheduler", "focus-mode", "study-analytics", "profile", "settings",
}

STATIC_FILES = {"app.js", "progress.js", "quiz.js", "week.js"}

@app.get("/static/{filename}")
def serve_static(filename: str):
    if filename not in STATIC_FILES:
        raise HTTPException(status_code=404, detail="Không tìm thấy tệp")
    return FileResponse(filename, media_type="application/javascript", headers={"Cache-Control": "no-cache"})

@app.get("/", response_class=HTMLResponse)
@app.get("/{page_slug}", response_class=HTMLResponse)
def serve_ui(page_slug: str = ""):
    if page_slug not in VALID_PAGES:
        raise HTTPException(status_code=404, detail="Không tìm thấy trang")
    with open("index.html", "r", encoding="utf-8") as f:
        return f.read()
