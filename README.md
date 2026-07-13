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
  js/views/                    devices.js, calibrate.js, collect.js, analyze.js
  vendor/               Vendored uPlot charting library (unused by the current UI)
tools/
  simulate-module.js    Mock ESP32 for testing without hardware
```

No database, no auth, no bundler - this is a small LAN-only tool. Calibration
records and completed runs persist to `server/data/store.json` so they
survive a server restart, but there's still no auth or multi-user support.
