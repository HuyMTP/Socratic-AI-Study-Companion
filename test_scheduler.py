from collections import defaultdict
from datetime import datetime, timedelta
import math
import random
import re
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from app import (
    BUFFER,
    DAY_NAMES,
    DEADLINE_HEADERS,
    MAX_SESSION,
    MIN_SESSION,
    TIMETABLE_HEADERS,
    WINDOWS,
    build_schedule,
    free_blocks,
    parse_due,
    parse_hours,
    parse_time,
    parse_weekday,
)

TZ = ZoneInfo("Asia/Ho_Chi_Minh")
NOW = datetime(2026, 11, 25, 8, 0, tzinfo=TZ)  # Thứ 4, 25/11/2026 lúc 08:00


def _to_min(hhmm: str) -> int:
    h, m = map(int, hhmm.split(":"))
    return h * 60 + m


def test_parsers_valid_and_invalid():
    assert parse_weekday("2") == 0
    assert parse_weekday("Thứ 2") == 0
    assert parse_weekday("CN") == 6
    assert parse_weekday("9") is None

    assert parse_time("07:30") == 450
    assert parse_time("7h30") == 450
    assert parse_time("13h00") == 780
    assert parse_time("25:00") is None

    assert parse_due("30/11", NOW.date()).day == 30
    assert parse_due("30-11", NOW.date()).day == 30
    assert parse_due("10/01", NOW.date()).year == 2027  # quá 60 ngày -> năm sau
    assert parse_due("31/02", NOW.date()) is None

    assert parse_hours("2,5") == 2.5
    assert parse_hours("-1") is None
    assert parse_hours(None) is None
    assert parse_hours(float("nan")) is None


def test_free_blocks_respects_class_and_buffer():
    # Lớp học 08:00-10:00 (480-600), buffer 15p -> bận từ 07:45 (465) đến 10:15 (615)
    blocks = free_blocks([(480, 600)], earliest=360)
    for start, end, _ in blocks:
        assert end <= 465 or start >= 615


def test_build_schedule_prefers_chosen_window():
    tt = pd.DataFrame([["Giải tích", "4", "07:00", "11:00", "A101"]], columns=TIMETABLE_HEADERS)
    dl = pd.DataFrame([["Ôn giữa kỳ", "Giải tích", "28/11", "2"]], columns=DEADLINE_HEADERS)

    sched, warnings = build_schedule(tt, dl, hours_per_day=3.0, preferred="Tối", now=NOW)
    assert not warnings
    assert len(sched) > 0
    first_slot = sched.iloc[0]["Khung giờ"]
    assert first_slot.startswith("18:") or first_slot.startswith("19:")


def test_build_schedule_warns_when_not_enough_time():
    tt = pd.DataFrame([], columns=TIMETABLE_HEADERS)
    # Cần 20 giờ nhưng hạn là ngay hôm nay, tối đa 2h/ngày -> chắc chắn thiếu giờ
    dl = pd.DataFrame([["Đồ án lớn", "CNTT", "25/11", "20"]], columns=DEADLINE_HEADERS)

    _, warnings = build_schedule(tt, dl, hours_per_day=2.0, preferred="Tối", now=NOW)
    assert any("Chưa đủ thời gian" in w for w in warnings)


def test_build_schedule_skips_past_deadline():
    tt = pd.DataFrame([], columns=TIMETABLE_HEADERS)
    dl = pd.DataFrame([["Bài cũ", "Toán", "01/11", "2"]], columns=DEADLINE_HEADERS)

    sched, warnings = build_schedule(tt, dl, hours_per_day=3.0, preferred="Tối", now=NOW)
    assert len(sched) == 0
    assert any("Bỏ qua công việc" in w for w in warnings)


def test_reversed_class_time_and_tie_breaking():
    # Giờ kết thúc <= giờ bắt đầu phải bị bỏ qua kèm cảnh báo
    tt = pd.DataFrame([["Vật lý", "4", "10:00", "08:00", "B102"]], columns=TIMETABLE_HEADERS)
    # Hai việc cùng hạn ngày hôm nay, ngân sách chỉ đủ 1 giờ -> ưu tiên việc nhập trước
    dl = pd.DataFrame(
        [
            ["Việc A", "Môn 1", "25/11", "1"],
            ["Việc B", "Môn 2", "25/11", "1"],
        ],
        columns=DEADLINE_HEADERS,
    )

    sched, warnings = build_schedule(tt, dl, hours_per_day=1.0, preferred="Tối", now=NOW)
    assert any("Bỏ qua TKB 'Vật lý'" in w for w in warnings)
    assert list(sched["Nội dung"]) == ["Việc A (Môn 1)"]
    assert any("Chưa đủ thời gian cho 'Việc B (Môn 2)'" in w for w in warnings)


def test_property_500_random_cases():
    """Kiểm tra 6 tính chất bất biến trên 500 bộ dữ liệu ngẫu nhiên (cố định seed để tái lập)."""
    rng = random.Random(42)
    day_lo, day_hi = WINDOWS["Sáng"][0], WINDOWS["Tối"][1]
    window_names = list(WINDOWS.keys())

    for case_idx in range(500):
        now = datetime(2026, 10, 26, rng.randint(0, 23), rng.randint(0, 59), tzinfo=TZ)
        today = now.date()
        now_mins = now.hour * 60 + now.minute
        today_label = f"{DAY_NAMES[today.weekday()]} {today:%d/%m}"

        # Sinh ngẫu nhiên 0–6 môn học
        tt_rows = []
        classes_by_wd = defaultdict(list)
        for i in range(rng.randint(0, 6)):
            wd = rng.randint(0, 6)
            start = rng.randint(7, 19) * 60 + rng.choice([0, 15, 30, 45])
            end = min(22 * 60, start + rng.choice([60, 90, 120, 150, 180]))
            wd_str = "CN" if wd == 6 else str(wd + 2)
            tt_rows.append([
                f"Môn {i}",
                wd_str,
                f"{start // 60:02d}:{start % 60:02d}",
                f"{end // 60:02d}:{end % 60:02d}",
                f"P{i}",
            ])
            classes_by_wd[wd].append((start, end))

        # Sinh ngẫu nhiên 1–5 công việc hợp lệ
        dl_rows = []
        expected = defaultdict(int)
        for j in range(rng.randint(1, 5)):
            due = today + timedelta(days=rng.randint(0, 14))
            hrs = rng.choice([0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6])
            name, subj = f"Việc {j}", f"Môn {j}"
            dl_rows.append([name, subj, f"{due:%d/%m}", str(hrs)])
            expected[f"{name} ({subj})"] += int(math.ceil(hrs * 2)) * 30

        hours_per_day = rng.choice([1, 1.5, 2, 2.5, 3, 4, 5, 6])
        preferred = rng.choice(window_names)

        tt_df = pd.DataFrame(tt_rows, columns=TIMETABLE_HEADERS)
        dl_df = pd.DataFrame(dl_rows, columns=DEADLINE_HEADERS)
        sched, warnings = build_schedule(tt_df, dl_df, hours_per_day, preferred, now=now)

        daily_total = defaultdict(int)
        scheduled = defaultdict(int)

        for _, row in sched.iterrows():
            day_str = row["Ngày"]
            wd = DAY_NAMES.index(day_str.split()[0])
            s_str, e_str = re.split(r"[–-]", row["Khung giờ"])
            s, e = _to_min(s_str), _to_min(e_str)
            dur = e - s

            # 1. Mọi buổi học dài từ 30 đến 90 phút
            assert MIN_SESSION <= dur <= MAX_SESSION, f"Case {case_idx}: buổi {dur}p ngoài [30, 90]"

            # 2. Mọi buổi nằm trong khung 06:00–22:30
            assert day_lo <= s < e <= day_hi, f"Case {case_idx}: khung {s}-{e} ngoài 06:00-22:30"

            # 3. Không trùng giờ học trên trường (kể cả đệm 15 phút hai đầu)
            for cs, ce in classes_by_wd[wd]:
                assert e <= cs - BUFFER or s >= ce + BUFFER, (
                    f"Case {case_idx}: trùng TKB {cs}-{ce} với {s}-{e}"
                )

            # 5. Không xếp vào khoảng giờ đã trôi qua của hôm nay
            if day_str == today_label:
                assert s >= now_mins, f"Case {case_idx}: xếp vào quá khứ ({s} < {now_mins})"

            daily_total[day_str] += dur
            scheduled[row["Nội dung"]] += dur

        # 4. Tổng giờ một ngày không vượt ngân sách người dùng chọn
        max_daily = int(hours_per_day * 60)
        for day_str, total_mins in daily_total.items():
            assert total_mins <= max_daily, f"Case {case_idx}: {day_str} vượt {max_daily}p"

        # 6. Bảo toàn thời lượng (đủ giờ yêu cầu hoặc cảnh báo đúng phần thiếu)
        missing = defaultdict(float)
        for w in warnings:
            m = re.match(r"Chưa đủ thời gian cho '(.+)': thiếu ([\d.]+)h", w)
            if m:
                missing[m.group(1)] += float(m.group(2)) * 60

        for label, req_mins in expected.items():
            got_mins = scheduled[label]
            if got_mins < req_mins:
                assert label in missing, f"Case {case_idx}: thiếu cảnh báo cho '{label}'"
                assert abs((got_mins + missing[label]) - req_mins) <= 1, (
                    f"Case {case_idx}: lệch giờ '{label}' ({got_mins} + {missing[label]} != {req_mins})"
                )
            else:
                assert got_mins == req_mins, f"Case {case_idx}: xếp dư giờ '{label}'"
                assert label not in missing, f"Case {case_idx}: đủ giờ nhưng vẫn cảnh báo '{label}'"