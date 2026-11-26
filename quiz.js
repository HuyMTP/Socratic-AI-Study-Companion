// ============================================================
// ai.study - Gói B: Quiz tự kiểm tra, độ khó thích ứng, màn hình "Hôm nay"
// Chạy sau app.js và progress.js (dùng lại state, showToast, postJSON, navigateTo, progress, Leitner, XP...)
// Có hai chế độ: 'quiz' (tạo câu hỏi mới bằng AI) và 'review' (ôn lại câu đã sai theo lịch giãn cách)
// ============================================================
const SCHEDULE_KEY = 'aistudy.schedule';
const QUIZ_N = 5;
const DAILY_QUIZ_SOFT_LIMIT = 3;       // sau ngần này quiz/ngày, app nhắc "hôm nay đủ rồi"
const LEVEL_NAMES = { 1: 'Nhớ', 2: 'Hiểu', 3: 'Áp dụng', 4: 'Phân tích', 5: 'Vận dụng cao' };
const START_LEVEL = 2;

PAGE_META['quiz'] = { category: 'AI LEARNING', title: 'Quiz' };

let quiz = newQuizState();
function newQuizState() {
    return { mode: 'quiz', key: '', level: START_LEVEL, predicted: null, questions: [], index: 0, correct: 0, answered: false, busy: false, reviewed: 0, sessionXp: 0 };
}

// ---------- Tiện ích ----------
function el(id) { return document.getElementById(id); }
function show(id, on) { el(id).style.display = on ? 'block' : 'none'; }
function makeEl(tag, text, css) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (css) n.style.cssText = css;
    return n;
}
function todayLabel(d = new Date()) { return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`; }
function isSameDay(ts, d = new Date()) {
    const x = new Date(ts);
    return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate();
}
function quizzesToday() { return progress.history.filter(h => isSameDay(h.t)).length; }

// Khóa tiến độ: mỗi tài liệu (hoặc tài liệu + chủ đề) có cấp độ riêng
function quizKey(docChoice, topic) {
    const base = docChoice === '__all__' ? 'Tất cả tài liệu' : docChoice;
    const t = (topic || '').trim().toLowerCase().slice(0, 60);
    return t ? `${base} · ${t}` : base;
}
function levelOf(key) { return progress.levels[key] || START_LEVEL; }

function levelBar(level) {
    const bar = makeEl('div', undefined, 'display:flex; gap:4px; align-items:center;');
    for (let i = 1; i <= 5; i++) {
        const seg = makeEl('div');
        seg.className = 'level-seg' + (i <= level ? ' on' : '');
        bar.appendChild(seg);
    }
    return bar;
}

// ============================================================
// MÀN HÌNH "HÔM NAY"
// ============================================================
function daysUntil(dueText) {
    const m = String(dueText).match(/^\s*(\d{1,2})[\/\-.](\d{1,2})/);
    if (!m) return null;
    const now = new Date(); now.setHours(0, 0, 0, 0);
    let due = new Date(now.getFullYear(), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    if (due < now && (now - due) / 86400000 > 60) due = new Date(now.getFullYear() + 1, due.getMonth(), due.getDate());
    return Math.round((due - now) / 86400000);
}

function todaySection(title) {
    const wrap = makeEl('div', undefined, 'margin-bottom:18px;');
    wrap.appendChild(makeEl('div', title, "font-family:'JetBrains Mono',monospace; font-size:0.72rem; letter-spacing:0.06em; text-transform:uppercase; color:var(--text-secondary); margin-bottom:8px;"));
    return wrap;
}
function todayLine(text, muted) {
    return makeEl('div', text, 'font-size:0.88rem; padding:6px 0; border-bottom:1px solid var(--border-subtle);' + (muted ? ' color:var(--text-muted);' : ''));
}

function renderToday() {
    const box = el('todayCard');
    if (!box) return;
    box.innerHTML = '';

    const head = makeEl('div', undefined, 'display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:10px; flex-wrap:wrap;');
    const t = makeEl('div');
    t.appendChild(makeEl('div', 'HÔM NAY', "font-family:'JetBrains Mono',monospace; font-size:0.72rem; letter-spacing:0.08em; color:var(--text-secondary);"));
    t.appendChild(makeEl('h3', `Việc cần làm hôm nay (${todayLabel()})`, 'font-size:1.15rem; font-weight:700; margin-top:4px;'));
    head.appendChild(t);
    const actions = makeEl('div', undefined, 'display:flex; gap:10px; flex-wrap:wrap;');
    const quizBtn = makeEl('button', '🧠 Làm quiz 5 câu'); quizBtn.className = 'btn-white-pill'; quizBtn.onclick = () => navigateTo('quiz');
    const focusBtn = makeEl('button', '⏱️ Phiên tập trung'); focusBtn.className = 'btn-dark-pill'; focusBtn.onclick = () => navigateTo('focus-mode');
    actions.append(quizBtn, focusBtn);
    head.appendChild(actions);
    box.appendChild(head);

    const info = rankInfo(), streak = currentStreak();
    const stat = makeEl('div', undefined, 'display:flex; gap:18px; flex-wrap:wrap; align-items:center; margin-bottom:18px; font-size:0.86rem;');
    stat.appendChild(makeEl('span', `⭐ ${progress.xp} XP · Bậc ${info.rank}`, 'font-weight:600;'));
    const track = makeEl('div', undefined, 'width:120px; height:6px; border-radius:3px; background:rgba(255,255,255,0.12); overflow:hidden;');
    track.appendChild(makeEl('div', undefined, `height:100%; width:${Math.round(info.into / info.need * 100)}%; background:var(--accent-white);`));
    stat.appendChild(track);
    stat.appendChild(makeEl('span', streak > 0 ? `🔥 ${streak} ngày liên tiếp` : 'Học hôm nay để bắt đầu chuỗi ngày', 'color:var(--text-secondary);'));
    if (progress.mastered > 0) stat.appendChild(makeEl('span', `🎓 Đã thuộc ${progress.mastered} câu`, 'color:var(--text-secondary);'));
    box.appendChild(stat);

    const grid = makeEl('div', undefined, 'display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:22px;');

    // 1. Buổi tự học hôm nay (từ lịch đã xếp)
    const s1 = todaySection('Buổi tự học');
    const label = todayLabel();
    const sessions = (state.scheduleResult || []).filter(r => String(r['Ngày']).endsWith(label));
    if (sessions.length) sessions.forEach(r => s1.appendChild(todayLine(`${r['Khung giờ']}  ·  ${r['Nội dung']}`)));
    else {
        s1.appendChild(todayLine('Chưa có buổi tự học nào cho hôm nay.', true));
        const b = makeEl('button', '✨ Xếp lịch tự học', 'margin-top:10px;'); b.className = 'btn-dark-pill'; b.onclick = () => navigateTo('ai-scheduler');
        s1.appendChild(b);
    }
    grid.appendChild(s1);

    // 2. Sắp đến hạn
    const s2 = todaySection('Sắp đến hạn');
    const soon = collectTable('dlBody')
        .map(r => ({ name: r[0], subject: r[1], days: daysUntil(r[2]) }))
        .filter(r => r.days !== null && r.days >= 0)
        .sort((a, b) => a.days - b.days).slice(0, 3);
    if (soon.length) soon.forEach(r => s2.appendChild(todayLine(`${r.name}${r.subject ? ' (' + r.subject + ')' : ''}  ·  ${r.days === 0 ? 'hôm nay' : 'còn ' + r.days + ' ngày'}`)));
    else s2.appendChild(todayLine('Không có deadline nào sắp tới.', true));
    grid.appendChild(s2);

    // 3. Ôn tập giãn cách
    const s4 = todaySection('Ôn tập giãn cách');
    const dueN = dueReviewItems().length;
    s4.appendChild(todayLine(dueN ? `${dueN} câu cần ôn hôm nay` : 'Hôm nay chưa có câu nào cần ôn.', !dueN));
    const fc = reviewForecast(7).filter(f => f.count > 0).slice(0, 4);
    if (fc.length) s4.appendChild(makeEl('div', 'Sắp tới: ' + fc.map(f => `${f.date.slice(8, 10)}/${f.date.slice(5, 7)} (${f.count})`).join(', '), 'font-size:0.8rem; color:var(--text-secondary); padding-top:6px;'));
    if (dueN) {
        const rb = makeEl('button', '🔁 Ôn tập ngay', 'margin-top:10px;'); rb.className = 'btn-white-pill'; rb.onclick = () => { navigateTo('quiz'); startReview(); };
        s4.appendChild(rb);
    }
    grid.appendChild(s4);

    // 4. Tiến độ kiến thức
    const s3 = todaySection('Cấp độ kiến thức');
    const recent = [];
    for (let i = progress.history.length - 1; i >= 0 && recent.length < 3; i--) {
        if (!recent.includes(progress.history[i].key)) recent.push(progress.history[i].key);
    }
    if (recent.length) {
        recent.forEach(k => {
            const row = makeEl('div', undefined, 'padding:6px 0; border-bottom:1px solid var(--border-subtle);');
            row.appendChild(makeEl('div', k, 'font-size:0.84rem; margin-bottom:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'));
            const line = makeEl('div', undefined, 'display:flex; justify-content:space-between; align-items:center;');
            line.appendChild(levelBar(levelOf(k)));
            line.appendChild(makeEl('span', `Cấp ${levelOf(k)}/5`, 'font-size:0.78rem; color:var(--text-secondary);'));
            row.appendChild(line);
            s3.appendChild(row);
        });
    } else s3.appendChild(todayLine('Làm quiz đầu tiên để xem cấp độ của bạn.', true));
    const n = quizzesToday();
    s3.appendChild(makeEl('div', n >= DAILY_QUIZ_SOFT_LIMIT ? `Hôm nay bạn đã làm ${n} quiz: đủ rồi, mai ôn tiếp nhé.` : `Hôm nay: ${n} quiz đã làm.`,
        'font-size:0.8rem; color:var(--text-secondary); margin-top:10px;'));
    grid.appendChild(s3);

    box.appendChild(grid);
}

// ============================================================
// QUIZ
// ============================================================
function docOptions() {
    return state.uploadedDocs.map(d => d.name);
}

function currentChoice() { return el('quizDoc').value; }

function updateLevelInfo() {
    const info = el('quizLevelInfo');
    if (!docOptions().length) { info.textContent = 'Hãy tải tài liệu ở mục My Materials trước khi làm quiz.'; return; }
    const key = quizKey(currentChoice(), el('quizTopic').value);
    const level = levelOf(key);
    const n = quizzesToday();
    info.textContent = `Cấp độ hiện tại: ${level}/5 (${LEVEL_NAMES[level]}). Đúng gần hết thì cấp tăng, sai nhiều thì cấp giảm, để câu hỏi luôn vừa sức.`
        + (n >= DAILY_QUIZ_SOFT_LIMIT ? ` Hôm nay bạn đã làm ${n} quiz, nghỉ một chút rồi ôn tiếp ngày mai sẽ nhớ lâu hơn.` : '');
}

function renderReviewBox() {
    const box = el('reviewBox');
    if (!box) return;
    box.innerHTML = '';
    const due = dueReviewItems().length, total = progress.review.length;
    const row = makeEl('div', undefined, 'display:flex; justify-content:space-between; align-items:center; gap:14px; flex-wrap:wrap;');
    const left = makeEl('div');
    left.appendChild(makeEl('div', 'ÔN TẬP GIÃN CÁCH', "font-family:'JetBrains Mono',monospace; font-size:0.72rem; letter-spacing:0.06em; color:var(--text-secondary); margin-bottom:6px;"));
    left.appendChild(makeEl('div', due ? `${due} câu cần ôn hôm nay (tổng ${total} câu trong hàng đợi)` : (total ? `Hôm nay không có câu nào đến hạn (${total} câu đang chờ)` : 'Câu bạn làm sai sẽ tự vào đây và quay lại sau 1, 3, 7, 14 ngày.'), 'font-size:0.9rem;'));
    row.appendChild(left);
    const b = makeEl('button', '🔁 Ôn tập ngay'); b.className = 'btn-white-pill'; b.disabled = !due; b.onclick = startReview;
    row.appendChild(b);
    box.appendChild(row);
}

function renderQuizSetup() {
    quiz.mode = 'quiz';
    renderReviewBox();
    show('quizSetup', true); show('quizLoading', false); show('quizRun', false); show('quizResult', false);
    const sel = el('quizDoc');
    const prev = sel.value;
    sel.innerHTML = '';
    const docs = docOptions();
    if (docs.length > 1) { const o = makeEl('option', `Tất cả tài liệu (${docs.length})`); o.value = '__all__'; sel.appendChild(o); }
    docs.forEach(name => { const o = makeEl('option', name); o.value = name; sel.appendChild(o); });
    if (prev && Array.from(sel.children).some(o => o.value === prev)) sel.value = prev;
    sel.onchange = updateLevelInfo;
    el('quizTopic').oninput = updateLevelInfo;

    const pr = el('quizPredict');
    pr.innerHTML = '';
    for (let i = 0; i <= QUIZ_N; i++) {
        const b = makeEl('button', String(i)); b.type = 'button'; b.className = 'predict-btn' + (quiz.predicted === i ? ' selected' : '');
        b.onclick = () => { quiz.predicted = i; renderQuizSetup(); };
        pr.appendChild(b);
    }
    el('quizStartBtn').disabled = !docs.length;
    updateLevelInfo();
}

async function startQuiz() {
    if (quiz.busy) return;
    const docs = state.uploadedDocs;
    if (!docs.length) { showToast('⚠️ Hãy tải tài liệu ở My Materials trước.'); return; }
    if (quiz.predicted === null) { showToast('⚠️ Hãy chọn trước bạn đoán mình đúng mấy câu.'); return; }

    const choice = currentChoice();
    const topic = el('quizTopic').value.trim();
    const chosen = choice === '__all__' ? docs : docs.filter(d => d.name === choice);
    const context = chosen.map(d => d.content.trim()).join('\n\n').slice(0, MAX_CONTEXT_CHARS);
    quiz.key = quizKey(choice, topic);
    quiz.level = levelOf(quiz.key);

    quiz.busy = true;
    show('quizSetup', false); show('quizLoading', true);
    try {
        const data = await postJSON('/api/quiz/generate', { context_text: context, topic: topic, level: quiz.level, n: QUIZ_N });
        if (!data.ok) throw new Error(data.error);
        quiz.questions = data.questions; quiz.index = 0; quiz.correct = 0; quiz.answered = false;
        show('quizLoading', false); show('quizRun', true);
        renderQuestion();
    } catch (err) {
        showToast(String(err.message).startsWith('⚠️') ? err.message : '⚠️ Không tạo được quiz: ' + err.message);
        renderQuizSetup();
    } finally {
        quiz.busy = false;
    }
}

function startReview() {
    if (quiz.busy) return;
    const items = dueReviewItems().slice(0, 10);
    if (!items.length) { showToast('Hôm nay chưa có câu nào cần ôn.'); return; }
    quiz = newQuizState();
    quiz.mode = 'review';
    quiz.questions = items.map(it => ({ question: it.q, options: it.options, answer_index: it.answer_index, explanation: it.explanation, source: it.source, _item: it }));
    show('quizSetup', false); show('quizLoading', false); show('quizResult', false); show('quizRun', true);
    renderQuestion();
}

function renderQuestion() {
    const q = quiz.questions[quiz.index];
    quiz.answered = false;
    el('quizProgressText').textContent = quiz.mode === 'review'
        ? `Ôn tập  ·  Câu ${quiz.index + 1}/${quiz.questions.length}  ·  Hộp ${q._item.box}/4`
        : `Câu ${quiz.index + 1}/${quiz.questions.length}  ·  Cấp ${quiz.level}/5 (${LEVEL_NAMES[quiz.level]})`;
    el('quizQuestionText').textContent = q.question;
    const box = el('quizOptions');
    box.innerHTML = '';
    q.options.forEach((opt, i) => {
        const b = makeEl('button', `${'ABCD'[i]}.  ${opt}`);
        b.type = 'button'; b.className = 'quiz-option';
        b.onclick = () => chooseOption(i);
        box.appendChild(b);
    });
    el('quizFeedback').style.display = 'none';
    el('quizNextBtn').style.display = 'none';
}

function chooseOption(i) {
    if (quiz.answered) return;
    quiz.answered = true;
    const q = quiz.questions[quiz.index];
    const ok = i === q.answer_index;
    if (ok) quiz.correct++;
    if (quiz.mode === 'review') {
        const r = applyReviewAnswer(q._item, ok);
        quiz.reviewed++;
        quiz.sessionXp += awardXp(XP.reviewAttempt + (ok ? XP.reviewCorrect : 0));
        recordActivity();
        touchProgress();
        q._after = r.removed ? 'Bạn đã thuộc câu này, nó rời khỏi hàng đợi ôn tập. 🎓' : ok ? `Sẽ gặp lại sau ${REVIEW_INTERVALS[r.box]} ngày.` : 'Sẽ gặp lại vào ngày mai.';
    } else if (!ok) {
        addToReview(q, quiz.key);       // câu sai vào hàng đợi ôn tập, ôn lại sau 1 ngày
    }
    Array.from(el('quizOptions').children).forEach((b, idx) => {
        b.disabled = true;
        if (idx === q.answer_index) b.classList.add('correct');
        else if (idx === i) b.classList.add('wrong');
        else b.classList.add('dim');
    });
    const fb = el('quizFeedback');
    fb.innerHTML = '';
    fb.appendChild(makeEl('div', ok ? '✅ Chính xác!' : '❌ Chưa đúng. Đáp án đúng là ' + 'ABCD'[q.answer_index] + '.', 'font-weight:700; margin-bottom:6px;'));
    if (q.explanation) fb.appendChild(makeEl('div', q.explanation, 'font-size:0.88rem; line-height:1.55;'));
    if (q.source) fb.appendChild(makeEl('div', 'Nguồn: ' + q.source, 'font-size:0.78rem; color:var(--text-secondary); margin-top:6px;'));
    if (q._after) fb.appendChild(makeEl('div', q._after, 'font-size:0.8rem; color:var(--text-secondary); margin-top:6px;'));
    else if (!ok) fb.appendChild(makeEl('div', 'Câu này đã vào hàng đợi ôn tập, bạn sẽ gặp lại vào ngày mai.', 'font-size:0.8rem; color:var(--text-secondary); margin-top:6px;'));
    fb.style.display = 'block';
    const next = el('quizNextBtn');
    next.textContent = quiz.index + 1 < quiz.questions.length ? 'Câu tiếp theo ➔' : 'Xem kết quả ➔';
    next.style.display = 'inline-flex';
}

function nextQuestion() {
    if (!quiz.answered) return;
    if (quiz.index + 1 < quiz.questions.length) { quiz.index++; renderQuestion(); }
    else finishQuiz();
}

function calibrationMessage(predicted, actual) {
    const diff = predicted - actual;
    if (diff === 0) return `Bạn đoán đúng ${predicted} câu và thực tế cũng ${actual} câu: bạn đánh giá bản thân rất sát.`;
    if (diff > 0) return `Bạn đoán ${predicted} nhưng thực tế ${actual}: bạn tự tin hơn kết quả ${diff} câu. Phần ${diff} câu đó đáng để xem lại, vì cảm giác "hiểu rồi" chưa chắc là hiểu thật.`;
    return `Bạn đoán ${predicted} nhưng thực tế ${actual}: bạn đang đánh giá thấp bản thân ${-diff} câu.`;
}

async function finishReview() {
    const total = quiz.questions.length;
    show('quizRun', false); show('quizResult', true);
    el('quizScoreText').textContent = `${quiz.correct}/${total} câu đúng`;
    el('quizCalibration').textContent = 'Câu đúng được giãn ra xa hơn (1 → 3 → 7 → 14 ngày), câu sai quay lại vào ngày mai. Ôn đều đặn như vậy giúp nhớ lâu hơn học dồn.';
    el('quizLevelResult').textContent = `+${quiz.sessionXp} XP · còn ${dueReviewItems().length} câu cần ôn hôm nay.`;
    quiz = newQuizState();
    emit('progressChanged');
}

async function finishQuiz() {
    if (quiz.mode === 'review') return finishReview();
    const total = quiz.questions.length;
    let newLevel = quiz.level, change = 'same';
    try {
        const r = await postJSON('/api/quiz/result', { level: quiz.level, correct: quiz.correct, total: total });
        newLevel = r.new_level; change = r.change;
    } catch (err) {
        showToast('⚠️ Không cập nhật được cấp độ: ' + err.message);
    }
    const capped = quizzesToday() >= DAILY_QUIZ_SOFT_LIMIT;      // quá số quiz mỗi ngày thì không cộng XP nữa
    const gained = capped ? 0 : awardXp(quizXp(quiz.correct, total, quiz.predicted));
    progress.levels[quiz.key] = newLevel;
    progress.history.push({ t: Date.now(), key: quiz.key, level: quiz.level, correct: quiz.correct, total: total, predicted: quiz.predicted });
    recordActivity();
    touchProgress();

    show('quizRun', false); show('quizResult', true);
    el('quizScoreText').textContent = `${quiz.correct}/${total} câu đúng`;
    el('quizCalibration').textContent = calibrationMessage(quiz.predicted, quiz.correct);
    const msg = change === 'up' ? `🎉 Cấp độ tăng lên ${newLevel}/5 (${LEVEL_NAMES[newLevel]}).`
        : change === 'down' ? `Cấp độ giảm xuống ${newLevel}/5 (${LEVEL_NAMES[newLevel]}) để câu hỏi vừa sức hơn.`
        : `Cấp độ giữ nguyên ở ${newLevel}/5 (${LEVEL_NAMES[newLevel]}).`;
    el('quizLevelResult').textContent = msg + (capped ? ' Hôm nay bạn đã đủ XP từ quiz, mai ôn tiếp nhé.' : ` +${gained} XP.`);
    quiz = newQuizState();
    renderToday();
}

// ============================================================
// ĐĂNG KÝ SỰ KIỆN (xem emit/onEvent trong app.js)
// ============================================================
onEvent('pageShown', pageId => {
    if (pageId === 'quiz') renderQuizSetup();
    if (pageId === 'dashboard') renderToday();
});
onEvent('dataChanged', renderToday);
onEvent('progressChanged', () => {
    renderToday();
    if (el('quizSetup') && el('quizSetup').style.display !== 'none') renderQuizSetup();
});
onEvent('scheduleGenerated', () => {
    storageSet(localStorage, SCHEDULE_KEY, state.scheduleResult);
    renderToday();
});
onEvent('focusDone', renderToday);
onEvent('dataCleared', () => {
    storageRemove(localStorage, SCHEDULE_KEY);   // tiến độ được progress.js xử lý (xóa tài khoản thì xóa, đăng xuất thì giữ)
    quiz = newQuizState();
    if (el('quizSetup')) renderQuizSetup();
    renderToday();
});

window.addEventListener('DOMContentLoaded', () => {
    const saved = storageGet(localStorage, SCHEDULE_KEY);
    if (Array.isArray(saved)) state.scheduleResult = saved;
    renderToday();
});
