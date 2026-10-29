// "Every day at 06:00 Taiwan time" without a cron dependency.

const DAY = 24 * 60 * 60 * 1000;

/** Milliseconds from `now` until the next HH:MM in the zone `offsetHours` ahead of UTC. */
export function delayUntil(at, offsetHours, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`時間格式不對:「${at}」(要像 06:00)`);
  const local = now + offsetHours * 3600_000;
  const target = Math.floor(local / DAY) * DAY + (+m[1] * 60 + +m[2]) * 60_000;
  return (target > local ? target : target + DAY) - local;
}

export function scheduleDaily({ at = '06:00', offsetHours = 8, now = () => Date.now(), setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout }, fn, onError = () => {}) {
  let timer = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = st(async () => {
      try {
        await fn();
      } catch (err) {
        onError(err);
      }
      arm();
    }, delayUntil(at, offsetHours, now()));
    timer?.unref?.();
  };
  arm();
  return {
    stop() {
      stopped = true;
      ct(timer);
    },
  };
}
