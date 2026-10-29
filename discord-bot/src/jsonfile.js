// Small JSON files with debounced, atomic writes (write to .tmp, then rename: a crash never leaves a
// half-written file). A subclass provides data(); an unreadable file simply means starting over.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson(path, fallback) {
  try {
    return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

export class JsonFile {
  constructor(path = null, delayMs = 500) {
    Object.assign(this, { path, delayMs, timer: null });
  }

  queue() {
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data()));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
