from datetime import datetime
from zoneinfo import ZoneInfo
import pandas as pd
import pytest

from app import (
    TIMETABLE_HEADERS,
    DEADLINE_HEADERS,
    parse_weekday,
    parse_time,
    parse_due,
    free_blocks,
    build_schedule,
)

TZ = ZoneInfo("Asia/Ho_Chi_Minh")
NOW = datetime(2026, 11, 25, 8, 0, tzinfo=TZ)  # Thứ 4, 25/11/2026 lúc 08:00


def test_parsers_valid_and_invalid():
    assert parse_weekday("2") == 0
    assert parse_weekday("CN") == 6
    assert parse_weekday("9") is None

    assert parse_time("07:30") == 450
    assert parse_time("13h00") == 780
    assert parse_time("25:00") is None

    assert parse_due("30/11", NOW.date()).day == 30
    assert parse_due("31/02", NOW.date()) is None


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
    # Ưu tiên xếp vào buổi Tối (từ 18:00 trở đi)
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
