// ============================================================
// ai.study - Gói C: Lịch tuần dạng lưới
//   xám = giờ học trên trường (từ bảng thời khóa biểu), xanh = buổi tự học do thuật toán xếp
// Chạy sau app.js
// ============================================================
PAGE_META['week'] = { category: 'STUDY MANAGEMENT', title: 'Lịch tuần' };

const WEEK_NAMES = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const GRID_START = 6 * 60, GRID_END = 22 * 60 + 30;      // khớp với khung xếp lịch của backend
const PX_PER_MIN = 0.8;
let weekOffset = 0;                                       // 0 = tuần này, -1 = tuần trước, 1 = tuần sau

function parseHM(s) {
    const m = String(s || '').match(/(\d{1,2})\s*[:hH]\s*(\d{0,2})/);
    if (!m) return null;
    const h = parseInt(m[1], 10), mi = parseInt(m[2] || '0', 10);
    return (h < 24 && mi < 60) ? h * 60 + mi : null;
}

function parseWeekdayIndex(s) {
    const t = String(s || '').toLowerCase();
    if (!t.trim()) return null;
    if (t.includes('cn') || t.includes('chủ')) return 6;
    const m = t.match(/\d/);
    return (m && +m[0] >= 2 && +m[0] <= 7) ? +m[0] - 2 : null;
}

function weekMonday(offset) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
    return d;
}

function fmtHM(min) { return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }
function fmtDM(d) { return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`; }

function shiftWeek(delta) {
    weekOffset = delta === 0 ? 0 : weekOffset + delta;
    renderWeek();
}

// Trả về các khối cần vẽ cho mỗi cột ngày: [{start, end, title, sub, kind}]
function weekBlocks(monday) {
    const cols = WEEK_NAMES.map(() => []);
    collectTable('ttBody').forEach(r => {
        const wd = parseWeekdayIndex(r[1]), s = parseHM(r[2]), e = parseHM(r[3]);
        if (wd !== null && s !== null && e !== null && s < e) cols[wd].push({ start: s, end: e, title: r[0], sub: r[4] || '', kind: 'class' });
    });
    const labels = WEEK_NAMES.map((_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return fmtDM(d); });
    (state.scheduleResult || []).forEach(row => {
        const idx = labels.findIndex(l => String(row['Ngày']).endsWith(l));
        const parts = String(row['Khung giờ']).split(/[–-]/);
        const s = parseHM(parts[0]), e = parseHM(parts[1]);
        if (idx >= 0 && s !== null && e !== null && s < e) cols[idx].push({ start: s, end: e, title: row['Nội dung'], sub: '', kind: 'study' });
    });
    return cols;
}

function renderWeek() {
    const root = document.getElementById('weekGrid');
    if (!root) return;
    root.innerHTML = '';
    const monday = weekMonday(weekOffset);
    const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
    const title = document.getElementById('weekTitle');
    if (title) title.textContent = `${fmtDM(monday)} – ${fmtDM(sunday)}` + (weekOffset === 0 ? ' (tuần này)' : '');

    const height = (GRID_END - GRID_START) * PX_PER_MIN;
    const hourLines = `repeating-linear-gradient(to bottom, transparent 0, transparent ${60 * PX_PER_MIN - 1}px, rgba(255,255,255,0.07) ${60 * PX_PER_MIN - 1}px, rgba(255,255,255,0.07) ${60 * PX_PER_MIN}px)`;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:52px repeat(7, minmax(96px, 1fr)); min-width:780px;';

    // hàng tiêu đề
    grid.appendChild(document.createElement('div'));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    WEEK_NAMES.forEach((name, i) => {
        const d = new Date(monday); d.setDate(d.getDate() + i);
        const isToday = d.getTime() === today.getTime();
        const h = document.createElement('div');
        h.style.cssText = `text-align:center; padding:8px 0; font-size:0.8rem; font-weight:600; border-bottom:1px solid var(--border-subtle);${isToday ? ' color:var(--accent-blue);' : ' color:var(--text-secondary);'}`;
        h.textContent = `${name} ${fmtDM(d)}`;
        grid.appendChild(h);
    });

    // cột giờ
    const hours = document.createElement('div');
    hours.style.cssText = `position:relative; height:${height}px;`;
    for (let m = GRID_START; m <= GRID_END; m += 60) {
        const lab = document.createElement('div');
        lab.style.cssText = `position:absolute; top:${(m - GRID_START) * PX_PER_MIN - 7}px; right:6px; font-size:0.68rem; color:var(--text-muted);`;
        lab.textContent = fmtHM(m);
        hours.appendChild(lab);
    }
    grid.appendChild(hours);

    // 7 cột ngày
    const blocks = weekBlocks(monday);
    WEEK_NAMES.forEach((_, i) => {
        const d = new Date(monday); d.setDate(d.getDate() + i);
        const isToday = d.getTime() === today.getTime();
        const col = document.createElement('div');
        col.style.cssText = `position:relative; height:${height}px; border-left:1px solid var(--border-subtle); background-image:${hourLines};${isToday ? ' background-color:rgba(59,130,246,0.05);' : ''}`;
        blocks[i].forEach(b => {
            const top = (Math.max(b.start, GRID_START) - GRID_START) * PX_PER_MIN;
            const h = Math.max(18, (Math.min(b.end, GRID_END) - Math.max(b.start, GRID_START)) * PX_PER_MIN - 2);
            const div = document.createElement('div');
            const study = b.kind === 'study';
            div.style.cssText = `position:absolute; left:3px; right:3px; top:${top}px; height:${h}px; overflow:hidden; border-radius:6px; padding:3px 6px; font-size:0.7rem; line-height:1.25;`
                + (study ? ' background:rgba(59,130,246,0.25); border-left:3px solid var(--accent-blue);' : ' background:rgba(255,255,255,0.10); border-left:3px solid #71717A;');
            const t = document.createElement('div');
            t.style.fontWeight = '600';
            t.textContent = b.title;
            div.appendChild(t);
            const s = document.createElement('div');
            s.style.color = 'var(--text-secondary)';
            s.textContent = `${fmtHM(b.start)}–${fmtHM(b.end)}` + (b.sub ? ' · ' + b.sub : '');
            div.appendChild(s);
            div.title = `${b.title} (${fmtHM(b.start)}–${fmtHM(b.end)})`;
            col.appendChild(div);
        });
        grid.appendChild(col);
    });
    root.appendChild(grid);
}

onEvent('pageShown', pageId => { if (pageId === 'week') renderWeek(); });
