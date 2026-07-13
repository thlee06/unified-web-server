// High-frequency sample events, decoupled from the structural store so a
// 10-50Hz stream doesn't force a full DOM rebuild on every tick. Views patch
// specific DOM nodes (chart polylines, readout numbers) directly here.
const listeners = new Set();

export function onLiveSample(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitLiveSample(msg) {
  for (const fn of listeners) fn(msg);
}
