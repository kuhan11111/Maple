// DOM rendering. Everything here is derived from `state` / `rt`; user actions are wired in app.js
// through data-act attributes.

import { state, rt, COLORS, computeAdvice, isOnline, watched } from './store.js';
import { LEVELS, COLS } from './solver.js';
import { summarize, predictNext } from './stats.js';

export const $ = (s) => document.querySelector(s);
export const CIRC = ['①', '②', '③', '④'];
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const pname = (p) => esc(state.names[p] || `玩家 ${p + 1}`);
const pc = (p) => `style="--pc:${COLORS[p]}"`;
const clock = (t) => new Date(t).toLocaleTimeString('zh-TW', { hour12: false });
const pct = (x) => `${Math.round(x * 100)}%`;

// ---- advice cards -------------------------------------------------------------------

function hintFor(pl, advice) {
  if (!pl.testLevel || pl.cands.length < 2) return '';
  const prefix = [];
  for (let L = 1; L < pl.testLevel; L++) {
    const c = advice.analysis[L].cands[pl.player];
    if (c.length !== 1) return '';
    prefix.push(c[0]);
  }
  const pred = predictNext(rt.data.runs, prefix, { excludeRun: state.runId });
  if (!pred || pred.matches < 2 || pred.share < 0.6 || !pl.cands.includes(pred.next)) return '';
  return `<div class="hint">📊 歷史 ${pred.matches} 筆相同開頭,${pct(pred.share)} 是第 ${pred.next + 1} 平台</div>`;
}

function cardHTML(pl, advice) {
  const p = pl.player;
  const P = rt.engine.players[p];
  const t = pl.test;
  const chosen = rt.chosen[p] && rt.chosen[p].level === pl.testLevel ? rt.chosen[p].col : null;
  const target = t ? { level: t.level, col: chosen ?? t.col } : null;
  let big;
  let cls = 'go';
  if (pl.done) [big, cls] = ['🎉 已到第 10 層', 'done'];
  else if (t && pl.ready) big = `試 Lv${t.level} · 第 ${(chosen ?? t.col) + 1} 平台`;
  else if (t) big = `走到 Lv${pl.testLevel - 1},再試 Lv${t.level} 第 ${(chosen ?? t.col) + 1} 平台`;
  else if (pl.wait) [big, cls] = [`待命 — 隊友正在測 Lv${pl.testLevel}`, 'wait'];
  else [big, cls] = ['路徑全知 → 一路走到 Lv10', 'go'];

  const route = pl.route.length
    ? `<div class="chips"><span class="sub">已知路徑</span>${pl.route.map((s) => `<span class="chip route">Lv${s.level}${CIRC[s.col]}</span>`).join('')}</div>`
    : '';
  const cands =
    pl.testLevel && pl.cands.length > 1
      ? `<div class="chips"><span class="sub">Lv${pl.testLevel} 可能</span>${pl.cands
          .map((c) => `<button class="chip ${c === (chosen ?? t?.col) ? 'on' : ''}" data-act="choose" data-p="${p}" data-l="${pl.testLevel}" data-c="${c}" title="改試這個平台">${CIRC[c]}</button>`)
          .join('')}</div>`
      : '';
  const status =
    state.mode === 'auto' && watched(p) && P.lost ? '<span class="sub">畫面中找不到名牌</span>' : '';
  const dis = target ? '' : 'disabled';
  return `<article class="card" ${pc(p)}>
    <header><span class="name">${pname(p)}${state.me === p ? ' <span class="me-tag">我</span>' : ''}</span>${state.me !== null && state.me !== p ? `<i class="net ${isOnline(p) ? 'on' : ''}" title="${isOnline(p) ? '隊友在線' : '隊友未連線'}"></i>` : ''}<span class="lv">Lv${P.level}${P.col !== null && P.level ? CIRC[P.col] : ''}</span></header>
    <div class="big ${cls}">${big}</div>
    ${route}${cands}${hintFor(pl, advice)}${status}
    <div class="acts manual-main">
      <button class="btn pass" ${dis} data-act="ok" data-p="${p}" title="按↑後沒被傳走">✔ 成功</button>
      <button class="btn fail" ${dis} data-act="bad" data-p="${p}" title="按↑後被傳回最底層">✘ 被傳回底層</button>
      <button class="btn ghost sm" data-act="bottom" data-p="${p}" title="自己跳下去了,不是平台錯">摔回底層</button>
    </div>
  </article>`;
}

// ---- board --------------------------------------------------------------------------

function boardHTML(advice) {
  const head = `<div class="brow"><div class="lab"></div>${CIRC.map((c) => `<div class="bcell head">${c}</div>`).join('')}</div>`;
  let rows = '';
  for (let L = LEVELS; L >= 1; L--) {
    const a = advice.analysis[L];
    let anyKnown = false;
    const cells = [];
    for (let c = 0; c < COLS; c++) {
      let dots = '';
      let known = false;
      for (let p = 0; p < state.n; p++) {
        const cands = a.cands[p];
        let cls = cands.includes(c) ? (cands.length === 1 ? 'ok' : 'cand') : 'x';
        if (cls === 'ok') known = true;
        const pl = advice.plans[p];
        if (pl.test && pl.test.level === L && pl.test.col === c) cls += ' star';
        const P = rt.engine.players[p];
        if (P.level === L && P.col === c) cls += ' here';
        const label = cls.startsWith('ok') ? '確定' : cls.startsWith('x') ? '排除' : '可能';
        dots += `<button class="dot ${cls}" ${pc(p)} data-act="dot" data-p="${p}" data-l="${L}" data-c="${c}" title="${state.names[p]}:${label}"></button>`;
      }
      anyKnown ||= known;
      cells.push(`<div class="bcell ${known ? 'known' : ''}">${dots}</div>`);
    }
    rows += `<div class="brow"><div class="lab ${a.conflict ? 'conflict' : ''}" title="${a.conflict ? '此層紀錄互相矛盾' : ''}">${a.conflict ? '⚠' : ''}Lv${L}</div>${cells.join('')}</div>`;
  }
  return head + rows;
}

// ---- log ----------------------------------------------------------------------------

function logHTML() {
  if (!state.log.length) return '<li class="empty-note">還沒有紀錄。偵測到或手動登記的結果會出現在這裡。</li>';
  return state.log
    .slice()
    .reverse()
    .slice(0, 80)
    .map(
      (e) => `<li ${pc(e.player)}><span class="t">${clock(e.t)}</span><b>${pname(e.player)}</b> Lv${e.level} ${CIRC[e.col]}
      <span class="${e.type}">${e.type === 'ok' ? '✔ 成功' : '✘ 失敗'}</span><small>${e.source === 'auto' ? '自動' : '手動'}</small>
      <button data-act="del" data-id="${e.id}" title="刪除這筆(會重新推論)">✕</button></li>`,
    )
    .join('');
}

// ---- voice --------------------------------------------------------------------------

function speak(advice) {
  advice.plans.forEach((pl) => {
    const key = pl.ready && pl.test ? `${pl.test.level}:${pl.test.col}` : '';
    if (key && key !== rt.spoken?.[pl.player] && state.settings.voice && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(`${state.names[pl.player]},${pl.test.level}層,${pl.test.col + 1}號`);
      u.lang = 'zh-TW';
      speechSynthesis.speak(u);
    }
    (rt.spoken ??= [])[pl.player] = key;
  });
}

// ---- main render --------------------------------------------------------------------

export function render() {
  const advice = computeAdvice();
  $('#cards').innerHTML = advice.plans.map((pl) => cardHTML(pl, advice)).join('');
  $('#board').innerHTML = boardHTML(advice);
  $('#log').innerHTML = logHTML();
  const warn = $('#warn');
  warn.hidden = !advice.conflicts.length;
  if (advice.conflicts.length) warn.textContent = `⚠ Lv${advice.conflicts.join('、Lv')} 的紀錄互相矛盾(可能是偵測誤判),請到事件紀錄刪除錯誤的那一筆。`;
  speak(advice);
  renderToasts();
  const s = summarize(rt.data.runs);
  $('#statsBrief').textContent = `${s.runs} 輪 · ${s.paths} 條路徑`;
  if ($('#statsPanel').open) renderStats(s);
}

// ---- team ---------------------------------------------------------------------------

export function renderTeam() {
  $('#team').innerHTML = Array.from({ length: state.n }, (_, p) => {
    const t = state.tpls[p];
    return `<div class="member" ${pc(p)}>
      <i class="swatch"></i>
      <input type="text" data-act="name" data-p="${p}" value="${esc(state.names[p])}" maxlength="12" aria-label="玩家 ${p + 1} 名稱">
      <canvas id="tpl${p}" width="${t ? t.w : 1}" height="${t ? t.h : 1}" ${t ? '' : 'hidden'}></canvas>
      ${watched(p) ? `<button class="btn sm auto-only" data-act="pickTpl" data-p="${p}">${t ? '重新框選' : '框選名牌'}</button>` : `<span class="muted seatnote" data-seat="${p}">${isOnline(p) ? '隊友在線' : '隊友(未連線)'}</span>`}
      <div class="st auto-only" id="ps${p}">${watched(p) && !t ? '尚未框選名牌' : ''}</div>
    </div>`;
  }).join('');
  state.tpls.slice(0, state.n).forEach((t, p) => {
    if (!t) return;
    const cv = $(`#tpl${p}`);
    const img = cv.getContext('2d').createImageData(t.w, t.h);
    for (let i = 0; i < t.raw.length; i++) img.data.set([t.raw[i], t.raw[i], t.raw[i], 255], i * 4);
    cv.getContext('2d').putImageData(img, 0, 0);
  });
}

export function setPlayerStatus(p, text, cls = '') {
  const el = $(`#ps${p}`);
  if (el && el.textContent !== text) {
    el.textContent = text;
    el.className = `st auto-only ${cls}`;
  }
}

// ---- settings -----------------------------------------------------------------------

const SECTIONS = [
  { h: '規則' },
  { k: 'rule', top: true, label: '答案規則', type: 'select', opts: [['latin', '每人答案不同(隊友互斥)'], ['shared', '全隊共用同一答案']], help: '進去實測一次:同一層你和隊友成功的平台不同 → 互斥' },
  { k: 'n', top: true, label: '隊伍人數', type: 'number', min: 1, max: 4 },
  { k: 'maxTesters', top: true, label: '同時試的人數(共用規則)', type: 'number', min: 1, max: 4 },
  { h: '自動偵測', auto: true },
  { k: 'procWidth', label: '分析畫面寬度', type: 'select', opts: [[640, '640'], [960, '960'], [1280, '1280'], [1600, '1600']], num: true },
  { k: 'fps', label: '偵測幀率', type: 'select', opts: [[8, '8'], [12, '12'], [16, '16'], [20, '20']], num: true },
  { k: 'matchThreshold', label: '名牌比對門檻', type: 'range', min: 0.5, max: 0.95, step: 0.01 },
  { k: 'tagOffsetY', label: '名牌 → 腳底偏移(px)', type: 'number', min: -20, max: 60 },
  { k: 'tolY', label: '平台高度容許(%)', type: 'number', min: 10, max: 50 },
  { k: 'tolX', label: '平台左右容許(%)', type: 'number', min: 30, max: 100 },
  { k: 'touchMs', label: '站定判定(ms)', type: 'number', min: 80, max: 800, step: 20 },
  { k: 'teleportMs', label: '瞬間傳送判定(ms)', type: 'number', min: 100, max: 600, step: 10, help: '站在平台上 → 這麼短時間內沒有空中畫面就出現在底層 = 被傳送(失敗)' },
  { k: 'okMode', label: '成功的推論方式', type: 'select', opts: [['both', '站著沒被傳走 或 往上一層'], ['advance', '只在往上一層時'], ['off', '不推論(成功用手動)']], help: '成功在畫面上沒有直接訊號,所以只能推論' },
  { k: 'okStandMs', label: '站著多久沒被傳走算成功(ms)', type: 'number', min: 600, max: 6000, step: 100 },
  { k: 'autoAdoptFall', label: '名牌消失後出現在底層 → 自動記為失敗', type: 'check' },
  { h: '其他' },
  { k: 'voice', label: '語音提示(報「幾層 幾號」)', type: 'check' },
  { k: 'collect', label: '收集數據(統計規律用)', type: 'check' },
];

export function renderSettings() {
  const val = (f) => (f.top ? state[f.k] : state.settings[f.k]);
  const html = SECTIONS.map((f) => {
    if (f.h) return `<h3 class="${f.auto ? 'auto-only' : ''}">${f.h}</h3>`;
    const cls = f.auto || ['procWidth', 'fps', 'matchThreshold', 'tagOffsetY', 'tolY', 'tolX', 'touchMs', 'teleportMs', 'okMode', 'okStandMs', 'autoAdoptFall'].includes(f.k) ? 'auto-only' : '';
    const v = val(f);
    let input;
    if (f.type === 'select') input = `<select data-act="set" data-k="${f.k}" data-top="${f.top ? 1 : ''}" data-num="${f.num ? 1 : ''}">${f.opts.map(([o, n]) => `<option value="${o}" ${String(o) === String(v) ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    else if (f.type === 'check') input = `<input type="checkbox" data-act="set" data-k="${f.k}" ${v ? 'checked' : ''}>`;
    else input = `<input type="${f.type}" data-act="set" data-k="${f.k}" data-top="${f.top ? 1 : ''}" data-num="1" value="${v}" min="${f.min}" max="${f.max}" step="${f.step ?? 1}">`;
    return `<label class="${f.type === 'check' ? 'chk' : ''} ${cls}">${f.type === 'check' ? input : ''}<span>${f.label}${f.help ? `<small>${f.help}</small>` : ''}</span>${f.type === 'check' ? '' : input}</label>`;
  }).join('');
  const g = state.grid;
  const gridHtml = g
    ? `<h3 class="auto-only">格線微調(畫面座標)</h3>${[['x1', '第1層最左 X'], ['y1', '第1層 Y'], ['x2', '第10層最右 X'], ['y2', '第10層 Y'], ['groundY', '起點地面 Y']]
        .map(([k, n]) => `<label class="auto-only"><span>${n}</span><input type="number" data-act="grid" data-k="${k}" value="${Math.round(g[k])}"></label>`)
        .join('')}`
    : '';
  $('#settingsForm').innerHTML = html + gridHtml;
}

// ---- stats --------------------------------------------------------------------------

export function renderStats(s = summarize(rt.data.runs)) {
  const flaggedText = s.flagged.map((f) => (f.startsWith('repeat@') ? `不同輪的前 ${f.slice(7)} 層答案重複得比隨機多` : f === 'transitions' ? '相鄰兩層的選擇不獨立' : `第 ${f.slice(5)} 層的平台分佈不均勻`));
  const verdict =
    s.verdict === 'insufficient'
      ? `資料還不夠(目前 ${s.paths} 條路徑,約 12 條以上才下判斷)。每輪結果會自動收集,多玩幾輪。`
      : s.verdict === 'random'
        ? '✅ 目前看起來像隨機:各層分佈接近均勻,不同輪之間也沒有異常重複。'
        : `🔎 有規律跡象:${flaggedText.join(';')}。`;
  const levelRows = s.levels
    .map((l) => {
      const max = Math.max(1, ...l.counts);
      const cells = l.counts.map((c) => `<td class="bar"><i style="width:${(c / max) * 100}%"></i><span>${c}${l.total ? ` · ${pct(c / l.total)}` : ''}</span></td>`).join('');
      return `<tr><th>Lv${l.level}</th>${cells}<td>${l.total}</td><td class="${l.p !== null && l.p < 0.01 ? 'sig' : ''}">${l.p === null ? '—' : l.p.toFixed(3)}</td></tr>`;
    })
    .join('');
  const repRows = s.repeats
    .filter((r) => r.paths >= 2)
    .map((r) => `<tr><th>前 ${r.prefix} 層</th><td>${r.paths}</td><td>${r.distinct}</td><td>${r.observed} / ${r.expected.toFixed(2)}</td><td class="${r.p !== null && r.p < 0.001 ? 'sig' : ''}">${r.p === null ? '—' : r.p < 0.001 ? '<0.001' : r.p.toFixed(3)}</td></tr>`)
    .join('');
  const t = s.transitions;
  $('#stats').innerHTML = `
    <div class="stat-tiles"><div class="tile"><b>${s.runs}</b>輪</div><div class="tile"><b>${s.paths}</b>條路徑</div></div>
    <div class="verdict ${s.verdict}">${verdict}</div>
    <table class="stat"><thead><tr><th>層</th>${CIRC.map((c) => `<th>${c}</th>`).join('')}<th>n</th><th>均勻性 p</th></tr></thead><tbody>${levelRows}</tbody></table>
    <p class="muted">互斥規則下每層四人各占一個平台,這張表必然接近均勻;看下面「不同輪重複」才能發現固定組合。</p>
    <table class="stat"><thead><tr><th>開頭長度</th><th>路徑數</th><th>相異數</th><th>跨輪重複對數(實際 / 隨機期望)</th><th>p</th></tr></thead><tbody>${repRows || '<tr><td colspan="5" class="muted">需要至少兩條路徑</td></tr>'}</tbody></table>
    <p class="muted">相鄰兩層選同一個平台的比例:${t.sameRate === null ? '—' : pct(t.sameRate)}(隨機約 25%)${t.p === null ? '' : `,獨立性檢定 p=${t.p.toFixed(3)}`}。</p>
    <div class="row wrap"><button class="btn sm" data-act="exportJson">匯出 JSON</button><button class="btn sm" data-act="exportCsv">匯出 CSV</button><label class="btn sm file">匯入 JSON<input type="file" accept=".json,application/json" hidden data-act="importJson"></label><button class="btn sm danger" data-act="clearData">清除數據</button></div>
    <p class="muted">資料只存在這個瀏覽器;想合併隊友的資料請互相匯出 / 匯入。</p>`;
}

// ---- toasts -------------------------------------------------------------------------

export function pushToast(t) {
  const id = ++rt.seq;
  rt.toasts.push({ id, ...t });
  renderToasts();
  if (t.kind === 'info') setTimeout(() => dismissToast(id), t.ms ?? 4000);
  return id;
}

export function dismissToast(id) {
  rt.toasts = rt.toasts.filter((x) => x.id !== id);
  renderToasts();
}

export function renderToasts() {
  $('#toasts').innerHTML = rt.toasts
    .map((t) =>
      t.kind === 'info'
        ? `<div class="toast info">${esc(t.text)}</div>`
        : `<div class="toast" ${pc(t.player)}><div><b>${pname(t.player)}</b> 的名牌消失後出現在底層(最後站在 Lv${t.level} ${CIRC[t.col]})— 是這個平台失敗嗎?</div>
        <div class="chips"><button class="btn sm fail" data-act="fallYes" data-id="${t.id}" data-c="${t.col}">✘ 是,記為 Lv${t.level} ${CIRC[t.col]} 失敗</button>
        <button class="btn sm" data-act="toastDismiss" data-id="${t.id}">不是(自己摔下去)</button></div>
        <div class="chips"><span class="sub muted">其實是:</span>${CIRC.map((c, i) => (i === t.col ? '' : `<button class="chip" data-act="fallYes" data-id="${t.id}" data-c="${i}">${c}</button>`)).join('')}</div></div>`,
    )
    .join('');
}


// ---- room panel ---------------------------------------------------------------------

export function renderRoom(connected = false) {
  $('#seatSel').value = state.me === null ? 'all' : String(state.me);
  if (document.activeElement !== $('#roomCode')) $('#roomCode').value = state.room.code;
  $('#roomVia').value = state.room.via;
  $('#btnRoom').textContent = connected ? '中斷連線' : '連線';
  $('#seatSel').disabled = $('#roomCode').disabled = $('#roomVia').disabled = connected;
  document.querySelectorAll('.seatnote').forEach((el) => {
    el.textContent = isOnline(Number(el.dataset.seat)) ? '隊友在線' : '隊友(未連線)';
  });
  $('#seats').innerHTML = Array.from({ length: state.n }, (_, p) => {
    const on = state.me === p || (connected && isOnline(p));
    return `<span class="seat ${on ? 'on' : ''} ${state.me === p ? 'me' : ''}" ${pc(p)}><i></i>${pname(p)}${state.me === p ? '(我)' : on ? '' : ' · 離線'}</span>`;
  }).join('');
}
