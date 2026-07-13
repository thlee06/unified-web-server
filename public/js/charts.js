// Small categorical palette for multi-series charts (load groups, individual
// temperature probes). Reused by index rather than tied to any specific
// channel, so it scales to however many series a module reports.
export const SERIES_COLORS = ['#EF6320', '#2E7D8C', '#3E8E5A', '#8A5FBF', '#C9A227', '#B4551F'];

export function seriesColor(i) {
  return SERIES_COLORS[i % SERIES_COLORS.length];
}

export function toPath(vals, w, h, pad) {
  if (!vals || vals.length === 0) return '';
  if (vals.length === 1) {
    const y = h / 2;
    return `0,${y.toFixed(1)} ${w.toFixed(1)},${y.toFixed(1)}`;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  return vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function toArea(vals, w, h, pad) {
  const line = toPath(vals, w, h, pad);
  if (!line) return '';
  return `0,${h} ${line} ${w},${h}`;
}

// Decimate to roughly maxPoints so repaint cost stays flat regardless of how
// fast the transport is producing samples.
export function decimate(vals, maxPoints) {
  if (vals.length <= maxPoints) return vals;
  const step = vals.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(vals[Math.floor(i * step)]);
  return out;
}
