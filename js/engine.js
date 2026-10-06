// Turns "where is each player on the board, frame by frame" into game events.
//
// How the game works: you stand near the middle of a platform and press Up. A wrong platform
// teleports you straight to the bottom; a right one does nothing visible. Falling off by a
// bad jump is not a verdict on the platform. So:
//
//   bad          on a platform, then on the bottom floor a frame later with nothing in the
//                air between (a teleport, not a fall)  -> that platform is wrong
//   ok           stood on the next level's platform and was never sent back (okStandMs), or
//                went on up to the next level from it (okMode 'advance'/'both')
//   unknownFall  the tag vanished and reappeared at the bottom - could have been a teleport
//
// Cells come from grid.classify(): {kind:'plat'|'ground'|'air', level, col}, or null when
// the player's name tag was not found in that frame.

export const DEFAULT_TIMING = {
  touchMs: 200, // standing this long on a platform = a real stop (pressing Up), not a pass-through
  okStandMs: 1500, // stood on the next platform this long without being sent back = it is right
  okMode: 'both', // 'both' | 'advance' (only when they go up) | 'off' (never infer success)
  pressMs: 400, // when credited by going up, the platform must have been stood on this long
  teleportMs: 250, // platform -> bottom within this long, no air frames = teleport
  teleConfirmMs: 160, // ...and the player must stay at the bottom this long (ignores one-frame glitches)
  lostGapMs: 1500, // tag lost for up to this long between platform and bottom = ask
  gapMs: 400, // leaving a platform for less than this does not restart its stand time
  lostMs: 2500, // tag unseen this long = player is lost
};

export class Engine {
  constructor(n, timing = {}) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.players = Array.from({ length: n }, () => this.#fresh());
  }

  #fresh() {
    return {
      level: 0, // highest level confirmed standing on (0 = bottom)
      col: null,
      cell: null,
      attempt: null, // {level, col, tLast}: standing on the next level's platform
      touched: {}, // level -> {col, since, t}
      last: null, // last platform seen: {level, col, t, since}
      airFrames: 0, // air sightings since the last platform
      blind: false, // tag was missing since the last platform
      tele: null, // teleport waiting for confirmation: {level, col, t}
      lastSeen: -Infinity,
      lost: true,
    };
  }

  #bottom(P) {
    Object.assign(P, { level: 0, col: null, attempt: null, touched: {}, last: null, airFrames: 0, blind: false, tele: null });
  }

  reset() {
    this.players = this.players.map(() => this.#fresh());
  }

  resize(n) {
    while (this.players.length < n) this.players.push(this.#fresh());
    this.players.length = n;
  }

  /** Manual correction: player is standing on (level, col); level 0 = bottom. */
  place(p, level, col = null) {
    this.#bottom(this.players[p]);
    Object.assign(this.players[p], { level, col });
  }

  /** Attempts in progress, for steering teammates' advice. */
  pending() {
    return this.players.flatMap((P, player) => (P.attempt ? [{ player, level: P.attempt.level, col: P.attempt.col }] : []));
  }

  /** obs[p] = cell | null; `skip` = seats not watched by this screen. Returns this frame's events. */
  step(t, obs, skip = null) {
    const events = [];
    this.players.forEach((P, p) => {
      if (skip && skip.has(p)) return;
      const cell = obs[p] ?? null;
      P.cell = cell;
      if (!cell) {
        if (P.last) P.blind = true;
        if (t - P.lastSeen > this.timing.lostMs) P.lost = true;
        return;
      }
      P.lastSeen = t;
      P.lost = false;
      if (cell.kind === 'plat') {
        P.tele = null;
        this.#onPlatform(p, cell, t, events);
        P.airFrames = 0;
        P.blind = false;
      } else if (cell.kind === 'air') {
        P.airFrames++;
      } else {
        this.#onBottom(p, t, events);
      }
    });
    return events;
  }

  #onPlatform(p, cell, t, events) {
    const P = this.players[p];
    const o = this.timing;
    const { level: r, col: c } = cell;
    let m = P.touched[r];
    if (!m || m.col !== c || t - m.t > o.gapMs) m = P.touched[r] = { col: c, since: t, t };
    m.t = t;
    P.last = { level: r, col: c, t, since: m.since };
    const dur = t - m.since;

    if (r === P.level + 1) {
      if (dur >= o.touchMs) P.attempt = { level: r, col: c, tLast: t };
      if (o.okMode === 'both' && dur >= o.okStandMs) this.#confirm(p, r, c, t, events);
    } else if (r > P.level + 1) {
      if (dur < o.touchMs) return;
      // Came up from below: credit the platform(s) they stood on on the way, then treat this
      // one as the next thing being tried.
      for (let L = P.level + 1; L < r; L++) {
        const q = P.touched[L];
        if (o.okMode !== 'off' && q && q.t - q.since >= o.pressMs) this.#confirm(p, L, q.col, q.t, events);
        else Object.assign(P, { level: L, col: q ? q.col : null, attempt: null });
      }
      this.#onPlatform(p, cell, t, events);
    } else if (r === P.level) {
      P.col ??= c;
      if (dur >= o.touchMs) P.attempt = null; // landed back on the confirmed level: a missed jump
    } else if (dur >= o.touchMs) {
      Object.assign(P, { level: r, col: c, attempt: null, touched: {} }); // dropped to a lower platform
    }
  }

  #confirm(p, level, col, t, events) {
    Object.assign(this.players[p], { level, col, attempt: null });
    events.push({ type: 'ok', player: p, level, col, t });
  }

  #onBottom(p, t, events) {
    const P = this.players[p];
    const o = this.timing;
    if (P.tele) {
      if (t - P.tele.t >= o.teleConfirmMs) {
        events.push({ type: 'bad', player: p, level: P.tele.level, col: P.tele.col, t });
        this.#bottom(P);
      }
      return;
    }
    const L = P.last;
    if (!L) {
      if (P.level) this.#bottom(P);
      return;
    }
    const stood = L.t - L.since >= o.touchMs;
    const gap = t - L.t;
    if (stood) {
      if (P.airFrames === 0 && !P.blind && gap <= o.teleportMs) {
        P.tele = { level: L.level, col: L.col, t };
        return;
      }
      if (P.blind && gap <= o.lostGapMs) events.push({ type: 'unknownFall', player: p, level: L.level, col: L.col, t });
    }
    this.#bottom(P); // an ordinary fall: back at the bottom, nothing learned
  }
}
