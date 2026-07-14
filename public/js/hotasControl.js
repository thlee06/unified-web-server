// Persistent, singleton HOTAS control state - deliberately independent of
// which SPA tab is mounted. The WS connection to the ESP32, the gamepad
// polling loop, and the arm sequence all live here and keep running whether
// or not the HOTAS Control view is currently on screen, so e.g. the Collect
// page can show live throttle position while you're driving the stand.
// Only an actual hidden/closed browser tab (visibilitychange/beforeunload)
// or an explicit user action (Disconnect / Emergency disarm) tears anything
// down - switching between this app's own tabs never disarms.
const HOST_KEY = 'hotas.host';
const AXIS_MAP_KEY = 'hotas.axisMap';
const SEND_HZ = 30;
export const ARM_THROTTLE_GATE = 0.15; // must be near idle to arm, mirrors the firmware's own arm sequence

// A few HOTAS axes report backwards relative to the intuitive direction on
// this hardware - correct them once, here, rather than per-mapping so every
// consumer (live meters, throttle math) agrees on axis 2/5/6's sign.
const HARDWARE_INVERTED_AXES = new Set([2, 5, 6]);

// Physical arm gesture on the HOTAS, in order: hold 15+16 (safety interlock),
// then hold 30+31 for HOLD_MS (arm switches), then flip 23 (master arm).
// Releasing 15/16 at any point aborts back to idle - they must stay held
// through the whole gesture.
export const BTN_INTERLOCK = [15, 16];
export const BTN_HOLD = [30, 31];
export const BTN_MASTER = 23;
export const HOLD_MS = 3000;

// Autopilot mode select + launch gesture. Button 26's state is sampled at
// the moment the arm request is sent (bundled into the "arm" message) and
// decides whether the ESP32 comes up armed for manual stick control or
// armed-and-waiting-for-launch. Once in the latter (mode "autopilot_armed",
// as reported by the ESP32), holding button 25 for LAUNCH_MS starts
// executing the uploaded thrust profile.
export const BTN_AUTOPILOT_ENABLE = 26;
export const BTN_LAUNCH = 25;
export const LAUNCH_MS = 3000;

function loadAxisMap() {
  try { return JSON.parse(localStorage.getItem(AXIS_MAP_KEY)) || {}; } catch { return {}; }
}
function saveAxisMap(map) {
  localStorage.setItem(AXIS_MAP_KEY, JSON.stringify(map));
}

export const hotasState = {
  host: localStorage.getItem(HOST_KEY) || 'hotas-esc.local',
  ws: null,
  wsStatus: 'idle', // idle | connecting | open | closed
  armed: false,
  pwmUs: null,
  uptimeMs: null,
  lastStatusAt: null,
  axisMap: loadAxisMap(), // gamepad.id -> { axisIndex, invert }
  selectedGamepadIndex: null,
  throttle: null, // last computed mapped throttle, 0..1, or null if unmapped
  confirmed: false, // mirrors the "confirm safe to energize" checkbox
  seq: {
    stage: 'idle', // idle -> interlock -> holding -> ready -> (arm sent)
    holdStartedAt: null,
    armSent: false,
    // Set the moment button 23 is observed OFF at any point during this
    // attempt (interlock/holding/ready). Arming requires this to be true so
    // a switch left "on" from an earlier attempt can't silently re-arm, but
    // it deliberately isn't tied to one exact tick - a human flipping 23
    // right around the 3-second hold boundary shouldn't have the edge
    // "missed" by a stage transition landing on the wrong frame.
    masterOffSeen: false,
  },
  autopilotEnabled: false, // live mirror of button 26, independent of arm state
  mode: 'manual', // 'manual' | 'autopilot_armed' | 'autopilot_running', as reported by the ESP32
  autopilotElapsedMs: null,
  launch: { holdStartedAt: null, sent: false }, // button-25 3s launch hold, only relevant while mode === 'autopilot_armed'
};

const listeners = new Set();
export function onHotasChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn(hotasState);
}

function sendJSON(obj) {
  if (hotasState.ws && hotasState.ws.readyState === WebSocket.OPEN) hotasState.ws.send(JSON.stringify(obj));
}

function resetSequence() {
  hotasState.seq.stage = 'idle';
  hotasState.seq.holdStartedAt = null;
  hotasState.seq.armSent = false;
  hotasState.seq.masterOffSeen = false;
}

function resetLaunch() {
  hotasState.launch.holdStartedAt = null;
  hotasState.launch.sent = false;
}

// Deliberately omit the `autopilot` field entirely rather than always
// sending `autopilot:false` - keeps the manual-arm message byte-for-byte
// identical to before the autopilot feature existed, so firmware that
// hasn't been updated yet (and may have sized its JSON parse buffer
// tightly for the old, shorter message) isn't broken by an extra field it
// never asked for. Firmware that *has* been updated should read this with
// `doc["autopilot"] | false` (ArduinoJson's default-value idiom), so an
// absent field and an explicit `false` are equivalent either way.
function requestArm(autopilot) { sendJSON(autopilot ? { type: 'arm', autopilot: true } : { type: 'arm' }); }

export function requestHotasDisarm() {
  sendJSON({ type: 'disarm' });
  hotasState.armed = false;
  hotasState.mode = 'manual';
  hotasState.autopilotElapsedMs = null;
  resetSequence();
  resetLaunch();
  notify();
}

export function setHotasConfirmed(value) {
  hotasState.confirmed = value;
}

// Sends the currently-edited profile to the ESP32 ahead of arming with
// autopilot enabled. Ownership of *which* profile is active, and its
// content, lives in the view/thrustProfile.js - this just relays points.
export function uploadProfile(points) {
  sendJSON({ type: 'upload_profile', points: points.map((p) => ({ t: Math.round(p.t), throttle: p.throttle })) });
}

export function connectHotas(host) {
  hotasState.ws?.close();
  if (host) hotasState.host = host;
  localStorage.setItem(HOST_KEY, hotasState.host);

  hotasState.wsStatus = 'connecting';
  notify();

  const ws = new WebSocket(`ws://${hotasState.host}:81/`);
  hotasState.ws = ws;

  ws.addEventListener('open', () => {
    hotasState.wsStatus = 'open';
    notify();
  });
  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'status') {
      hotasState.armed = !!msg.armed;
      hotasState.pwmUs = msg.pwm_us;
      hotasState.uptimeMs = msg.uptime_ms;
      // Older firmware without autopilot support won't send `mode` at all -
      // fall back to 'manual' so the UI doesn't show an undefined state.
      hotasState.mode = msg.mode || 'manual';
      hotasState.autopilotElapsedMs = msg.autopilot_elapsed_ms ?? null;
      hotasState.lastStatusAt = Date.now();
      if (hotasState.mode !== 'autopilot_armed') resetLaunch();
      notify();
    }
  });
  ws.addEventListener('close', () => {
    hotasState.wsStatus = 'closed';
    hotasState.armed = false;
    hotasState.mode = 'manual';
    hotasState.autopilotElapsedMs = null;
    hotasState.ws = null;
    resetSequence();
    resetLaunch();
    notify();
  });
  ws.addEventListener('error', () => ws.close());
}

export function disconnectHotas() {
  hotasState.ws?.close();
}

export function setAxisMapping(gamepadId, axisIndex, invert) {
  hotasState.axisMap[gamepadId] = { axisIndex, invert };
  saveAxisMap(hotasState.axisMap);
}

export function selectGamepad(index) {
  hotasState.selectedGamepadIndex = index;
}

export function connectedPads() {
  return Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean);
}

export function buttonOn(pad, index) {
  const b = pad?.buttons?.[index];
  return !!(b && (b.pressed || b.value > 0.5));
}

// Hardware-corrected raw axis value, -1..1. Everything that reads a raw axis
// (live meters, throttle mapping) should go through this, not pad.axes[i]
// directly, so axis 2/5/6's permanent inversion is applied exactly once.
export function rawAxis(pad, index) {
  const v = pad.axes[index] ?? 0;
  return HARDWARE_INVERTED_AXES.has(index) ? -v : v;
}

function mappedThrottle() {
  const pads = connectedPads();
  const pad = pads.find((p) => p.index === hotasState.selectedGamepadIndex);
  if (!pad) return null;
  const mapping = hotasState.axisMap[pad.id];
  if (!mapping || mapping.axisIndex >= pad.axes.length) return null;
  const raw = rawAxis(pad, mapping.axisIndex); // -1..1, hardware-corrected
  let normalized = (raw + 1) / 2; // 0..1
  if (mapping.invert) normalized = 1 - normalized;
  return Math.min(1, Math.max(0, normalized));
}

// Buttons 15+16 are a continuous dead-man's interlock, not just a one-time
// gate to start arming: losing either one - at any point, not only during
// the arming gesture itself - immediately disarms for real (sends the WS
// disarm frame), it doesn't just reset the local sequence tracker. Before
// this, releasing 15/16 (or the gamepad disconnecting) after arming left the
// ESP32 fully armed with nothing watching the interlock anymore.
function disarmOrReset(seq) {
  if (hotasState.armed || seq.armSent) requestHotasDisarm();
  else resetSequence();
}

function advanceSequence(selectedPad, throttle) {
  const seq = hotasState.seq;
  if (!selectedPad) {
    disarmOrReset(seq);
    return;
  }

  const interlockOn = BTN_INTERLOCK.every((i) => buttonOn(selectedPad, i));
  const holdOn = BTN_HOLD.every((i) => buttonOn(selectedPad, i));
  const masterOn = buttonOn(selectedPad, BTN_MASTER);

  if (!interlockOn) {
    disarmOrReset(seq);
    return;
  }

  if (seq.stage === 'idle') seq.stage = 'interlock';

  if (seq.stage === 'interlock' || seq.stage === 'holding' || seq.stage === 'ready') {
    if (!masterOn) seq.masterOffSeen = true;
  }

  if (seq.stage === 'interlock' || seq.stage === 'holding') {
    if (holdOn) {
      if (seq.stage === 'interlock') {
        seq.stage = 'holding';
        seq.holdStartedAt = performance.now();
      }
      if (performance.now() - seq.holdStartedAt >= HOLD_MS) {
        seq.stage = 'ready';
      }
    } else if (seq.stage === 'holding') {
      seq.stage = 'interlock';
      seq.holdStartedAt = null;
    }
  }

  if (seq.stage === 'ready' && masterOn && seq.masterOffSeen && !seq.armSent) {
    const gated = hotasState.wsStatus === 'open' && !hotasState.armed && hotasState.confirmed
      && throttle !== null && throttle < ARM_THROTTLE_GATE;
    if (gated) {
      requestArm(buttonOn(selectedPad, BTN_AUTOPILOT_ENABLE));
      seq.armSent = true;
    }
  }
}

// Button 25, held for LAUNCH_MS while the ESP32 reports mode
// "autopilot_armed", launches profile execution. Only meaningful in that
// mode - anywhere else (including mid-hold if the mode changes out from
// under it, e.g. an interlock-triggered disarm) the hold resets to zero
// rather than carrying a stale partial hold into a different context.
function advanceAutopilotLaunch(selectedPad) {
  const launch = hotasState.launch;
  if (hotasState.mode !== 'autopilot_armed' || !selectedPad || !buttonOn(selectedPad, BTN_LAUNCH)) {
    launch.holdStartedAt = null;
    launch.sent = false;
    return;
  }
  if (launch.holdStartedAt === null) launch.holdStartedAt = performance.now();
  if (!launch.sent && performance.now() - launch.holdStartedAt >= LAUNCH_MS) {
    sendJSON({ type: 'launch_autopilot' });
    launch.sent = true;
  }
}

function tick() {
  const pads = connectedPads();
  if (hotasState.selectedGamepadIndex === null || !pads.some((p) => p.index === hotasState.selectedGamepadIndex)) {
    hotasState.selectedGamepadIndex = pads[0]?.index ?? null;
  }
  const selectedPad = pads.find((p) => p.index === hotasState.selectedGamepadIndex) || null;

  hotasState.throttle = mappedThrottle();
  hotasState.autopilotEnabled = selectedPad ? buttonOn(selectedPad, BTN_AUTOPILOT_ENABLE) : false;
  advanceSequence(selectedPad, hotasState.throttle);
  advanceAutopilotLaunch(selectedPad);

  if (hotasState.ws && hotasState.ws.readyState === WebSocket.OPEN && hotasState.throttle !== null) {
    sendJSON({ type: 'throttle', value: hotasState.throttle });
  }

  notify();
}

// Driven by setInterval, not requestAnimationFrame: browsers fully pause rAF
// callbacks the instant a tab is backgrounded, which would silently stop
// outgoing throttle frames and trip the ESP32's 300ms failsafe the moment
// you glance away from the browser (e.g. to look at the ESP32 itself right
// after arming). setInterval keeps firing - a brief look elsewhere no longer
// hard-disarms. Note this doesn't fully defeat browser background-tab timer
// clamping (Chrome clamps backgrounded timers to ~1/sec), so switching
// browser tabs or minimizing the window for any real length of time will
// still likely trip the firmware's 300ms failsafe - that's the ESP32 acting
// correctly on a genuine gap in frames, not a bug here.
if (typeof setInterval === 'function') {
  setInterval(tick, 1000 / SEND_HZ);
}

// Deliberately does NOT proactively disarm on document.hidden anymore - that
// used to race ahead of (and duplicate) the firmware's own failsafe and
// disarmed on every tab switch, which is stricter than "tolerate brief
// glances away." The firmware's 300ms no-frame timeout remains the actual
// safety backstop; this is just cleanup for when the tab is truly closed.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => sendJSON({ type: 'disarm' }));
}
