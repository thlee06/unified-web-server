# TestStand Console

A guided data-acquisition console for ESP32 test-rig modules. Modules push
sensor readings over WebSocket; the server relays them in real time to a
browser UI that walks researchers through the workflow a trustworthy
measurement actually requires: **Calibrate → Collect → Analyze**.

Two modules currently exist:

- **Diagnostic board** (`diag_board_1`) - 6 independent temperature probes
  (`a0_c`-`a5_c`), no load channels. Calibrate only asks you to verify each
  probe; Collect/Analyze chart all 6 individually.
- **Thrust stand** (`thrust_stand_1`) - 4 HX711 load cell channels wired as
  two parallel pairs: `ch0`+`ch1` (5kg pair) and `ch2`+`ch3` (20kg pair).
  Each pair is calibrated and charted as a single averaged logical channel,
  not 4 separate ones - see "Channel naming" below.

- **Devices** - at-a-glance status for every connected module, routing you
  into the right next step.
- **Calibrate** - tare/zero and known-load capture (least-squares scale fit)
  per load-channel group, plus a temperature-probe checklist. Calibration
  records persist to disk and expire after 30 days. A finished calibration
  can be saved as a named profile and reloaded later instead of redoing the
  tare/load steps.
- **Collect** - live per-channel plots (one line per load group, one per
  temperature probe), guarded so you cannot start a recording on an
  uncalibrated (or expired) module. Finished recordings are saved as named
  runs.
- **Analyze** - pick a run, see its per-channel stats and full charts, export
  CSV or a text report.
- **HOTAS Control** - a standalone control screen, separate from the
  Devices/Calibrate/Collect/Analyze telemetry pipeline above. Reads a USB
  HOTAS throttle axis via the browser's Gamepad API and streams it directly
  (not through this server) to a dedicated ESP32 running ESC-arming firmware,
  over its own WebSocket server. Arming is gated by a physical multi-button
  gesture on the HOTAS itself, and includes an autopilot mode: plan a
  throttle-vs-time thrust profile in a chart/table editor, then launch it
  from the HOTAS to have the ESC run it autonomously. See "HOTAS control
  wire protocol" below.

## Quickstart

```sh
npm install
npm start
```

This prints the LAN address to open, e.g. `http://192.168.1.42:8080`, and the
ingest endpoint your ESP32 firmware should connect to:
`ws://192.168.1.42:8080/ingest`.

Open the printed URL in a browser. With no modules connected yet it shows
"Waiting for modules to connect...".

### Try it without hardware

Mock versions of both real modules are included:

```sh
npm run sim:diag     # diag_board_1   - 6 temp channels @ 5Hz
npm run sim:thrust   # thrust_stand_1 - 4 load-cell channels @ 5Hz
```

Run each in its own terminal, then refresh the dashboard - two panels appear
and update live. Ctrl+C a simulator to see its panel go offline; restart it to
see it come back online and resume.

For a custom simulated module:

```sh
node tools/simulate-module.js --module my_module --name "My Module" \
  --hz 10 --channels force_n:N,temp_c:°C,rpm:rpm
```

Add `--corrupt` to also send occasional malformed frames, to confirm the
server logs and drops them without crashing.

## Wire protocol (for real ESP32 firmware)

Modules connect over WebSocket to `/ingest` (e.g.
`ws://<server-host>:8080/ingest`) and send JSON text frames.

### `hello` (optional, send once after connecting)

Gives the module a friendly name and channel metadata (label/unit). Not
required - if omitted, the server infers a display name and channel labels
from whatever keys show up in `sample.values`.

```json
{
  "type": "hello",
  "module": "thrust_stand_1",
  "name": "Thrust Stand 1",
  "channels": {
    "ch0": { "label": "Ch0", "unit": "cts" },
    "ch1": { "label": "Ch1", "unit": "cts" },
    "ch2": { "label": "Ch2 20kg", "unit": "cts" },
    "ch3": { "label": "Ch3 20kg", "unit": "cts" }
  }
}
```

### `sample` (send one per reading, at whatever rate you sample)

```json
{
  "type": "sample",
  "module": "thrust_stand_1",
  "ts": 1720444800123,
  "values": { "ch0": 12345, "ch1": 12290, "ch2": 1482310, "ch3": 1491205 }
}
```

`values` may also be sparse - the diagnostic board omits a channel entirely
for the one sample where its sensor reads open/short-circuit, rather than
sending a sentinel value. The server accepts anywhere from 0 to N keys per
sample without erroring.

Notes:
- `module` is a free-form id matching `^[A-Za-z0-9_-]+$`. It's the only thing
  identifying a module - first message from a new id auto-registers it, no
  server config needed. Reusing an id from a new connection (e.g. after a
  firmware reset) is fine; the old connection is dropped and the new one
  takes over.
- `values` can contain any set of numeric channels, and the set can change
  over time (e.g. a module reporting 2 values today can report 4 tomorrow)
  with no server changes required.
- `ts` is optional and purely informational - the server uses its own
  receive time as the canonical timestamp for charting, since ESP32 clocks
  aren't synced to each other and this guarantees one consistent axis across
  all modules.
- Non-numeric values are dropped (with a warning logged), and malformed JSON
  frames are ignored - neither will crash the server or drop the connection.
- If a module stops responding to WebSocket pings for about 15 seconds, it's
  marked offline on the dashboard.

### Channel naming (for the guided workflow)

The Calibrate/Collect/Analyze screens classify every channel a module
reports, and *every* channel gets surfaced - there's no single "primary"
channel that hides the rest:

- A channel is a **temperature probe** if its `unit` is some form of `°C`
  (also matches on `temp` in the key/label as a fallback for modules that
  don't send `hello`). Each probe gets its own line on the temperature
  charts and its own row in Calibrate's probe checklist - they are never
  averaged together, since the point of a multi-probe board is to catch one
  probe drifting relative to the others.
- Every remaining (non-temperature) channel is a **load channel**, grouped
  into one or more **load channel groups** - each group gets its own
  tare/zero + known-load scale fit in Calibrate, and its own line on the
  load charts. By default each load channel is its own group of one (this is
  what any generic/unknown module gets, e.g. a single load cell).
  `thrust_stand_1` is special-cased in `public/js/calibration.js`
  (`CHANNEL_GROUP_CONFIG`) because its 4 raw ADC channels are wired as two
  parallel pairs sharing one physical load path each: `ch0`+`ch1` (5kg
  pair) and `ch2`+`ch3` (20kg pair). A group's reading is the average of its
  member channels, both spatially (across the paired channels) and
  temporally (across the recent settled window, when recording a zero or a
  load point) - if you wire up another module with multiple channels feeding
  one physical sensor, add it to that same config.

A module with zero load channels (the diagnostic board) skips the
tare/known-load steps in Calibrate entirely and only needs its probes
verified. A calibrated module's zero/scale/probe state can be saved as a
named **profile** and reloaded later to skip recalibration.

## HOTAS control wire protocol

Unlike every other module, the HOTAS ESC-throttle ESP32 does not connect to
this server at all - it runs its own WebSocket server on port `81` and the
browser's HOTAS Control tab connects to it directly (`ws://<esp32-host>:81/`),
since this is a low-latency control loop, not telemetry.

Browser → ESP32 (JSON text frames):
- `{"type":"arm"}` for a normal manual arm, or `{"type":"arm","autopilot":true}`
  to arm into an autopilot-armed holding state instead (see below).
  `autopilot` is sampled from button 26's state at the moment the arm
  request is sent, but the field is only included when `true` - the browser
  deliberately does **not** send `autopilot:false`, so a plain manual arm
  stays byte-for-byte identical to the message format from before this
  feature existed. This isn't just tidiness: firmware that hasn't been
  updated yet may have its JSON parse buffer sized tightly for the old,
  shorter message, and did in practice fail to parse the arm request at all
  once an unconditional `autopilot:false` field was added - dropping every
  arm attempt silently. Updated firmware should read this field with
  ArduinoJson's default-value idiom, `doc["autopilot"] | false`, so an
  absent field and an explicit `false` are equivalent either way.
- `{"type":"throttle","value":0.0}` - `value` is `0.0`-`1.0`, sent at ~30Hz
  while the mapped gamepad axis is live. Sent continuously regardless of
  mode; the firmware should ignore it whenever it isn't in plain manual
  `ARMED` state (i.e. while `DISARMED`, `ARMING`, `AUTOPILOT_ARMED`, or
  `AUTOPILOT_RUNNING`).
- `{"type":"disarm"}` - explicit disarm. Must abort *any* mode immediately -
  manual, autopilot-armed-waiting, or a running profile - and force the PWM
  output back to idle. This is the universal kill switch; nothing about
  autopilot mode should require a different disarm path.
- `{"type":"upload_profile","points":[{"t":0,"throttle":0.0},{"t":5000,"throttle":0.6},...]}` -
  replaces the ESP32's in-memory thrust profile. `t` is milliseconds from
  profile start, `throttle` is `0.0`-`1.0`. Points arrive already sorted by
  `t` and deduplicated/clamped/bounded (see `normalizePoints()` in
  `public/js/thrustProfile.js` - max 64 points, max 5 minute span), but
  firmware should still validate defensively rather than trust the browser
  blindly. Can arrive at any time, including while disarmed; storage is
  RAM-only (cleared on reboot) - the browser re-uploads the active profile
  on every reconnect and every edit, so nothing needs to persist across a
  power cycle.
- `{"type":"launch_autopilot"}` - only meaningful while the ESP32 reports
  `mode: "autopilot_armed"`; starts executing the currently-stored profile
  from `t=0` on the ESP32's own clock. Sent by the browser once button 25
  has been held continuously for 3 seconds.

ESP32 → Browser:
- `{"type":"status","armed":true,"mode":"manual","pwm_us":1500,"uptime_ms":123456,"autopilot_elapsed_ms":null}` -
  sent on every state change plus a ~5Hz heartbeat. `mode` is one of
  `"manual"`, `"autopilot_armed"`, or `"autopilot_running"`.
  `autopilot_elapsed_ms` is the profile-relative elapsed time (only
  meaningful, i.e. non-null, while `mode` is `"autopilot_running"`) - the
  browser uses it to drive a live progress marker on the profile chart. The
  browser's client already defaults a missing `mode` field to `"manual"`,
  so this is additive/backward-compatible with firmware that hasn't been
  updated yet.

The firmware treats silence as a fault: no `throttle`/`arm` frame for 300ms
while armed forces the PWM output back to idle (1000&micro;s) and drops back
to disarmed, and a fresh connection always starts disarmed regardless of
prior state. This 300ms firmware timeout is the *only* thing that disarms on
loss of signal - the browser does not proactively disarm on tab visibility
changes. The polling/send loop in `hotasControl.js` runs on `setInterval`,
not `requestAnimationFrame`, specifically so a browser tab losing focus or
being briefly backgrounded (e.g. glancing at the ESP32 right after arming)
doesn't itself cut off outgoing throttle frames - `requestAnimationFrame`
callbacks are fully paused by browsers the instant a tab is hidden, which
used to trip the firmware's failsafe on every incidental tab switch. Note
this doesn't fully defeat browser background-tab timer throttling (Chrome
clamps backgrounded timers to roughly 1/sec), so switching away from the
browser tab for any real length of time - as opposed to a brief glance while
it stays visible - will still likely trip the 300ms firmware failsafe; that's
the intended backstop, not a bug. The browser does still send an explicit
disarm on `beforeunload` (actually closing/navigating away from the page).
It deliberately does **not** disarm when you merely switch between this
app's own tabs (e.g. to Collect) - see `public/js/hotasControl.js` below.
The gamepad axis mapping (which axis is "throttle", and whether it's
inverted) is chosen in the UI per-device and persisted in the browser's
`localStorage`, since a HOTAS throttle unit can map to different axis
indices across browsers/OSes. Axes `2`, `5`, and `6` are additionally
hardware-inverted unconditionally (`HARDWARE_INVERTED_AXES` in
`hotasControl.js`) because they read backwards on this particular
controller - this is separate from, and applied before, the per-mapping
invert checkbox.

Arming itself is gated by a physical five-button gesture on the HOTAS (not a
clickable UI button): hold buttons 15+16, then hold 30+31 for 3 seconds,
then flip button 23 from off to on. Buttons 15+16 aren't just a one-time
gate to *start* arming - they're a continuous dead-man's interlock. Losing
either one at any point (including after you're already armed, or if the
gamepad disconnects entirely) sends an explicit disarm frame immediately,
not just a local reset of the arming-sequence UI state; before this it was
possible to release 15/16 (or hit Emergency disarm) while a throttle value
kept streaming and have the ESC output keep responding, because nothing
after the initial arming gesture was still watching the interlock. This is
enforced client-side in `hotasControl.js` and visualized live as a 3-step
sequence on the HOTAS Control tab. Button 23's
"off to on" requirement is tracked as "was 23 observed off at any point
during this attempt" (`seq.masterOffSeen`), not a single-tick edge - a
literal single-frame edge check turned out to be too precise for real human
timing, since flipping 23 right around the same moment the 3-second hold
completes could land on the wrong side of the stage transition and get
missed entirely.

The WS connection, gamepad polling loop, and arm-sequence state all live in
`public/js/hotasControl.js` as a persistent singleton, not inside the HOTAS
Control view - they start once at page load and keep running regardless of
which tab is active, which is what lets the Collect page show a live
throttle readout without requiring you to stay on the HOTAS tab.

### Autopilot mode

The HOTAS Control tab includes a thrust-profile editor (`public/js/thrustProfile.js`
for the data model/persistence, the chart/table UI lives in
`public/js/views/hotas.js`): a piecewise-linear throttle-vs-time curve, edited
either by dragging points on an SVG chart or typing exact values into a
per-point time/throttle table. Profiles are named, saved to the browser's
`localStorage` (this bypasses the Node server entirely, same as everything
else HOTAS-related), and the currently-active one is uploaded to the ESP32
automatically on every edit (debounced ~300ms) and on every reconnect.

Autopilot is selected, not toggled independently of arming: button 26's
state *at the moment the arm request goes out* decides the mode for that
arm cycle - held on, the ESP32 should come up in a new `AUTOPILOT_ARMED`
state instead of plain `ARMED`, holding at idle PWM and ignoring stick
throttle, and wait for the browser's `launch_autopilot` command (sent after
button 25 is held 3 seconds) before transitioning to `AUTOPILOT_RUNNING` and
executing the stored profile from its own internal timer - piecewise-linear
interpolation between points, holding at the first point's value before
`t=0` is reached. Reaching the final point's time ends the run - force idle
PWM and return to `DISARMED`, the same "default to the most-idle state"
philosophy as every other safety transition in this system, rather than
holding the last value or looping. Button 26 being off at arm time is
unchanged from today: normal `ARMED`, manual stick control.

This preserves every existing safety property rather than adding a
parallel/separate one: the 15+16 dead-man's interlock, the 300ms failsafe,
and `{"type":"disarm"}` must all still immediately halt an in-progress
autopilot run exactly as they already halt manual throttle, since none of
that logic is mode-specific on the browser side (see `disarmOrReset()` in
`hotasControl.js`) and shouldn't become mode-specific on the firmware side
either.

## Firmware

The HOTAS ESC controller firmware (the ESP32 sketch that implements the wire
protocol above) lives in `firmware/`, a git **submodule** pointing at its own
PlatformIO project/repo - it isn't part of this repo's own history. Clone
with `git clone --recurse-submodules`, or after a plain clone run:

```sh
git submodule update --init --recursive
```

**As of the current submodule commit, the firmware only implements the
pre-autopilot protocol** - plain `arm`/`throttle`/`disarm`/`upload_profile`
plus a `run_profile` command, no `mode`/`autopilot_elapsed_ms` in `status`,
and no `autopilot` arm flag. It needs the following changes (in
`firmware/src/main.cpp` and `firmware/src/BuzzerDriver.h`) to match the
protocol documented above:

- Extend `ArmState` with `AUTOPILOT_ARMED` and `AUTOPILOT_RUNNING`, and give
  the pending arm request a way to carry the requested mode from `arm`
  through the existing `ARMING` hold (e.g. a `bool armingAutopilot` on
  `Rig`, read from `doc["autopilot"] | false` in the `arm` handler). When the
  `ARM_HOLD_MS` hold completes, transition to `AUTOPILOT_ARMED` instead of
  `ARMED` if it was set.
- Replace the `run_profile` message handler with `launch_autopilot`, gated on
  `rig.state == AUTOPILOT_ARMED` (not `ARMED`) and `profile.count >= 2`;
  on success, transition to `AUTOPILOT_RUNNING` and record `profile.startMs`.
- In `sendStatusNow()`, add `mode` (`"manual"` / `"autopilot_armed"` /
  `"autopilot_running"`, derived from `rig.state`) and `autopilot_elapsed_ms`
  (only included, i.e. non-null, while `AUTOPILOT_RUNNING` - `millis() -
  profile.startMs`). `armed` should be `true` for `ARMED`, `AUTOPILOT_ARMED`,
  and `AUTOPILOT_RUNNING` alike.
- `tickProfile()` should run whenever `rig.state == AUTOPILOT_RUNNING`
  (currently gated on `ARMED`), and on reaching the final point's time it
  must force idle PWM and fall all the way back to `DISARMED` - not hold the
  last throttle value, which is what it does today.
- The `throttle` message handler already only applies stick input when
  `rig.state == ARMED`, so `AUTOPILOT_ARMED`/`AUTOPILOT_RUNNING` are silently
  ignored there for free once they're separate enum values - no change
  needed beyond making sure they don't fall into that branch.
- Broaden the failsafe check and the LED "armed" state to treat
  `AUTOPILOT_ARMED`/`AUTOPILOT_RUNNING` the same as `ARMED`, since the
  universal 300ms-no-frame kill switch and the solid-on armed LED shouldn't
  be manual-mode-specific.
- Add distinct buzzer patterns for autopilot-armed, launch, and
  run-complete, so they're audibly distinguishable from the existing manual
  arm/disarm tones.

## Project layout

```
server/
  index.js            HTTP server bootstrap, static file serving, WS upgrade routing
  config.js            Port/history/heartbeat constants
  moduleRegistry.js     In-memory module state + event bus (module/sample/status)
  ingestServer.js       WS endpoint for ESP32 modules (/ingest)
  dashboardServer.js    WS endpoint for browser dashboards (/dashboard)
  store.js             JSON-file persistence for calibration records, profiles + runs
  apiRoutes.js          REST API: /api/calibrations, /api/profiles, /api/runs
  data/                 (generated, gitignored) persisted store.json
public/
  index.html, style.css   App shell + design system
  js/app.js              Entry point: render loop, tab router, boot sequence
  js/state.js             Central store (pub/sub)
  js/ws.js                 /dashboard WS client -> store
  js/liveBus.js            High-frequency sample events (charts, readouts)
  js/recorder.js            Collect recording buffer + run finalization
  js/calibration.js         Zero/scale-fit math, channel grouping, isCalibrated()
  js/charts.js               SVG polyline helpers + series color palette
  js/api.js, js/format.js     REST client, formatting helpers
  js/hotasControl.js            Persistent HOTAS WS/gamepad/arm-sequence singleton (survives tab switches)
  js/thrustProfile.js           Thrust-profile data model: localStorage-backed named profiles, interpolation
  js/views/                    devices.js, calibrate.js, collect.js, analyze.js, hotas.js
  vendor/               Vendored uPlot charting library (unused by the current UI)
tools/
  simulate-module.js    Mock ESP32 for testing without hardware
firmware/               Git submodule: ESP32 HOTAS ESC controller (PlatformIO) - see "Firmware" above
```

No database, no auth, no bundler - this is a small LAN-only tool. Calibration
records and completed runs persist to `server/data/store.json` so they
survive a server restart, but there's still no auth or multi-user support.
