// Queue logic for one server, independent of Discord. The adapter does the actual playing and
// calls player.ended(error?) when a track finishes, fails or the connection is lost.

export const MAX_QUEUE = 50;
const IDLE_MS = 5 * 60 * 1000;

export class GuildPlayer {
  constructor({ adapter, onEvent = () => {}, onClose = () => {}, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout }) {
    Object.assign(this, { adapter, onEvent, onClose, st, ct });
    this.queue = [];
    this.current = null;
    this.loop = 'off'; // off | one | all
    this.volume = 50;
    this.paused = false;
    this.idleTimer = null;
    this.closed = false;
  }

  /** Returns the position in the queue (0 = playing now), or -1 if the queue is full. */
  add(track) {
    if (this.queue.length >= MAX_QUEUE) return -1;
    this.queue.push(track);
    if (!this.current) {
      this.#next();
      return 0;
    }
    return this.queue.length;
  }

  #next(prev = null, auto = false) {
    this.ct(this.idleTimer);
    if (prev && this.loop === 'one') this.queue.unshift(prev);
    else if (prev && this.loop === 'all') this.queue.push(prev);
    this.current = this.queue.shift() ?? null;
    this.paused = false;
    if (!this.current) {
      this.onEvent({ type: 'idle' });
      this.idleTimer = this.st(() => this.close(), IDLE_MS);
      this.idleTimer?.unref?.();
      return;
    }
    try {
      this.adapter.play(this.current, this.volume / 100);
      this.onEvent({ type: 'playing', track: this.current, auto });
    } catch (error) {
      this.onEvent({ type: 'error', track: this.current, error });
      this.#next(null, auto);
    }
  }

  /** Adapter callback: the current track is over. */
  ended(error) {
    if (this.closed || !this.current) return;
    const done = this.current;
    if (error) {
      this.onEvent({ type: 'error', track: done, error });
      this.#next(null, true); // never retry a broken track, even when looping
    } else this.#next(done, true);
  }

  skip() {
    if (!this.current) return false;
    const done = this.current;
    this.adapter.stop();
    if (this.current === done) this.#next(this.loop === 'all' ? done : null); // (an adapter that reports back synchronously already advanced)
    return true;
  }

  pause() {
    if (!this.current || this.paused) return false;
    this.adapter.pause();
    return (this.paused = true);
  }

  resume() {
    if (!this.paused) return false;
    this.adapter.resume();
    this.paused = false;
    return true;
  }

  setLoop(mode) {
    this.loop = mode;
  }

  setVolume(v) {
    this.volume = Math.min(100, Math.max(1, Math.round(v)));
    this.adapter.setVolume(this.volume / 100);
  }

  /** Stop everything and leave the voice channel. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ct(this.idleTimer);
    this.queue = [];
    this.current = null;
    this.adapter.destroy();
    this.onClose();
  }
}

/** One GuildPlayer per server, created (and the voice channel joined) on first use. */
export class MusicManager {
  constructor({ createAdapter, onEvent = () => {}, setTimeout: st, clearTimeout: ct }) {
    Object.assign(this, { createAdapter, onEvent, st, ct });
    this.players = new Map();
  }

  get(guildId) {
    return this.players.get(guildId) ?? null;
  }

  async ensure(guildId, voiceChannel, notify) {
    const have = this.players.get(guildId);
    if (have) return have;
    let player;
    const adapter = await this.createAdapter(voiceChannel, {
      onEnd: (err) => player?.ended(err),
      onDisconnect: () => player?.close(),
    });
    player = new GuildPlayer({
      adapter,
      onEvent: (e) => (notify ?? this.onEvent)(e),
      onClose: () => this.players.delete(guildId),
      setTimeout: this.st,
      clearTimeout: this.ct,
    });
    player.channelId = voiceChannel.id;
    this.players.set(guildId, player);
    return player;
  }
}
