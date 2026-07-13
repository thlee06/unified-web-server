// The one place calibration math happens. A load channel's raw value is
// corrected against a known reference mass: zero it, hang a known mass,
// fit a scale factor, and every runtime reading gets (raw - zero) * scale.
export const GRAVITY = 9.80665; // m/s^2
export const CALIBRATION_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Real hardware wiring: some modules have multiple raw ADC channels feeding
// the same physical measurement (e.g. two load cells wired in parallel to
// share one load path). Those channels are read as a single logical group -
// the reading is the average across the group's keys - and calibrated once
// as a unit rather than per-channel. Any module not listed here falls back
// to one group per non-temperature channel, so generic/unknown modules still
// work exactly like a single-channel load cell.
const CHANNEL_GROUP_CONFIG = [
  {
    moduleRe: /^thrust_stand/i,
    groups: [
      { id: 'pair_5kg', label: '5kg pair', keys: ['ch0', 'ch1'] },
      { id: 'pair_20kg', label: '20kg pair', keys: ['ch2', 'ch3'] },
    ],
  },
];

const TEMP_UNITS = new Set(['°c', 'c', 'celsius', 'deg c', 'degc', 'deg_c']);

export function isTempChannel(key, meta) {
  const unit = (meta?.unit || '').trim().toLowerCase();
  if (TEMP_UNITS.has(unit)) return true;
  if (/temp/i.test(key)) return true;
  if (/temp/i.test(meta?.label || '')) return true;
  return false;
}

export function tempChannelKeys(channels) {
  return Object.keys(channels || {}).filter((k) => isTempChannel(k, channels[k]));
}

// Returns the load-channel groups for a module: [{ id, label, keys, unit }].
// A module with no non-temperature channels (e.g. an all-probe diagnostic
// board) returns an empty array - there's nothing to tare/scale-fit, only
// probes to verify.
export function loadChannelGroups(channels, moduleId) {
  const all = channels || {};
  const loadKeys = Object.keys(all).filter((k) => !isTempChannel(k, all[k]));
  if (loadKeys.length === 0) return [];

  const configured = CHANNEL_GROUP_CONFIG.find((c) => c.moduleRe.test(moduleId || ''));
  if (configured) {
    return configured.groups
      .map((g) => ({ ...g, keys: g.keys.filter((k) => loadKeys.includes(k)) }))
      .filter((g) => g.keys.length > 0);
  }

  return loadKeys.map((k) => ({ id: k, label: all[k]?.label || k, keys: [k] }));
}

// Spatial average across a group's raw channel keys for one sample - this is
// the "reading" a group's calibration is built from and applied to.
export function groupReading(values, group) {
  if (!values || !group) return null;
  const present = group.keys.filter((k) => typeof values[k] === 'number');
  if (present.length === 0) return null;
  return present.reduce((sum, k) => sum + values[k], 0) / present.length;
}

// Same average, but indexed into a recorded buffer's parallel per-channel
// arrays (buf.values[key][i]) instead of a single live sample.
export function groupReadingAt(buf, group, i) {
  const present = group.keys.filter((k) => typeof buf.values[k]?.[i] === 'number');
  if (present.length === 0) return null;
  return present.reduce((sum, k) => sum + buf.values[k][i], 0) / present.length;
}

export function appliedLoadNewtons(massKg) {
  return massKg * GRAVITY;
}

// Least-squares slope through the origin: at raw === zeroOffset the applied
// load is by definition zero, so a single free parameter (no intercept) is
// the right fit once tare has already pinned the origin.
export function fitScale(points, zeroOffset) {
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    const x = p.reading - zeroOffset;
    const y = appliedLoadNewtons(p.mass);
    sxy += x * y;
    sxx += x * x;
  }
  return sxx === 0 ? 0 : sxy / sxx;
}

export function residualsFor(points, zeroOffset, scale) {
  return points.map((p) => {
    const x = p.reading - zeroOffset;
    const predicted = x * scale;
    const actual = appliedLoadNewtons(p.mass);
    return actual - predicted;
  });
}

export function applyCalibration(raw, record) {
  if (!record || typeof raw !== 'number') return null;
  return (raw - record.zeroOffset) * record.scale;
}

export function isCalibrated(record) {
  return !!record && typeof record.expiresAt === 'number' && Date.now() < record.expiresAt;
}
