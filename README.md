# Unified Web Server

A central dashboard server for motor/ESC test rigs. ESP32 modules push sensor
readings over WebSocket; the server relays them in real time to a browser
dashboard showing one live chart panel per module, all synced on a shared
timeline.

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

Two mock ESP32s are included:

```sh
npm run sim:module-a   # 6 channels @ 8Hz
npm run sim:module-b   # 2 channels @ 5Hz
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
  "module": "esc_test_1",
  "name": "ESC Test Rig 1",
  "channels": {
    "force_n": { "label": "Force", "unit": "N" },
    "temp_c":  { "label": "Temp",  "unit": "°C" }
  }
}
```

### `sample` (send one per reading, at whatever rate you sample)

```json
{
  "type": "sample",
  "module": "esc_test_1",
  "ts": 1720444800123,
  "values": { "force_n": 12.3, "temp_c": 45.6, "rpm": 8200 }
}
```

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

## Project layout

```
server/
  index.js            HTTP server bootstrap, static file serving, WS upgrade routing
  config.js            Port/history/heartbeat constants
  moduleRegistry.js     In-memory module state + event bus (module/sample/status)
  ingestServer.js       WS endpoint for ESP32 modules (/ingest)
  dashboardServer.js    WS endpoint for browser dashboards (/dashboard)
public/
  index.html, style.css, app.js   Dashboard frontend (vanilla JS, no build step)
  vendor/               Vendored uPlot charting library
tools/
  simulate-module.js    Mock ESP32 for testing without hardware
```

No database, no auth, no bundler - this is a small LAN-only tool. Live view
only for now; there's no persistence/logging of past runs yet.
