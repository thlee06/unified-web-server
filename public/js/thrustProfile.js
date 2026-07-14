// Data model + persistence for user-authored thrust profiles: a piecewise-
// linear throttle-vs-time curve the ESP32 executes autonomously once
// autopilot launches. Purely client-side (localStorage) - the HOTAS system
// bypasses the Node server entirely, so profiles live in the browser and get
// pushed to the ESP32 over the same WS connection as everything else (see
// uploadProfile() in hotasControl.js).
const STORE_KEY = 'hotas.thrustProfiles';
const ACTIVE_KEY = 'hotas.activeThrustProfileId';

export const MAX_POINTS = 64;
export const MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes

function loadAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveAll(profiles) {
  localStorage.setItem(STORE_KEY, JSON.stringify(profiles));
}

export function listProfiles() {
  return loadAll().sort((a, b) => a.name.localeCompare(b.name));
}

export function getProfile(id) {
  return loadAll().find((p) => p.id === id) || null;
}

export function getActiveProfileId() {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveProfileId(id) {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

function makeId() {
  return `profile_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export function createProfile(name) {
  const profiles = loadAll();
  const profile = {
    id: makeId(),
    name: name || 'Untitled profile',
    points: [{ t: 0, throttle: 0 }, { t: 5000, throttle: 0.5 }, { t: 10000, throttle: 0 }],
    savedAt: Date.now(),
  };
  profiles.push(profile);
  saveAll(profiles);
  return profile;
}

export function updateProfile(id, patch) {
  const profiles = loadAll();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  profiles[idx] = { ...profiles[idx], ...patch, id, savedAt: Date.now() };
  saveAll(profiles);
  return profiles[idx];
}

export function deleteProfile(id) {
  saveAll(loadAll().filter((p) => p.id !== id));
  if (getActiveProfileId() === id) setActiveProfileId(null);
}

// Keeps points sane for both the editor and what gets uploaded to the
// ESP32: sorted by time, clamped throttle, deduplicated times, bounded
// count/duration so a runaway edit can't produce an oversized WS payload.
export function normalizePoints(points) {
  const sorted = [...points]
    .map((p) => ({ t: Math.max(0, Math.min(MAX_DURATION_MS, Math.round(p.t))), throttle: Math.max(0, Math.min(1, p.throttle)) }))
    .sort((a, b) => a.t - b.t)
    .filter((p, i, arr) => i === 0 || p.t !== arr[i - 1].t);
  return sorted.slice(0, MAX_POINTS);
}

// Piecewise-linear interpolation, matching what the firmware is specified
// to do - used here only for the browser's own live preview/progress
// marker, not as the source of truth for what the ESC actually outputs.
export function interpolateThrottle(points, tMs) {
  if (!points || points.length === 0) return 0;
  if (tMs <= points[0].t) return points[0].throttle;
  const last = points[points.length - 1];
  if (tMs >= last.t) return last.throttle;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (tMs >= a.t && tMs <= b.t) {
      const span = b.t - a.t;
      const frac = span === 0 ? 0 : (tMs - a.t) / span;
      return a.throttle + (b.throttle - a.throttle) * frac;
    }
  }
  return last.throttle;
}

export function profileDurationMs(points) {
  if (!points || points.length === 0) return 0;
  return points[points.length - 1].t;
}
