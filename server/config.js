export const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// How many samples to keep per module so a freshly-opened dashboard tab
// can be seeded with recent history instead of starting blank.
export const HISTORY_MAX_POINTS = 1200; // ~2 min at 10Hz

// How often the server pings each ingest socket. A module that misses one
// full interval without a pong back is terminated and marked offline.
export const HEARTBEAT_INTERVAL_MS = 15000;
