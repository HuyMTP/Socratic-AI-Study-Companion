// ============================================================
// ai.study - logic giao diện (Gói A: ổn định, an toàn, không mất dữ liệu khi tải lại trang)
// ============================================================

// Bản đồ thông tin các trang trong thanh điều hướng
const PAGE_META = {
    'dashboard':        { category: 'OVERVIEW',         title: 'Dashboard' },
    'socratic-ai':      { category: 'AI LEARNING',      title: 'Socratic AI' },
    'my-materials':     { category: 'AI LEARNING',      title: 'My Materials' },
    'study-calendar':   { category: 'STUDY MANAGEMENT', title: 'Study Calendar' },
    'tasks-deadlines':  { category: 'STUDY MANAGEMENT', title: 'Tasks & Deadlines' },
    'ai-scheduler':     { category: 'STUDY MANAGEMENT', title: 'AI Scheduler' },
    'focus-mode':       { category: 'FOCUS & PROGRESS', title: 'Focus Mode' },
    'study-analytics':  { category: 'FOCUS & PROGRESS', title: 'Study Analytics' },
    'profile':          { category: 'PERSONAL',         title: 'Profile' },
    'settings':         { category: 'PERSONAL',         title: 'Settings' }
};

const MAX_CONTEXT_CHARS = 400000;      // phải khớp với MAX_DOC_CHARS ở backend
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const GREETING = 'Xin chào! Hãy tải lên tài liệu ở mục **My Materials** hoặc đặt bất kỳ câu hỏi nào về bài học để chúng ta cùng phân tích nhé.';

const DEFAULT_TIMETABLE = [
    ["Giải tích 1", "2", "07:00", "09:30", "A101"],
    ["Lập trình căn bản", "4", "13:00", "16:00", "B203"]
];
const DEFAULT_DEADLINES = [
    ["Bài tập lớn Lập trình", "Lập trình căn bản", "30/11", "6"]
];

// Dữ liệu cốt lõi của trang
let state = {
    session: null,
    authMode: 'login',
    contextText: "",
    uploadedFileCount: 0,
    uploadedDocs: [],
    messages: [],
    scheduleResult: [],
    timetable: DEFAULT_TIMETABLE.map(r => r.slice()),
    deadlines: DEFAULT_DEADLINES.map(r => r.slice())
};

// Đồng hồ Pomodoro (25 phút tập trung / 5 phút nghỉ)
const FOCUS_S = 1500, BREAK_S = 300;
let pomo = { phase: 'focus', running: false, remain: FOCUS_S, total: FOCUS_S, endAt: 0, timerId: null };

let chatBusy = false;

// ============================================================
// SỰ KIỆN NỘI BỘ: các file JS khác đăng ký lắng nghe bằng onEvent(tên, hàm)
//   pageShown(pageId) · dataChanged · scheduleGenerated · focusDone · dataCleared(wipeAll) · loggedIn
// Một hàm lỗi không làm hỏng các hàm khác (emit bắt lỗi từng hàm).
// ============================================================
const hooks = {};
function onEvent(name, fn) { (hooks[name] = hooks[name] || []).push(fn); }
function emit(name, ...args) {
    (hooks[name] || []).forEach(fn => {
        try { fn(...args); } catch (e) { console.error('Lỗi trong sự kiện ' + name + ':', e); }
    });
}

// ============================================================
// LƯU TẠM TRONG TRÌNH DUYỆT (tải lại trang không mất dữ liệu)
//  - localStorage: bảng, chat, tài liệu (ở lại trên thiết bị này)
//  - sessionStorage: thông tin đăng nhập (mất khi đóng tab)
// ============================================================
const STORE = {
    tables: 'aistudy.tables', chat: 'aistudy.chat', docs: 'aistudy.docs', session: 'aistudy.session'
};

function storageGet(store, key) {
    try { const v = store.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function storageSet(store, key, value) {
    try { store.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}
function storageRemove(store, key) {
    try { store.removeItem(key); } catch (e) { /* bỏ qua */ }
}

let saveTimer = null, quotaWarned = false;
function saveLocalSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLocalNow, 400);
}
function saveLocalNow() {
    storageSet(localStorage, STORE.tables, { timetable: collectTable('ttBody'), deadlines: collectTable('dlBody') });
    storageSet(localStorage, STORE.chat, state.messages.slice(-40));
    if (!storageSet(localStorage, STORE.docs, state.uploadedDocs) && !quotaWarned) {
        quotaWarned = true;
        showToast('⚠️ Tài liệu quá lớn để nhớ trong trình duyệt, sau khi tải lại trang bạn cần nạp lại tài liệu.');
    }
}

function restoreLocalState() {
    const tables = storageGet(localStorage, STORE.tables);
    if (tables && Array.isArray(tables.timetable) && Array.isArray(tables.deadlines)) {
        state.timetable = tables.timetable;
        state.deadlines = tables.deadlines;
    }
    const chat = storageGet(localStorage, STORE.chat);
    if (Array.isArray(chat)) {
        state.messages = chat.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    }
    const docs = storageGet(localStorage, STORE.docs);
    if (Array.isArray(docs)) {
        state.uploadedDocs = docs.filter(d => d && typeof d.name === 'string' && typeof d.content === 'string');
    }
    const sess = storageGet(sessionStorage, STORE.session);
    if (sess && sess.access_token) state.session = sess;
}

// ============================================================
// TIỆN ÍCH CHUNG
// ============================================================
function showToast(msg) {
    const box = document.getElementById('toastBox');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4200);
}

async function postJSON(url, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).detail; } catch (e) { /* bỏ qua */ }
        throw new Error(typeof detail === 'string' && detail ? detail : `Máy chủ phản hồi mã ${res.status}`);
    }
    return res.json();
}

// Chống XSS: nội dung AI luôn được lọc bằng DOMPurify trước khi chèn vào trang
if (window.DOMPurify) {
    DOMPurify.addHook('afterSanitizeAttributes', node => {
        if (node.tagName === 'A') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
        }
    });
}
function setAssistantContent(el, text) {
    if (window.marked && window.DOMPurify) {
        el.innerHTML = DOMPurify.sanitize(marked.parse(text));
    } else {
        el.textContent = text;   // thiếu thư viện thì hiện chữ thường, không chèn HTML
    }
}

// ============================================================
// KHỞI TẠO TRANG
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
    restoreLocalState();
    renderTable('ttBody', state.timetable, 5);
    renderTable('dlBody', state.deadlines, 4);
    renderChatFromState();
    updateDocsState();
    applySessionUI();
    updatePomoUI();

    document.getElementById('authPass').addEventListener('keydown', e => {
        if (e.key === 'Enter') submitAuth();
    });

    const slug = window.location.pathname.replace(/^\/+/, '') || 'dashboard';
    navigateTo(PAGE_META[slug] ? slug : 'dashboard', false);
});

window.addEventListener('popstate', () => {
    const slug = window.location.pathname.replace(/^\/+/, '') || 'dashboard';
    navigateTo(PAGE_META[slug] ? slug : 'dashboard', false);
});

// ============================================================
// ĐIỀU HƯỚNG VÀ THANH BÊN
// ============================================================
function navigateTo(pageId, pushUrl = true) {
    if (!PAGE_META[pageId]) pageId = 'dashboard';

    document.querySelectorAll('.page-view').forEach(p => p.classList.remove('active'));
    const target = document.getElementById('page-' + pageId);
    if (target) target.classList.add('active');

    document.querySelectorAll('.sidebar .nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-page') === pageId);
    });

    document.getElementById('bcCategory').textContent = PAGE_META[pageId].category;
    document.getElementById('bcPage').textContent = PAGE_META[pageId].title;

    if (pushUrl) {
        const newPath = pageId === 'dashboard' ? '/' : '/' + pageId;
        window.history.pushState({ pageId }, '', newPath);
    }

    refreshDashboardAndAnalytics();
    emit('pageShown', pageId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleSidebar() {
    document.getElementById('appSidebar').classList.toggle('collapsed');
}

// ============================================================
// BẢNG DỮ LIỆU VÀ DÁN TỪ EXCEL (CTRL+V)
// ============================================================
function renderTable(tbodyId, rows, colCount) {
    const tbody = document.getElementById(tbodyId);
    tbody.innerHTML = '';
    rows.forEach(r => addRow(tbodyId, colCount, r));
}

function addRow(tbodyId, colCount, values = []) {
    const tbody = document.getElementById(tbodyId);
    const tr = document.createElement('tr');
    for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td');
        const inp = document.createElement('input');
        inp.value = values[i] || '';
        inp.addEventListener('input', refreshDashboardAndAnalytics);
        inp.addEventListener('paste', (e) => handleExcelPaste(e, tbodyId, colCount));
        td.appendChild(inp);
        tr.appendChild(td);
    }
    const tdDel = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'row-del-btn';
    btn.textContent = '×';
    btn.onclick = () => { tr.remove(); refreshDashboardAndAnalytics(); };
    tdDel.appendChild(btn);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
}

function handleExcelPaste(e, tbodyId, colCount) {
    const clip = (e.clipboardData || window.clipboardData).getData('text');
    if (!clip.includes('\t') && !clip.includes('\n')) return;
    e.preventDefault();
    clip.trim().split(/\r?\n/).forEach(line => {
        addRow(tbodyId, colCount, line.split('\t').slice(0, colCount));
    });
    refreshDashboardAndAnalytics();
    showToast('✅ Đã dán dữ liệu từ Excel!');
}

function collectTable(tbodyId) {
    const rows = [];
    document.querySelectorAll(`#${tbodyId} tr`).forEach(tr => {
        const vals = Array.from(tr.querySelectorAll('input')).map(i => i.value.trim());
        if (vals.some(v => v !== '')) rows.push(vals);
    });
    return rows;
}

function addTopicToSchedule() {
    const topic = document.getElementById('topicInput').value.trim();
    const due = document.getElementById('dueInput').value.trim();
    const hrs = document.getElementById('hoursInput').value.trim();
    if (!topic) {
        showToast('⚠️ Vui lòng nhập tên chủ đề.');
        return;
    }
    addRow('dlBody', 4, [`Ôn tập: ${topic}`, "", due, String(hrs)]);
    document.getElementById('topicInput').value = '';
    refreshDashboardAndAnalytics();
    showToast('✅ Đã thêm vào trang Tasks & Deadlines!');
}

function refreshDashboardAndAnalytics() {
    const tt = collectTable('ttBody');
    const dl = collectTable('dlBody');

    document.getElementById('dashDocCount').textContent = state.uploadedFileCount;
    document.getElementById('dashClassCount').textContent = tt.length;
    document.getElementById('dashTaskCount').textContent = dl.length;

    document.getElementById('anaClassCount').textContent = tt.length + ' môn';
    let totalHrs = 0;
    dl.forEach(r => {
        const h = parseFloat((r[3] || '0').replace(',', '.'));
        if (!isNaN(h) && h > 0) totalHrs += h;
    });
    document.getElementById('anaTotalHours').textContent = totalHrs.toFixed(1) + 'h';
    document.getElementById('anaScheduledCount').textContent = state.scheduleResult.length + ' phiên';
    saveLocalSoon();
    emit('dataChanged');
}

function refreshAnalytics() {
    refreshDashboardAndAnalytics();
    showToast('✅ Đã cập nhật số liệu thống kê!');
}

// ============================================================
// MY MATERIALS (TÀI LIỆU)
// ============================================================
function updateDocsState() {
    state.uploadedFileCount = state.uploadedDocs.length;
    let ctx = state.uploadedDocs.map(d => d.content.trim()).join("\n\n");
    const truncated = ctx.length > MAX_CONTEXT_CHARS;
    if (truncated) ctx = ctx.slice(0, MAX_CONTEXT_CHARS);
    state.contextText = ctx;

    const statusEl = document.getElementById('uploadStatus');
    statusEl.textContent = state.uploadedDocs.length > 0
        ? `Đã nạp ${state.uploadedDocs.length} tài liệu (${ctx.length.toLocaleString()} ký tự)` + (truncated ? ', đã cắt bớt phần cuối cho vừa giới hạn' : '')
        : 'Chưa có tài liệu nào được tải lên';

    document.getElementById('contextPreviewBox').textContent = ctx || 'Chưa có nội dung trích xuất.';
    renderUploadedFilesList();
    refreshDashboardAndAnalytics();
}

function renderUploadedFilesList() {
    const listEl = document.getElementById('uploadedFilesList');
    listEl.innerHTML = '';
    state.uploadedDocs.forEach((doc, idx) => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:9px 12px; background:var(--bg-base); border:1px solid var(--border-subtle); border-radius:10px; font-size:0.83rem; gap:10px;';

        const left = document.createElement('div');
        left.style.cssText = 'display:flex; align-items:center; gap:8px; overflow:hidden; min-width:0;';
        const icon = document.createElement('span');
        icon.style.flexShrink = '0';
        icon.textContent = '📘';
        const name = document.createElement('span');
        name.style.cssText = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        name.textContent = doc.name;      // textContent: tên file không thể chèn mã
        name.title = doc.name;
        left.append(icon, name);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'row-del-btn';
        del.style.cssText = 'flex-shrink:0; font-size:1.1rem; line-height:1; cursor:pointer;';
        del.title = 'Xóa tài liệu này';
        del.textContent = '×';
        del.onclick = () => removeUploadedDoc(idx);

        item.append(left, del);
        listEl.appendChild(item);
    });
}

function removeUploadedDoc(index) {
    if (index >= 0 && index < state.uploadedDocs.length) {
        const removed = state.uploadedDocs.splice(index, 1);
        updateDocsState();
        showToast(`🗑️ Đã xóa: ${removed[0].name}`);
    }
}

async function handleFileUpload(fileList) {
    const picked = Array.from(fileList || []);
    if (picked.length === 0) return;
    const files = picked.filter(f => {
        if (f.size > MAX_FILE_BYTES) { showToast(`⚠️ Bỏ qua '${f.name}': file lớn hơn 20 MB.`); return false; }
        return true;
    });
    const input = document.getElementById('fileInput');
    if (files.length === 0) { input.value = ''; return; }

    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    const statusEl = document.getElementById('uploadStatus');
    statusEl.textContent = 'Đang trích xuất văn bản...';

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error(`Máy chủ phản hồi mã ${res.status}`);
        const data = await res.json();

        (data.docs || []).forEach(doc => {
            const idx = state.uploadedDocs.findIndex(d => d.name === doc.name);
            if (idx >= 0) state.uploadedDocs[idx] = doc; else state.uploadedDocs.push(doc);
        });
        (data.warnings || []).forEach(w => showToast('⚠️ ' + w));
        updateDocsState();
        if ((data.docs || []).length) showToast('✅ Đã nạp tài liệu thành công!');
    } catch (err) {
        updateDocsState();
        showToast('⚠️ Lỗi khi tải tài liệu: ' + err.message);
    } finally {
        input.value = '';   // cho phép chọn lại đúng file đó lần sau
    }
}

// ============================================================
// SOCRATIC AI (CHAT)
// ============================================================
function appendBubble(boxId, role, content) {
    const box = document.getElementById(boxId);
    const div = document.createElement('div');
    div.className = `msg-bubble ${role === 'user' ? 'msg-user' : 'msg-assistant'}`;
    if (role === 'user') div.textContent = content;
    else setAssistantContent(div, content);
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
}

function renderChatFromState() {
    const box = document.getElementById('chatBox');
    box.innerHTML = '';
    if (state.messages.length === 0) appendBubble('chatBox', 'assistant', GREETING);
    else state.messages.forEach(m => appendBubble('chatBox', m.role, m.content));
}

function clearChat() {
    state.messages = [];
    storageRemove(localStorage, STORE.chat);
    document.getElementById('chatBox').innerHTML = '';
    appendBubble('chatBox', 'assistant', 'Đã làm mới phiên trò chuyện. Bạn cần mình hỗ trợ phần nào tiếp theo?');
}

async function sendChatMessage(e) {
    e.preventDefault();
    if (chatBusy) return;
    const inp = document.getElementById('chatInput');
    const prompt = inp.value.trim();
    if (!prompt) return;

    const sendBtn = e.target.querySelector('button[type="submit"]');
    chatBusy = true;
    if (sendBtn) sendBtn.disabled = true;

    inp.value = '';
    state.messages.push({ role: 'user', content: prompt });
    appendBubble('chatBox', 'user', prompt);

    const mode = document.querySelector('input[name="ai_mode"]:checked').value;
    const level = document.getElementById('aiLevel').value;
    const loadingBubble = appendBubble('chatBox', 'assistant', '*Đang suy nghĩ...*');

    try {
        const data = await postJSON('/api/chat', {
            mode: mode,
            level: level,
            context_text: state.contextText,
            messages: state.messages.slice(-60)
        });
        setAssistantContent(loadingBubble, data.reply);
        if (data.reply.startsWith('⚠️')) {
            state.messages.pop();     // lỗi: bỏ lượt hỏi này khỏi ngữ cảnh để lần gửi sau không bị nhiễu
        } else {
            state.messages.push({ role: 'assistant', content: data.reply });
        }
    } catch (err) {
        state.messages.pop();
        loadingBubble.textContent = '⚠️ Lỗi kết nối máy chủ: ' + err.message;
    } finally {
        chatBusy = false;
        if (sendBtn) sendBtn.disabled = false;
        document.getElementById('chatBox').scrollTop = document.getElementById('chatBox').scrollHeight;
        saveLocalSoon();
    }
}

// ============================================================
// AI SCHEDULER (XẾP LỊCH)
// ============================================================
function resetScheduleView() {
    state.scheduleResult = [];
    document.getElementById('scheduleWarnings').innerHTML = '';
    document.getElementById('scheduleResultBody').innerHTML = '';
    document.getElementById('scheduleResultWrap').style.display = 'none';
}

async function runScheduleAlgorithm() {
    const hoursVal = parseFloat(document.getElementById('hoursSlider').value);
    const pref = document.querySelector('input[name="time_pref"]:checked').value;

    let data;
    try {
        data = await postJSON('/api/schedule', {
            timetable: collectTable('ttBody'),
            deadlines: collectTable('dlBody'),
            hours_per_day: hoursVal,
            preferred: pref
        });
    } catch (err) {
        showToast('⚠️ Không xếp được lịch: ' + err.message);
        return;
    }
    state.scheduleResult = data.schedule || [];

    const warnBox = document.getElementById('scheduleWarnings');
    warnBox.innerHTML = '';
    (data.warnings || []).forEach(w => {
        const p = document.createElement('div');
        p.style.cssText = 'background:rgba(251,191,36,0.12); color:#FBBF24; padding:10px 14px; border-radius:10px; font-size:0.82rem;';
        p.textContent = '⚠️ ' + w;
        warnBox.appendChild(p);
    });

    const wrap = document.getElementById('scheduleResultWrap');
    const tbody = document.getElementById('scheduleResultBody');
    tbody.innerHTML = '';
    if (state.scheduleResult.length > 0) {
        wrap.style.display = 'block';
        state.scheduleResult.forEach(row => {
            const tr = document.createElement('tr');
            [row['Ngày'], row['Khung giờ'], row['Nội dung']].forEach((text, i) => {
                const td = document.createElement('td');
                td.style.padding = '11px 14px';
                if (i === 1) td.style.fontFamily = "'JetBrains Mono', monospace";
                td.textContent = text;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        showToast('✅ Đã xếp lịch tự học thành công!');
        emit('scheduleGenerated');
    } else {
        wrap.style.display = 'none';
        showToast('Không có lịch tự học nào được tạo.');
    }
    refreshDashboardAndAnalytics();
}

// ============================================================
// FOCUS MODE (POMODORO) - tính theo mốc giờ kết thúc nên vẫn đúng khi chuyển tab
// ============================================================
function updatePomoUI() {
    const mins = String(Math.floor(pomo.remain / 60)).padStart(2, '0');
    const secs = String(pomo.remain % 60).padStart(2, '0');
    const timeStr = `${mins}:${secs}`;

    document.getElementById('pomoDigits').textContent = timeStr;
    document.getElementById('dashPomoState').textContent = timeStr;
    document.getElementById('miniPomoText').textContent = timeStr;
    document.getElementById('miniPomoBadge').style.display = pomo.running ? 'inline-flex' : 'none';

    const badge = document.getElementById('pomoPhaseBadge');
    if (pomo.phase === 'break') {
        badge.textContent = '☕ Nghỉ ngắn (5 phút)';
        badge.style.background = 'rgba(251, 191, 36, 0.14)';
        badge.style.color = '#FBBF24';
    } else {
        badge.textContent = '🎯 Tập trung sâu (25 phút)';
        badge.style.background = 'rgba(34, 197, 94, 0.14)';
        badge.style.color = '#4ADE80';
    }

    const pct = ((pomo.total - pomo.remain) / pomo.total) * 100;
    document.getElementById('pomoBar').style.width = `${Math.max(0, Math.min(100, pct))}%`;

    const startBtn = document.getElementById('pomoStartBtn');
    if (pomo.running) startBtn.textContent = '⏸️ Tạm dừng';
    else startBtn.textContent = (pomo.remain > 0 && pomo.remain < pomo.total) ? '▶️ Tiếp tục' : '▶️ Bắt đầu';
}

function tickPomodoro() {
    pomo.remain = Math.max(0, Math.ceil((pomo.endAt - Date.now()) / 1000));
    if (pomo.remain <= 0) {
        if (pomo.phase === 'focus') {
            pomo.phase = 'break';
            pomo.total = BREAK_S;
            pomo.remain = BREAK_S;
            pomo.endAt = Date.now() + BREAK_S * 1000;
            showToast('🎉 Hoàn thành 25 phút tập trung! Đang chuyển sang nghỉ 5 phút.');
            emit('focusDone');
        } else {
            clearInterval(pomo.timerId);
            pomo.running = false;
            pomo.remain = 0;
            showToast('🔔 Hết 5 phút nghỉ ngơi! Sẵn sàng quay lại bàn học.');
            if (window.confetti) confetti({ particleCount: 90, spread: 70, origin: { y: 0.6 } });
        }
    }
    updatePomoUI();
}

function togglePomodoro() {
    if (pomo.running) {
        tickPomodoro();                  // chốt số giây còn lại trước khi dừng
        clearInterval(pomo.timerId);
        pomo.running = false;
        updatePomoUI();
    } else {
        if (pomo.remain <= 0) resetPomodoro();
        pomo.running = true;
        pomo.endAt = Date.now() + pomo.remain * 1000;
        updatePomoUI();
        pomo.timerId = setInterval(tickPomodoro, 500);
    }
}

function resetPomodoro() {
    clearInterval(pomo.timerId);
    pomo.running = false;
    pomo.phase = 'focus';
    pomo.total = FOCUS_S;
    pomo.remain = FOCUS_S;
    pomo.endAt = 0;
    updatePomoUI();
}

// ============================================================
// TÀI KHOẢN SUPABASE
// ============================================================
function applySessionUI() {
    const btn = document.getElementById('navbarUserBtn');
    const title = document.getElementById('profileStatusTitle');
    const desc = document.getElementById('profileStatusDesc');
    const left = document.createElement('span');
    const right = document.createElement('span');
    if (state.session) {
        left.textContent = '👤 ' + String(state.session.email || '').split('@')[0];
        right.textContent = '▾';
        title.textContent = 'Đã kết nối: ' + state.session.email;
        desc.textContent = 'Tài khoản của bạn đã được liên kết với cơ sở dữ liệu đám mây Supabase.';
    } else {
        left.textContent = '👤 Đăng nhập / Đăng ký';
        right.textContent = '→';
        title.textContent = 'Chưa đăng nhập';
        desc.textContent = 'Hãy đăng nhập bằng nút bong bóng ở góc trên bên phải để đồng bộ Thời khóa biểu và Deadline lên cơ sở dữ liệu Supabase.';
    }
    btn.textContent = '';
    btn.append(left, right);
}

function openAuthModal() {
    document.getElementById('authLoggedOutView').style.display = state.session ? 'none' : 'block';
    document.getElementById('authLoggedInView').style.display = state.session ? 'block' : 'none';
    if (state.session) {
        document.getElementById('loggedEmailText').textContent = 'Email: ' + state.session.email;
    }
    document.getElementById('authModal').classList.add('open');
}

function closeAuthModal() {
    document.getElementById('authModal').classList.remove('open');
}

function switchAuthTab(mode) {
    state.authMode = mode;
    document.getElementById('tabBtnLogin').classList.toggle('active', mode === 'login');
    document.getElementById('tabBtnReg').classList.toggle('active', mode === 'reg');
    document.getElementById('authSubmitBtn').textContent = mode === 'login' ? 'Đăng nhập ➔' : 'Tạo tài khoản ➔';
}

function setSession(session) {
    state.session = session;
    if (session) storageSet(sessionStorage, STORE.session, session);
    else storageRemove(sessionStorage, STORE.session);
    applySessionUI();
}

// Máy chủ có thể trả về phiên đã gia hạn hoặc báo phiên hết hạn. Trả về true nếu phiên hết hạn.
function handleSessionReply(data) {
    if (data.session) setSession(data.session);
    if (data.expired) {
        setSession(null);
        showToast('⚠️ Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.');
        openAuthModal();
        return true;
    }
    return false;
}

async function submitAuth() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPass').value;
    if (!email || !password) {
        showToast('⚠️ Vui lòng nhập đầy đủ Email và Mật khẩu.');
        return;
    }
    const endpoint = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/signup';
    let data;
    try {
        data = await postJSON(endpoint, { email, password });
    } catch (err) {
        showToast('⚠️ Lỗi kết nối máy chủ: ' + err.message);
        return;
    }
    showToast((data.ok ? '✅ ' : '⚠️ ') + data.message);

    if (data.ok && state.authMode === 'login') {
        setSession(data.session);
        emit('loggedIn');
        document.getElementById('authPass').value = '';
        if (data.timetable && data.timetable.length) renderTable('ttBody', data.timetable, 5);
        if (data.deadlines && data.deadlines.length) renderTable('dlBody', data.deadlines, 4);
        refreshDashboardAndAnalytics();
        closeAuthModal();
    }
}

// Xóa mọi dữ liệu cá nhân trên trình duyệt (dùng khi đăng xuất hoặc xóa tài khoản)
function clearPersonalData(message, wipeAll = false) {
    setSession(null);
    state.messages = [];
    state.uploadedDocs = [];
    storageRemove(localStorage, STORE.tables);
    storageRemove(localStorage, STORE.chat);
    storageRemove(localStorage, STORE.docs);
    renderTable('ttBody', DEFAULT_TIMETABLE, 5);
    renderTable('dlBody', DEFAULT_DEADLINES, 4);
    renderChatFromState();
    resetScheduleView();
    updateDocsState();
    closeAuthModal();
    emit('dataCleared', wipeAll);
    showToast(message);
}

function logoutUser() {
    clearPersonalData('Đã đăng xuất khỏi hệ thống.');
}

async function deleteAccount() {
    if (!state.session) {
        showToast('⚠️ Bạn chưa đăng nhập.');
        return;
    }
    const typed = window.prompt(
        'Việc này xóa vĩnh viễn tài khoản và toàn bộ dữ liệu đã lưu trên đám mây, không thể hoàn tác.\n' +
        'Gõ lại email của bạn để xác nhận:\n' + state.session.email
    );
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== String(state.session.email).toLowerCase()) {
        showToast('⚠️ Email xác nhận không khớp, đã hủy.');
        return;
    }
    try {
        const data = await postJSON('/api/auth/delete', { session: state.session });
        if (handleSessionReply(data)) return;
        if (data.ok) clearPersonalData('✅ Đã xóa tài khoản và toàn bộ dữ liệu của bạn.', true);
        else showToast('⚠️ Không xóa được: ' + data.error);
    } catch (err) {
        showToast('⚠️ Lỗi kết nối máy chủ: ' + err.message);
    }
}

async function saveToSupabase() {
    if (!state.session) {
        showToast('⚠️ Vui lòng đăng nhập tài khoản trước khi lưu.');
        openAuthModal();
        return;
    }
    try {
        const data = await postJSON('/api/db/save', {
            session: state.session,
            timetable: collectTable('ttBody'),
            deadlines: collectTable('dlBody')
        });
        if (handleSessionReply(data)) return;
        if (data.ok) showToast('✅ Đã lưu dữ liệu an toàn vào cơ sở dữ liệu!');
        else showToast('⚠️ Lỗi khi lưu: ' + data.error);
    } catch (err) {
        showToast('⚠️ Lỗi kết nối máy chủ: ' + err.message);
    }
}

async function loadFromSupabase() {
    if (!state.session) {
        showToast('⚠️ Vui lòng đăng nhập tài khoản trước.');
        openAuthModal();
        return;
    }
    try {
        const data = await postJSON('/api/db/load', { session: state.session });
        if (handleSessionReply(data)) return;
        if (data.ok) {
            if (data.timetable && data.timetable.length) renderTable('ttBody', data.timetable, 5);
            if (data.deadlines && data.deadlines.length) renderTable('dlBody', data.deadlines, 4);
            refreshDashboardAndAnalytics();
            showToast('✅ Đã nạp lại dữ liệu thành công!');
        } else {
            showToast('⚠️ Lỗi khi nạp: ' + data.error);
        }
    } catch (err) {
        showToast('⚠️ Lỗi kết nối máy chủ: ' + err.message);
    }
}
