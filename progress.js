// ============================================================
// ai.study - Gói C: mô hình tiến độ học
//   - điểm XP và chuỗi ngày học
//   - hàng đợi ôn tập giãn cách theo hệ thống hộp Leitner
//   - đồng bộ tiến độ lên Supabase (khi đã đăng nhập)
// Chạy sau app.js, trước quiz.js
// ============================================================
const PROGRESS_KEY = 'aistudy.progress';
const REVIEW_INTERVALS = { 1: 1, 2: 3, 3: 7, 4: 14 };   // số ngày chờ ở mỗi hộp trước lần ôn kế tiếp
const MAX_BOX = 4;
const MAX_REVIEW_ITEMS = 150;                            // phải khớp với backend (app.py)
const XP = { attempt: 2, correct: 3, calibExact: 5, calibClose: 2, focus: 10, reviewAttempt: 2, reviewCorrect: 3 };
const RANK_XP = 100;                                     // mỗi 100 XP lên một bậc
const SYNC_DELAY_MS = 2000;

function pad2(n) { return String(n).padStart(2, '0'); }

// ---------- Mô hình dữ liệu ----------
function emptyProgress() {
    return { v: 1, owner: null, updatedAt: 0, levels: {}, history: [], xp: 0, activity: [], review: [], mastered: 0 };
}

function normalizeProgress(p) {
    const base = emptyProgress();
    if (!p || typeof p !== 'object') return base;
    return {
        v: 1,
        owner: typeof p.owner === 'string' ? p.owner : null,
        updatedAt: Number(p.updatedAt) || 0,
        levels: (p.levels && typeof p.levels === 'object' && !Array.isArray(p.levels)) ? p.levels : base.levels,
        history: Array.isArray(p.history) ? p.history : base.history,
        xp: Number(p.xp) || 0,
        activity: Array.isArray(p.activity) ? p.activity : base.activity,
        review: Array.isArray(p.review) ? p.review : base.review,
        mastered: Number(p.mastered) || 0
    };
}

let progress = normalizeProgress(storageGet(localStorage, PROGRESS_KEY));

// Ghi tiến độ xuống trình duyệt và (nếu đã đăng nhập) lên đám mây
function touchProgress() {
    progress.updatedAt = Date.now();
    progress.history = progress.history.slice(-100);
    progress.activity = progress.activity.slice(-120);
    storageSet(localStorage, PROGRESS_KEY, progress);
    scheduleSyncUp();
}

function resetProgress(removeStored) {
    progress = emptyProgress();
    if (removeStored) storageRemove(localStorage, PROGRESS_KEY);
}

// ---------- Ngày tháng (dạng YYYY-MM-DD theo giờ máy) ----------
function ymd(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addDaysYmd(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    return ymd(new Date(y, m - 1, d + n));
}

// ---------- Ôn tập giãn cách (Leitner) ----------
// Trả lời sai: về hộp 1. Trả lời đúng: lên hộp kế tiếp; đúng ở hộp cuối thì "đã thuộc" và rời hàng đợi.
function leitnerAfter(box, correct) {
    if (!correct) return { box: 1, removed: false };
    if (box >= MAX_BOX) return { box: box, removed: true };
    return { box: box + 1, removed: false };
}
function dueAfter(todayYmd, box) { return addDaysYmd(todayYmd, REVIEW_INTERVALS[box] || 1); }

function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}
function questionId(q) { return hashStr(q.question + '|' + q.options.slice().sort().join('|')); }

// Câu làm sai được đưa vào hàng đợi, ôn lại sau 1 ngày
function addToReview(q, key) {
    const id = questionId(q);
    const item = {
        id, q: q.question, options: q.options.slice(), answer_index: q.answer_index,
        explanation: q.explanation || '', source: q.source || '', key: key || '',
        box: 1, due: addDaysYmd(ymd(), 1), added: Date.now()
    };
    const idx = progress.review.findIndex(r => r.id === id);
    if (idx >= 0) progress.review[idx] = item; else progress.review.push(item);
    if (progress.review.length > MAX_REVIEW_ITEMS) {
        progress.review.sort((a, b) => a.added - b.added);
        progress.review = progress.review.slice(progress.review.length - MAX_REVIEW_ITEMS);
    }
}

function dueReviewItems(today = ymd()) {
    return progress.review.filter(r => r.due <= today).sort((a, b) => a.due.localeCompare(b.due));
}

function applyReviewAnswer(item, correct) {
    const r = leitnerAfter(item.box, correct);
    if (r.removed) {
        progress.review = progress.review.filter(x => x.id !== item.id);
        progress.mastered += 1;
    } else {
        item.box = r.box;
        item.due = dueAfter(ymd(), r.box);
    }
    return r;
}

// Số câu đến hạn ôn trong các ngày tới (không tính hôm nay)
function reviewForecast(days = 7, from = ymd()) {
    const out = [];
    for (let i = 1; i <= days; i++) {
        const date = addDaysYmd(from, i);
        out.push({ date, count: progress.review.filter(r => r.due === date).length });
    }
    return out;
}

// ---------- XP, chuỗi ngày ----------
function awardXp(n) {
    n = Math.max(0, Math.round(n));
    progress.xp += n;
    return n;
}
function quizXp(correct, total, predicted) {
    const diff = Math.abs(predicted - correct);
    return total * XP.attempt + correct * XP.correct + (diff === 0 ? XP.calibExact : diff === 1 ? XP.calibClose : 0);
}
function rankInfo() {
    return { rank: 1 + Math.floor(progress.xp / RANK_XP), into: progress.xp % RANK_XP, need: RANK_XP };
}
function recordActivity() {
    const t = ymd();
    if (!progress.activity.includes(t)) progress.activity.push(t);
}
// Chuỗi vẫn còn nếu hôm qua có học (chưa học hôm nay không làm mất chuỗi)
function currentStreak(today = ymd()) {
    const days = new Set(progress.activity);
    let d = days.has(today) ? today : addDaysYmd(today, -1);
    let n = 0;
    while (days.has(d)) { n++; d = addDaysYmd(d, -1); }
    return n;
}

// ============================================================
// ĐỒNG BỘ SUPABASE
//  - progress.owner ghi lại tài khoản sở hữu bản tiến độ trên máy này
//  - đăng nhập tài khoản khác: bản của người trước bị bỏ, không bao giờ trộn vào tài khoản mới
//  - hai bản khác nhau: bản có updatedAt mới hơn thắng (last-write-wins)
// ============================================================
let syncTimer = null, syncWarned = false;

function cloudReady() { return !!(state.session && state.session.access_token); }
function hasProgressContent(p) { return !!(p.history.length || p.review.length || p.xp); }

function warnSync(msg) {
    if (syncWarned) return;
    syncWarned = true;
    showToast('⚠️ Chưa đồng bộ được tiến độ lên đám mây: ' + msg);
}

function scheduleSyncUp() {
    if (!cloudReady()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncUp, SYNC_DELAY_MS);
}

async function syncUp() {
    if (!cloudReady()) return;
    if (progress.owner !== state.session.user_id) {
        progress.owner = state.session.user_id;
        storageSet(localStorage, PROGRESS_KEY, progress);
    }
    try {
        const data = await postJSON('/api/progress/save', { session: state.session, progress: progress });
        if (handleSessionReply(data)) return;
        if (!data.ok) warnSync(data.error);
    } catch (err) {
        warnSync(err.message);
    }
}

async function syncDown() {
    if (!cloudReady()) return;
    const uid = state.session.user_id;
    try {
        const data = await postJSON('/api/progress/load', { session: state.session });
        if (handleSessionReply(data)) return;
        if (!data.ok) { warnSync(data.error); return; }
        if (progress.owner && progress.owner !== uid) resetProgress(true);   // bản của tài khoản khác trên máy này
        const cloud = data.progress ? normalizeProgress(data.progress) : null;
        if (cloud && cloud.updatedAt > progress.updatedAt) {
            progress = cloud;
            progress.owner = uid;
            storageSet(localStorage, PROGRESS_KEY, progress);
        } else {
            progress.owner = uid;
            if (hasProgressContent(progress)) await syncUp();
        }
        emit('progressChanged');
    } catch (err) {
        warnSync(err.message);
    }
}

// ---------- Đăng ký sự kiện ----------
onEvent('loggedIn', syncDown);
onEvent('dataCleared', wipeAll => {
    if (wipeAll) resetProgress(true);       // xóa tài khoản: xóa luôn tiến độ; đăng xuất thì giữ tiến độ trên máy này
});
onEvent('focusDone', () => {
    const gained = awardXp(XP.focus);
    recordActivity();
    touchProgress();
    showToast(`🧠 Xong phiên tập trung! +${gained} XP. Vào mục Quiz để tự kiểm tra nhé.`);
});
window.addEventListener('DOMContentLoaded', () => { if (cloudReady()) syncDown(); });
