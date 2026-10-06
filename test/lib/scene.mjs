// A synthetic "game screen" for the browser tests: platforms for 10 levels x 4 columns and one or
// more name tags that move along scripted timelines. Injected before the page loads; it replaces
// getDisplayMedia so the app "shares" this canvas.

export const GEO = {
  W: 1280,
  H: 720,
  colX: [300, 500, 700, 900],
  rowY: (L) => (L === 0 ? 700 : 640 - (L - 1) * 60),
};

// cfg = { players: [{ name, color, tl }] } where tl keys are [timeMs, x, y, glide?]:
// glide = move smoothly there from the previous key (a jump); otherwise appear there at once.
export const sceneScript = (cfg) => {
  const W = 1280, H = 720;
  const colX = [300, 500, 700, 900];
  const rowY = (L) => (L === 0 ? 700 : 640 - (L - 1) * 60);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const posAt = (keys, t) => {
    let i = 0;
    keys.forEach((k, j) => { if (k[0] <= t) i = j; });
    const cur = keys[i];
    const nxt = keys[i + 1];
    if (nxt && nxt[3]) {
      const f = Math.min(1, (t - cur[0]) / (nxt[0] - cur[0]));
      return { x: cur[1] + (nxt[1] - cur[1]) * f, y: cur[2] + (nxt[2] - cur[2]) * f };
    }
    return { x: cur[1], y: cur[2] };
  };
  let t0 = null;
  window.__sceneStart = () => { t0 = performance.now(); };
  const draw = () => {
    const t = t0 === null ? 0 : performance.now() - t0;
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, '#2b3a55');
    grd.addColorStop(1, '#4a3a2b');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(255,255,255,${((i * 37) % 10) / 120})`; g.fillRect((i * 97) % W, (i * 53) % H, 3, 3); }
    g.fillStyle = '#6b5b3a';
    for (let L = 1; L <= 10; L++) for (const x of colX) g.fillRect(x - 60, rowY(L), 120, 8);
    g.fillRect(0, 700, W, 20);
    cfg.players.forEach((pl) => {
      const { x, y } = posAt(pl.tl, t);
      g.fillStyle = pl.color;
      g.fillRect(x - 10, y - 36, 20, 36);
      g.fillStyle = 'rgba(20,30,90,.85)';
      g.fillRect(x - 36, y + 1, 72, 16);
      g.fillStyle = '#fff';
      g.font = 'bold 12px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(pl.name, x, y + 9);
    });
  };
  setInterval(draw, 33);
  const stream = cv.captureStream(30);
  navigator.mediaDevices.getDisplayMedia = async () => stream;
};
