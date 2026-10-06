// Wiring: screen capture + calibration + detection loop, manual controls, data export.

import { state, rt, COLORS, load, save, syncEngine, rebuildTemplates, recordResult, removeEntry, resetRun, importRuns, clearData, computeAdvice, applySnapshot, mergeRemote, adoptRun, applyStatus, myStatus, snapshot, watched } from './store.js';
import { Session, BroadcastTransport, PeerTransport, loadPeerJS, encodeShare, decodeShare } from './sync.js';
import { Capture } from './capture.js';
import { Tracker, makeTemplate, toGray } from './tracker.js';
import { makeGrid, classify, gridValid } from './grid.js';
import { createSim } from './sim.js';
import { runsToCSV } from './stats.js';
import { $, CIRC, render, renderTeam, renderSettings, renderStats, renderRoom, setPlayerStatus, pushToast, dismissToast } from './ui.js';

const view = $('#view');
const vctx = view.getContext('2d', { willReadFrequently: true });
const capture = new Capture($('#video'));
const tracker = new Tracker();

const run = {
  W: 0,
  H: 0,
  detecting: false,
  frozen: null, // ImageData while calibrating
  pick: null, // {kind:'grid', pts[]} | {kind:'tpl', p, drag}
  grid: null, // built from state.grid
  hints: [], // last top-left of each tag
  pos: [], // last match per player, for the overlay
  lastGlobal: [],
  sig: '',
  demo: null,
};

const toast = (text, ms) => pushToast({ kind: 'info', text, ms });

// ---- team connection ----------------------------------------------------------------

const room = { session: null, timer: null, lastStatus: '' };

function sendStatus(force = false) {
  const st = room.session && myStatus();
  if (!st) return;
  const j = JSON.stringify(st);
  if (!force && j === room.lastStatus) return;
  room.lastStatus = j;
  room.session.sendStatus(st);
}

/** Redraw, and tell teammates if my own position / advice changed. */
function rerender() {
  render();
  sendStatus();
}

// ---- mode ---------------------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  $('#modeAuto').setAttribute('aria-pressed', String(mode === 'auto'));
  $('#modeManual').setAttribute('aria-pressed', String(mode === 'manual'));
  if (mode === 'manual') setDetecting(false);
  cancelPick();
  save();
  rerender();
}

// ---- capture ------------------------------------------------------------------------

function rebuildGrid() {
  const g = state.grid;
  run.grid = g && gridValid(makeGrid(g)) ? makeGrid(g) : null;
  if (g && run.grid && g.groundY == null) g.groundY = run.grid.groundY;
}

function ensureSize() {
  const { videoWidth: vw, videoHeight: vh } = capture.video;
  const scale = Math.min(1, state.settings.procWidth / vw);
  const W = Math.round(vw * scale) & ~1;
  const H = Math.round(vh * scale) & ~1;
  if (W === run.W && H === run.H) return;
  run.W = W;
  run.H = H;
  view.width = W;
  view.height = H;
  $('.stage').style.aspectRatio = `${W} / ${H}`;
  $('#capInfo').textContent = `已連線 ${vw}×${vh} → 分析 ${W}×${H}`;
  if (state.grid && state.grid.procW && state.grid.procW !== W) {
    const k = W / state.grid.procW;
    for (const key of ['x1', 'y1', 'x2', 'y2', 'groundY']) if (state.grid[key] != null) state.grid[key] *= k;
    renderSettings();
  }
  if (state.grid) state.grid.procW = W;
  rebuildGrid();
  let dropped = false;
  state.tpls.forEach((t, i) => {
    if (t && t.procW !== W) {
      state.tpls[i] = null;
      dropped = true;
    }
  });
  if (dropped) {
    rebuildTemplates();
    renderTeam();
    toast('畫面解析度改變了,請重新框選名牌', 6000);
  }
  save();
  updateSteps();
}

function updateCaptureUi() {
  const on = capture.active;
  $('#btnCapture').hidden = on;
  $('#btnStop').hidden = !on;
  $('#viewEmpty').hidden = on;
  if (!on) $('#capInfo').textContent = '';
}

async function startScreen() {
  try {
    await capture.startScreen();
  } catch (err) {
    toast(err && err.name === 'NotAllowedError' ? '沒有選擇要分享的畫面' : `無法擷取畫面:${err && err.message}`, 6000);
    return;
  }
  run.W = 0;
  updateCaptureUi();
}

function stopCapture() {
  capture.stop();
  setDetecting(false);
  cancelPick();
  run.W = 0;
  updateCaptureUi();
  vctx.clearRect(0, 0, view.width, view.height);
}

function setDetecting(on) {
  if (on) {
    if (!capture.active) return toast('請先擷取遊戲畫面');
    if (!run.grid) return toast('請先校準平台格線');
    if (!rt.built.slice(0, state.n).some((t, p) => t && watched(p))) return toast('請先框選自己的名牌');
    for (let p = 0; p < state.n; p++) if (watched(p)) rt.engine.players[p].lost = true;
  }
  run.detecting = on;
  $('#btnDetect').textContent = on ? '⏸ 暫停偵測' : '▶ 開始偵測';
  $('#detInfo').textContent = on ? '偵測中…' : '';
  updateSteps();
}

function updateSteps() {
  $('#stepGrid').classList.toggle('done', !!run.grid);
  $('#stepTpl').classList.toggle('done', rt.built.slice(0, state.n).every((t, p) => t || !watched(p)));
  $('#stepRun').classList.toggle('done', run.detecting);
}

// ---- detection loop -----------------------------------------------------------------

function searchRegion() {
  const g = run.grid;
  if (!g) return null;
  const x = Math.max(0, g.colX[0] - 1.5 * g.dx);
  const y = Math.max(0, g.rowY[10] - g.dy);
  return { x, y, w: Math.min(run.W - x, g.colX[3] + 1.5 * g.dx - x), h: Math.min(run.H - y, g.rowY[0] + 2 * g.dy - y) };
}

// A wrong-platform teleport lands on the bottom floor, far outside the local search window.
function bottomRegion() {
  const g = run.grid;
  const r = searchRegion();
  const y = Math.max(0, g.rowY[0] - 1.2 * g.dy);
  return { x: r.x, y, w: r.w, h: Math.min(run.H - y, 3.4 * g.dy) };
}

function rivalOwns(p, r, tpl) {
  const cx = r.x + tpl.w / 2;
  const cy = r.y + tpl.h / 2;
  return rt.built.some((q, i) => i !== p && i < state.n && q && tracker.score(q, Math.round(cx - q.w / 2), Math.round(cy - q.h / 2)) >= r.score - 0.02);
}

function cellText(cell) {
  if (!cell) return '找不到';
  if (cell.kind === 'plat') return `Lv${cell.level} ${CIRC[cell.col]}`;
  return cell.kind === 'ground' ? '底層' : '空中';
}

function detect(now) {
  const s = state.settings;
  tracker.setFrame(vctx.getImageData(0, 0, run.W, run.H).data, run.W, run.H);
  const obs = [];
  let globalBudget = 1;
  for (let p = 0; p < state.n; p++) {
    const tpl = watched(p) ? rt.built[p] : null;
    obs[p] = null;
    run.pos[p] = null;
    if (!tpl) continue;
    // Name tags look alike, so a match only counts if it clears the threshold AND no teammate's
    // template fits that spot better. Each search stage is judged on its own: a rejected local
    // hit (a teammate's tag nearby) must not stop the wider searches.
    const good = (m) => m && m.score >= s.matchThreshold && !rivalOwns(p, m, tpl);
    let r = run.hints[p] ? tracker.find(tpl, { hint: run.hints[p], radius: Math.max(110, Math.round(0.8 * run.grid.dx)) }) : null;
    if (!good(r)) {
      const rb = tracker.find(tpl, { global: true, region: bottomRegion() });
      r = good(rb) ? rb : null;
    }
    // a whole-screen search is slow: at most one per frame, and not more than every 300 ms per player
    if (!r && globalBudget > 0 && now - (run.lastGlobal[p] ?? 0) > 300) {
      globalBudget--;
      run.lastGlobal[p] = now;
      const rg = tracker.find(tpl, { global: true, region: searchRegion() });
      r = good(rg) ? rg : null;
    }
    if (r && r.score >= s.matchThreshold) {
      run.hints[p] = { x: r.x, y: r.y };
      const cx = r.x + tpl.w / 2;
      const fy = r.y + tpl.h / 2 - s.tagOffsetY;
      run.pos[p] = { x: r.x, y: r.y, w: tpl.w, h: tpl.h, cx, fy, score: r.score };
      obs[p] = classify(run.grid, cx, fy, { tolY: s.tolY / 100, tolX: s.tolX / 100 });
    }
  }
  handleEvents(rt.engine.step(now, obs, new Set(Array.from({ length: state.n }, (_, p) => p).filter((p) => !watched(p)))));
  for (let p = 0; p < state.n; p++) {
    const P = rt.engine.players[p];
    if (!watched(p) || !rt.built[p]) continue;
    if (run.pos[p]) setPlayerStatus(p, `${cellText(P.cell)} · 相似度 ${Math.round(run.pos[p].score * 100)}%`, 'ok');
    else setPlayerStatus(p, P.lost ? '畫面中找不到名牌' : '暫時找不到…', P.lost ? 'lost' : '');
  }
  const sig = rt.engine.players.map((P) => `${P.level}.${P.col}.${P.lost}.${P.attempt ? P.attempt.level + '' + P.attempt.col : ''}`).join('|');
  if (sig !== run.sig) {
    run.sig = sig;
    rerender();
  }
}

function handleEvents(events) {
  let changed = false;
  for (const e of events) {
    if (e.type === 'ok' || e.type === 'bad') {
      recordResult(e.player, e.level, e.col, e.type === 'ok', { source: 'auto', place: false });
      changed = true;
    } else if (e.type === 'unknownFall') {
      if (state.settings.autoAdoptFall) {
        recordResult(e.player, e.level, e.col, false, { source: 'auto', place: false });
        changed = true;
      } else if (!rt.toasts.some((t) => t.kind === 'fall' && t.player === e.player)) {
        pushToast({ kind: 'fall', player: e.player, level: e.level, col: e.col });
      }
    }
  }
  if (changed) rerender();
}

function tick() {
  const t0 = performance.now();
  if (state.mode === 'auto' && capture.active) {
    ensureSize();
    if (run.pick) vctx.putImageData(run.frozen, 0, 0);
    else {
      vctx.drawImage(capture.video, 0, 0, run.W, run.H);
      if (run.detecting) detect(t0);
    }
    drawOverlay();
  }
  setTimeout(tick, Math.max(0, 1000 / state.settings.fps - (performance.now() - t0)));
}

// ---- overlay ------------------------------------------------------------------------

function drawOverlay() {
  const c = vctx;
  const g = run.grid;
  c.save();
  c.lineWidth = 1;
  c.font = `${Math.max(11, Math.round(run.W / 90))}px sans-serif`;
  if (g) {
    for (let L = 0; L <= 10; L++) {
      c.strokeStyle = L === 0 ? 'rgba(255,255,255,.35)' : 'rgba(255,179,71,.4)';
      c.beginPath();
      c.moveTo(g.colX[0] - 0.8 * g.dx, g.rowY[L]);
      c.lineTo(g.colX[3] + 0.8 * g.dx, g.rowY[L]);
      c.stroke();
      c.fillStyle = 'rgba(255,179,71,.9)';
      c.fillText(L === 0 ? '底層' : `Lv${L}`, Math.max(2, g.colX[0] - 0.8 * g.dx - 28), g.rowY[L] - 2);
      if (L > 0) {
        c.fillStyle = 'rgba(255,179,71,.65)';
        for (const x of g.colX) c.fillRect(x - 3, g.rowY[L] - 1, 6, 3);
      }
    }
  }
  if (run.detecting) {
    for (let p = 0; p < state.n; p++) {
      const pos = run.pos[p];
      if (!pos) continue;
      c.strokeStyle = COLORS[p];
      c.lineWidth = 2;
      c.strokeRect(pos.x, pos.y, pos.w, pos.h);
      c.beginPath();
      c.arc(pos.cx, pos.fy, 4, 0, 7);
      c.fillStyle = COLORS[p];
      c.fill();
      c.fillText(`${state.names[p]} ${cellText(rt.engine.players[p].cell)}`, pos.x, pos.y - 4);
    }
  }
  const pk = run.pick;
  if (pk) {
    c.fillStyle = 'rgba(0,0,0,.25)';
    c.fillRect(0, 0, run.W, run.H);
    if (pk.kind === 'grid') {
      c.strokeStyle = '#ff6b6b';
      c.lineWidth = 2;
      for (const pt of pk.pts) {
        c.beginPath();
        c.moveTo(pt.x - 10, pt.y);
        c.lineTo(pt.x + 10, pt.y);
        c.moveTo(pt.x, pt.y - 10);
        c.lineTo(pt.x, pt.y + 10);
        c.stroke();
      }
    } else if (pk.drag) {
      const { x0, y0, x1, y1 } = pk.drag;
      c.strokeStyle = COLORS[pk.p];
      c.lineWidth = 2;
      c.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
  }
  c.restore();
}

// ---- calibration --------------------------------------------------------------------

function banner(text, withDone = false) {
  const b = $('#pickBanner');
  b.hidden = !text;
  b.innerHTML = text ? `<span>${text}</span><span>${withDone ? '<button data-act="pickDone">完成</button> ' : ''}<button data-act="pickCancel">取消</button></span>` : '';
  view.classList.toggle('picking', !!text);
}

function freeze() {
  vctx.drawImage(capture.video, 0, 0, run.W, run.H);
  run.frozen = vctx.getImageData(0, 0, run.W, run.H);
}

function startGridPick() {
  if (!capture.active) return toast('請先擷取遊戲畫面');
  freeze();
  run.pick = { kind: 'grid', pts: [] };
  banner('① 點【第 1 層最左邊平台】的站立面');
}

function startTplPick(p) {
  if (!capture.active) return toast('請先擷取遊戲畫面');
  freeze();
  run.pick = { kind: 'tpl', p, drag: null };
  banner(`拖曳框住「${state.names[p]}」腳下的名牌(越貼近文字越準)`);
}

function cancelPick() {
  run.pick = null;
  run.frozen = null;
  banner('');
}

function canvasPoint(e) {
  const r = view.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * view.width) / r.width, y: ((e.clientY - r.top) * view.height) / r.height };
}

function onPointerDown(e) {
  const pk = run.pick;
  if (!pk) return;
  const pt = canvasPoint(e);
  if (pk.kind === 'tpl') {
    pk.drag = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
    view.setPointerCapture(e.pointerId);
    return;
  }
  pk.pts.push(pt);
  if (pk.pts.length === 1) banner('② 點【第 10 層最右邊平台】的站立面');
  else if (pk.pts.length === 2) {
    const [a, b] = pk.pts;
    if (!(b.y < a.y - 20 && b.x > a.x + 20)) {
      pk.pts = [];
      banner('① 位置不合理(第 10 層要在第 1 層的右上方),重新點【第 1 層最左邊平台】');
      return;
    }
    state.grid = { x1: a.x, y1: a.y, x2: b.x, y2: b.y, groundY: null, procW: run.W };
    rebuildGrid();
    banner('③ (選填)點【起點 / 最底層地面】的站立面,不點就用預設', true);
  } else {
    state.grid.groundY = pt.y;
    rebuildGrid();
    finishGrid();
  }
}

function finishGrid() {
  cancelPick();
  save();
  renderSettings();
  updateSteps();
  toast('格線已建立,可在「設定 → 格線微調」精修');
}

function onPointerMove(e) {
  const pk = run.pick;
  if (pk && pk.kind === 'tpl' && pk.drag) {
    const pt = canvasPoint(e);
    pk.drag.x1 = pt.x;
    pk.drag.y1 = pt.y;
  }
}

function onPointerUp() {
  const pk = run.pick;
  if (!pk || pk.kind !== 'tpl' || !pk.drag) return;
  const { x0, y0, x1, y1 } = pk.drag;
  const rect = { x: Math.round(Math.min(x0, x1)), y: Math.round(Math.min(y0, y1)), w: Math.round(Math.abs(x1 - x0)), h: Math.round(Math.abs(y1 - y0)) };
  pk.drag = null;
  if (rect.w < 16 || rect.h < 8) return toast('框太小了,請再拖曳一次', 3000);
  const tpl = makeTemplate(toGray(run.frozen.data, run.W * run.H), run.W, run.H, rect);
  if (!tpl) return toast('無法建立模板,請再試一次', 3000);
  state.tpls[pk.p] = { raw: tpl.raw, w: tpl.w, h: tpl.h, procW: run.W };
  run.hints[pk.p] = { x: tpl.x, y: tpl.y };
  rt.engine.players[pk.p].lost = true;
  rebuildTemplates();
  cancelPick();
  save();
  renderTeam();
  updateSteps();
}

// ---- manual actions -----------------------------------------------------------------

function targetFor(p) {
  const pl = computeAdvice().plans[p];
  if (!pl || !pl.test) return null;
  const ch = rt.chosen[p];
  return { level: pl.test.level, col: ch && ch.level === pl.test.level ? ch.col : pl.test.col };
}

function cycleDot(p, level, col) {
  const cur = state.log.find((e) => e.player === p && e.level === level && e.col === col);
  if (!cur) recordResult(p, level, col, true, { source: 'manual', place: false });
  else if (cur.type === 'ok') recordResult(p, level, col, false, { source: 'manual', place: false });
  else removeEntry(cur.id);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function startDemo() {
  if (run.demo) return stopDemo();
  if (room.session) return toast('連線中不能示範(會洗掉隊友的紀錄),請先中斷連線', 5000);
  if (state.log.length && !confirm('示範會清除目前的紀錄(已學到的答案會先存入數據統計),繼續?')) return;
  resetRun();
  rt.demo = true; // demo runs are not collected into the statistics
  setMode('manual');
  const sim = createSim({ mode: state.rule, n: state.n, seed: Date.now() & 0xffff, maxTesters: state.maxTesters });
  $('#btnDemo').textContent = '■ 停止示範';
  run.demo = setInterval(() => {
    for (const e of sim.step()) {
      if (e.type === 'ok' || e.type === 'bad') recordResult(e.player, e.level, e.col, e.type === 'ok', { source: 'manual' });
      else rt.engine.place(e.player, e.level, null);
    }
    rerender();
    if (sim.done) {
      stopDemo();
      toast(`示範完成:共 ${sim.rounds} 輪,掉回底層 ${sim.falls} 次。按「新的一輪」開始正式紀錄。`, 8000);
    }
  }, 700);
  rerender();
}

function stopDemo() {
  clearInterval(run.demo);
  run.demo = null;
  $('#btnDemo').textContent = '▶ 示範';
}

// ---- events -------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  const { act } = el.dataset;
  const p = Number(el.dataset.p);
  switch (act) {
    case 'choose':
      rt.chosen[p] = { level: Number(el.dataset.l), col: Number(el.dataset.c) };
      return rerender();
    case 'ok':
    case 'bad': {
      const t = targetFor(p);
      if (t) recordResult(p, t.level, t.col, act === 'ok');
      return rerender();
    }
    case 'bottom':
      rt.engine.place(p, 0);
      save();
      return rerender();
    case 'dot':
      cycleDot(p, Number(el.dataset.l), Number(el.dataset.c));
      return rerender();
    case 'del': {
      const entry = state.log.find((x) => x.id === Number(el.dataset.id));
      removeEntry(Number(el.dataset.id), !!entry && entry.source === 'manual');
      return rerender();
    }
    case 'pickTpl':
      return startTplPick(p);
    case 'pickCancel':
      return cancelPick();
    case 'pickDone':
      return finishGrid();
    case 'fallYes': {
      const t = rt.toasts.find((x) => x.id === Number(el.dataset.id));
      if (t) recordResult(t.player, t.level, Number(el.dataset.c), false, { source: 'auto', place: false });
      dismissToast(Number(el.dataset.id));
      return rerender();
    }
    case 'toastDismiss':
      return dismissToast(Number(el.dataset.id));
    case 'exportJson':
      return download('maple-rj-data.json', JSON.stringify(rt.data.runs, null, 1), 'application/json');
    case 'exportCsv':
      return download('maple-rj-data.csv', `﻿${runsToCSV(rt.data.runs)}`, 'text/csv');
    case 'clearData':
      if (confirm('清除所有已收集的數據?(無法復原)')) {
        clearData();
        rerender();
      }
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  const { act, k } = el.dataset;
  if (el.id === 'fileVideo' && el.files[0]) {
    try {
      await capture.startFile(el.files[0]);
      run.W = 0;
      updateCaptureUi();
    } catch (err) {
      toast(`無法播放影片:${err.message}`, 5000);
    }
    el.value = '';
  } else if (act === 'name') {
    state.names[Number(el.dataset.p)] = el.value.trim() || `玩家 ${Number(el.dataset.p) + 1}`;
    save();
    rerender();
  } else if (act === 'set') {
    const v = el.type === 'checkbox' ? el.checked : el.dataset.num ? Number(el.value) : el.value;
    if (el.dataset.top) {
      state[k] = k === 'n' ? Math.max(1, Math.min(4, Math.round(v) || 4)) : v;
      if (k === 'n') {
        syncEngine();
        renderTeam();
        updateSteps();
      }
    } else state.settings[k] = v;
    syncEngine();
    if (k === 'procWidth') run.W = 0;
    save();
    rerender();
  } else if (act === 'grid') {
    state.grid[k] = Number(el.value);
    rebuildGrid();
    save();
  } else if (act === 'importJson' && el.files[0]) {
    try {
      const added = importRuns(JSON.parse(await el.files[0].text()));
      toast(`已匯入 ${added} 輪新資料`);
    } catch {
      toast('匯入失敗:不是有效的資料檔', 5000);
    }
    el.value = '';
    rerender();
  }
});

$('#modeAuto').addEventListener('click', () => setMode('auto'));
$('#modeManual').addEventListener('click', () => setMode('manual'));
$('#btnCapture').addEventListener('click', startScreen);
$('#btnStop').addEventListener('click', stopCapture);
$('#btnGrid').addEventListener('click', startGridPick);
$('#btnGridClear').addEventListener('click', () => {
  state.grid = null;
  run.grid = null;
  save();
  renderSettings();
  updateSteps();
});
$('#btnDetect').addEventListener('click', () => setDetecting(!run.detecting));
$('#btnDemo').addEventListener('click', startDemo);
$('#btnReset').addEventListener('click', () => {
  if (!confirm(`開始新的一輪?目前的紀錄會清除(已學到的答案會先存入數據統計)。${room.session ? '連線中的隊友也會一起開始新的一輪。' : ''}`)) return;
  stopDemo();
  resetRun();
  rerender();
});
$('#btnUndo').addEventListener('click', () => {
  const last = state.log[state.log.length - 1];
  if (last) removeEntry(last.id, last.source === 'manual');
  rerender();
});
$('#statsPanel').addEventListener('toggle', () => $('#statsPanel').open && renderStats());
view.addEventListener('pointerdown', onPointerDown);
view.addEventListener('pointermove', onPointerMove);
view.addEventListener('pointerup', onPointerUp);
document.addEventListener('keydown', (e) => e.key === 'Escape' && cancelPick());
capture.onEnded = stopCapture;

// ---- room ---------------------------------------------------------------------------

function afterRemote() {
  render();
  renderRoom(!!room.session);
}

async function connectRoom() {
  if (state.me === null) return toast('連線前請先選「我是」玩家幾號(不能選全部)', 5000);
  const code = $('#roomCode').value.trim().replace(/[^\w-]/g, '').slice(0, 24);
  if (code.length < 3) return toast('房間代碼至少 3 個字(英數字)', 4000);
  state.room = { code, via: $('#roomVia').value };
  save();
  $('#roomInfo').textContent = '連線中…';
  $('#btnRoom').disabled = true;
  try {
    const transport = state.room.via === 'tab' ? new BroadcastTransport(code, state.me) : new PeerTransport(code, state.me, await loadPeerJS());
    room.session = new Session(transport, {
      slot: state.me,
      snapshot,
      hooks: {
        onSnapshot: (snap) => {
          if (applySnapshot(snap) === 'adopted') toast('已同步到隊友目前這一輪');
          afterRemote();
        },
        onFact: (e) => mergeRemote({ entries: [e] }) && afterRemote(),
        onDel: (key, ts) => mergeRemote({ tombs: { [key]: ts } }) && afterRemote(),
        onReset: (info) => {
          if (adoptRun(info) === 'adopted') {
            toast('隊友開始了新的一輪');
            afterRemote();
          }
        },
        onStatus: (st) => {
          const r = applyStatus(st);
          if (r.names) renderTeam();
          if (r.changed || r.names) afterRemote();
          else renderRoom(true);
        },
        onPeer: (slot, online) => {
          rt.peers[slot] = online;
          renderRoom(true);
        },
      },
    });
    await transport.open();
  } catch (err) {
    room.session?.close();
    room.session = null;
    $('#roomInfo').textContent = '';
    $('#btnRoom').disabled = false;
    return toast(`連線失敗:${err.message}`, 7000);
  }
  rt.hooks = {
    fact: (e) => room.session?.sendFact(e),
    del: (key, ts) => room.session?.sendDel(key, ts),
    reset: (id, ts) => room.session?.sendReset(id, ts),
  };
  room.timer = setInterval(() => {
    sendStatus(true);
    afterRemote();
  }, 2000);
  $('#btnRoom').disabled = false;
  $('#roomInfo').textContent = `已進入房間 ${code}(等隊友連線)`;
  room.session.hello(true);
  sendStatus(true);
  renderRoom(true);
}

function disconnectRoom() {
  clearInterval(room.timer);
  room.session?.close();
  room.session = null;
  rt.hooks = {};
  rt.peers = [];
  $('#roomInfo').textContent = '';
  renderRoom(false);
}

const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

$('#btnRoom').addEventListener('click', () => (room.session ? disconnectRoom() : connectRoom()));
$('#btnRoomNew').addEventListener('click', () => {
  if (room.session) return;
  $('#roomCode').value = randomCode();
  toast('把這組代碼傳給三位隊友,大家填同一組', 5000);
});
$('#seatSel').addEventListener('change', (e) => {
  state.me = e.target.value === 'all' ? null : Number(e.target.value);
  save();
  renderTeam();
  updateSteps();
  setDetecting(false);
  rerender();
  renderRoom(false);
});
$('#btnShareCopy').addEventListener('click', async () => {
  const code = encodeShare(snapshot(), myStatus());
  $('#shareBox').value = code;
  try {
    await navigator.clipboard.writeText(code);
    toast('分享碼已複製');
  } catch {
    $('#shareBox').select();
    toast('已放在下方文字框,請手動複製', 4000);
  }
});
$('#btnShareMerge').addEventListener('click', () => {
  const codes = $('#shareBox').value.match(/RJ1\.[A-Za-z0-9+/=]+/g) || [];
  let ok = 0;
  for (const c of codes) {
    const d = decodeShare(c);
    if (!d) continue;
    ok++;
    applySnapshot(d.snap);
    if (d.status) applyStatus(d.status);
  }
  toast(ok ? `已合併 ${ok} 組分享碼` : '找不到有效的分享碼', 4000);
  renderTeam();
  rerender();
});

// ---- start --------------------------------------------------------------------------

load();
document.body.dataset.mode = state.mode;
$('#modeAuto').setAttribute('aria-pressed', String(state.mode === 'auto'));
$('#modeManual').setAttribute('aria-pressed', String(state.mode === 'manual'));
rebuildGrid();
renderSettings();
renderTeam();
updateSteps();
updateCaptureUi();
rerender();
renderRoom(false);
tick();

// Hook for automated tests / debugging: feed any MediaStream in place of a real screen share.
window.__rj = { state, rt, run, tracker, useStream: async (stream) => (await capture.useStream(stream), (run.W = 0), updateCaptureUi()) };
