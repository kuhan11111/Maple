// Maps a point on the captured screen to a cell of the 10-level x 4-platform board.
//
// The user clicks two platforms (level 1 left-most, level 10 right-most) and optionally the
// start/ground line; everything in between is interpolated linearly. Row 0 is the ground.

import { LEVELS, COLS } from './solver.js';

export function makeGrid({ x1, y1, x2, y2, groundY }) {
  const dy = (y1 - y2) / (LEVELS - 1); // pixels per level, positive when level 10 is higher on screen
  const dx = (x2 - x1) / (COLS - 1);
  const rowY = [groundY ?? y1 + dy];
  for (let L = 1; L <= LEVELS; L++) rowY.push(y1 - (L - 1) * dy);
  const colX = Array.from({ length: COLS }, (_, c) => x1 + c * dx);
  return { x1, y1, x2, y2, groundY: rowY[0], dx, dy, rowY, colX };
}

export function gridValid(g) {
  return !!g && g.dy > 4 && g.dx > 4 && Number.isFinite(g.groundY);
}

/**
 * Where is a character whose feet are at (fx, fy)?
 *   {kind:'plat', level, col} standing on a platform
 *   {kind:'ground'}           on the start/bottom floor
 *   {kind:'air'}              between rows (jumping / falling)
 * tolY / tolX are fractions of the row / column spacing.
 */
export function classify(grid, fx, fy, { tolY = 0.3, tolX = 0.7 } = {}) {
  const { rowY, colX, dy, dx } = grid;
  let best = 0;
  let bestD = Infinity;
  for (let L = 0; L <= LEVELS; L++) {
    const d = Math.abs(fy - rowY[L]);
    if (d < bestD) {
      bestD = d;
      best = L;
    }
  }
  if (fy > rowY[0] + tolY * dy) return { kind: 'ground' };
  if (bestD > tolY * dy) return { kind: 'air' };
  if (best === 0) return { kind: 'ground' };
  let col = 0;
  for (let c = 1; c < COLS; c++) if (Math.abs(fx - colX[c]) < Math.abs(fx - colX[col])) col = c;
  if (Math.abs(fx - colX[col]) > tolX * dx) return { kind: 'air' };
  return { kind: 'plat', level: best, col };
}
