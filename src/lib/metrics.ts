// In-memory server metrics for the dashboard's Blink Server → Health view. Like the
// log ring buffer (lib/log-buffer.ts), this lives in the single cPanel/Passenger
// process: a rolling window of request samples (→ req/min, error rate, avg latency,
// per-minute latency percentiles and a status-code breakdown) plus process vitals
// sampled on a 1s interval (event-loop lag, CPU). Nothing is persisted. Exposed to
// super admins via GET /metrics.
import { performance } from "node:perf_hooks";
import { getHostStats, type HostStats } from "./host-stats";

interface Sample {
  ts: number;
  status: number;
  ms: number;
}

const MINUTE = 60_000;
const RECENT_MS = MINUTE; // headline window: req/min, error rate, avg latency
const BUCKETS = 10; // per-minute latency buckets shown on the chart
const HISTORY_MS = BUCKETS * MINUTE; // how far back samples are retained
const MAX_SAMPLES = 50_000; // hard cap so a traffic spike can't grow this unbounded
const samples: Sample[] = [];

/** Record one completed request. Called from the metrics middleware. */
export function recordRequest(method: string, route: string, status: number, ms: number): void {
  const now = Date.now();
  samples.push({ ts: now, status, ms });
  const cutoff = now - HISTORY_MS;
  while (samples.length && samples[0].ts < cutoff) samples.shift();
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  // `route` is the matched Hono route pattern (e.g. "/trips/:id", or "/*" for an
  // unmatched 404), so the endpoint map is bounded to the registered route set + "/*"
  // regardless of scanner/404 path noise — no per-id explosion, no leaderboard spam.
  bumpMinute(method, route, status, ms);
}

// Vitals sampled on a 1s interval: event-loop lag from timer drift, CPU% from
// process.cpuUsage() deltas. Held as the latest sampled value.
let eventLoopLagMs = 0;
let cpuPct = 0;
let started = false;

/** Start the 1s vitals sampler. Idempotent; call once at process boot. */
export function startMetrics(): void {
  if (started) return;
  started = true;
  let prevTime = performance.now();
  let prevCpu = process.cpuUsage();
  const timer = setInterval(() => {
    const now = performance.now();
    const interval = now - prevTime; // ~1000ms; the excess over 1000 is loop lag
    eventLoopLagMs = Math.max(0, interval - 1000);

    const curCpu = process.cpuUsage();
    const cpuMicros = curCpu.user - prevCpu.user + (curCpu.system - prevCpu.system);
    const wallMicros = interval * 1000;
    // % of a single core over the interval (Node is effectively single-threaded).
    cpuPct = wallMicros > 0 ? Math.min(100, (cpuMicros / wallMicros) * 100) : 0;

    prevTime = now;
    prevCpu = curCpu;
  }, 1000);
  // Don't keep the process alive just for metrics sampling.
  timer.unref();
}

// Nearest-rank percentile of an unsorted array of latencies (ms). q in [0,1].
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return Math.round(sorted[idx]);
}

export interface LatencyBucket {
  offsetMin: number; // minute offset from the current minute: 0 (now), -1, … -9.
  // The dashboard localizes this to a tick label — never bake display copy here.
  p50: number;
  p95: number;
  count: number;
}

export interface StatusBreakdown {
  c2xx: number;
  c3xx: number;
  c4xx: number;
  c5xx: number;
}

export interface MetricsSnapshot {
  uptimeMs: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  cpuPct: number;
  eventLoopLagMs: number;
  reqPerMin: number;
  errorRatePct: number; // share of responses with status >= 500, one decimal
  avgLatencyMs: number;
  latencyBuckets: LatencyBucket[]; // per-minute p50/p95, oldest → newest
  statusCodes: StatusBreakdown; // counts over the full history window
  host: HostStats; // OS/host resource usage (memory, load, disk, uptime)
}

export function getMetrics(): MetricsSnapshot {
  const now = Date.now();
  // Prune at read time too — recordRequest only prunes on write, so during idle a
  // stale batch would otherwise keep inflating the status-code breakdown. Pruning
  // here keeps every derived field (incl. the donut) bounded to the history window.
  const historyCutoff = now - HISTORY_MS;
  while (samples.length && samples[0].ts < historyCutoff) samples.shift();
  const nowMin = Math.floor(now / MINUTE);
  const recentCutoff = now - RECENT_MS;

  // Headline (last 60s) accumulators + per-minute latency grouping + status counts,
  // in a single pass over the retained samples.
  let recentN = 0;
  let recentErrors = 0;
  let recentTotalMs = 0;
  const byMin = new Map<number, number[]>();
  const statusCodes: StatusBreakdown = { c2xx: 0, c3xx: 0, c4xx: 0, c5xx: 0 };

  for (const s of samples) {
    if (s.status >= 500) statusCodes.c5xx++;
    else if (s.status >= 400) statusCodes.c4xx++;
    else if (s.status >= 300) statusCodes.c3xx++;
    else if (s.status >= 200) statusCodes.c2xx++;

    if (s.ts >= recentCutoff) {
      recentN++;
      recentTotalMs += s.ms;
      if (s.status >= 500) recentErrors++;
    }

    const min = Math.floor(s.ts / MINUTE);
    if (min > nowMin - BUCKETS) {
      let arr = byMin.get(min);
      if (!arr) {
        arr = [];
        byMin.set(min, arr);
      }
      arr.push(s.ms);
    }
  }

  const latencyBuckets: LatencyBucket[] = [];
  for (let i = BUCKETS - 1; i >= 0; i--) {
    const min = nowMin - i;
    const arr = byMin.get(min) ?? [];
    const offset = min - nowMin; // 0 (now) or negative
    latencyBuckets.push({
      offsetMin: offset,
      p50: percentile(arr, 0.5),
      p95: percentile(arr, 0.95),
      count: arr.length,
    });
  }

  const mem = process.memoryUsage();
  return {
    uptimeMs: Math.round(process.uptime() * 1000),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    cpuPct: Math.round(cpuPct),
    eventLoopLagMs: Math.round(eventLoopLagMs),
    reqPerMin: recentN,
    errorRatePct: recentN ? Math.round((recentErrors / recentN) * 1000) / 10 : 0,
    avgLatencyMs: recentN ? Math.round(recentTotalMs / recentN) : 0,
    latencyBuckets,
    statusCodes,
    host: getHostStats(),
  };
}

// ── Traffic analytics (Blink Server → Traffic, Phase 4) ──────────────────────
// Per-minute aggregates kept for up to 24h so the dashboard can range over
// 15m / 1h / 24h without retaining raw samples. Each minute holds totals, a
// status-class split, and a bounded per-endpoint roll-up (the route set is small).
const TRAFFIC_HISTORY_MIN = 24 * 60;

interface EndpointAgg {
  hits: number;
  totalMs: number;
  errors: number;
}
interface MinuteAgg {
  count: number;
  errors: number;
  totalMs: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  endpoints: Map<string, EndpointAgg>;
}
const minutes = new Map<number, MinuteAgg>();

function bumpMinute(method: string, route: string, status: number, ms: number): void {
  const min = Math.floor(Date.now() / MINUTE);
  let b = minutes.get(min);
  if (!b) {
    b = { count: 0, errors: 0, totalMs: 0, s2: 0, s3: 0, s4: 0, s5: 0, endpoints: new Map() };
    minutes.set(min, b);
    // New minute → prune buckets older than the 24h window (runs ≤ once per minute).
    const cutoff = min - TRAFFIC_HISTORY_MIN;
    for (const k of minutes.keys()) if (k < cutoff) minutes.delete(k);
  }
  b.count++;
  b.totalMs += ms;
  if (status >= 500) {
    b.errors++;
    b.s5++;
  } else if (status >= 400) b.s4++;
  else if (status >= 300) b.s3++;
  else if (status >= 200) b.s2++;

  const key = `${method} ${route}`;
  let e = b.endpoints.get(key);
  if (!e) {
    e = { hits: 0, totalMs: 0, errors: 0 };
    b.endpoints.set(key, e);
  }
  e.hits++;
  e.totalMs += ms;
  if (status >= 500) e.errors++;
}

export interface TopEndpoint {
  method: string;
  route: string;
  hits: number;
  avgMs: number;
  errPct: number;
}
export interface VolumePoint {
  offsetMin: number; // sub-bucket start, minutes from now (0 = current); localized client-side
  count: number;
}
export interface TrafficSnapshot {
  rangeMin: number;
  totalRequests: number;
  avgRps: number;
  errorRatePct: number;
  distinctRoutes: number;
  statusCodes: StatusBreakdown;
  topEndpoints: TopEndpoint[];
  volume: VolumePoint[];
}

const VOLUME_BUCKETS = 12;

export function getTraffic(rangeMin: number): TrafficSnapshot {
  const nowMin = Math.floor(Date.now() / MINUTE);
  // Prune at read time too — bumpMinute only prunes on write, so an idle period
  // would otherwise retain buckets past the 24h window (mirrors getMetrics).
  const pruneCutoff = nowMin - TRAFFIC_HISTORY_MIN;
  for (const k of minutes.keys()) if (k < pruneCutoff) minutes.delete(k);
  const startMin = nowMin - rangeMin + 1;

  let total = 0;
  let errors = 0;
  const status: StatusBreakdown = { c2xx: 0, c3xx: 0, c4xx: 0, c5xx: 0 };
  const epMap = new Map<string, EndpointAgg>();

  for (let mi = startMin; mi <= nowMin; mi++) {
    const b = minutes.get(mi);
    if (!b) continue;
    total += b.count;
    errors += b.errors;
    status.c2xx += b.s2;
    status.c3xx += b.s3;
    status.c4xx += b.s4;
    status.c5xx += b.s5;
    for (const [k, e] of b.endpoints) {
      let agg = epMap.get(k);
      if (!agg) {
        agg = { hits: 0, totalMs: 0, errors: 0 };
        epMap.set(k, agg);
      }
      agg.hits += e.hits;
      agg.totalMs += e.totalMs;
      agg.errors += e.errors;
    }
  }

  const topEndpoints: TopEndpoint[] = [...epMap.entries()]
    .map(([k, e]) => {
      const sp = k.indexOf(" ");
      return {
        method: k.slice(0, sp),
        route: k.slice(sp + 1),
        hits: e.hits,
        avgMs: e.hits ? Math.round(e.totalMs / e.hits) : 0,
        errPct: e.hits ? Math.round((e.errors / e.hits) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 8);

  const subSize = Math.max(1, Math.ceil(rangeMin / VOLUME_BUCKETS));
  const volume: VolumePoint[] = [];
  for (let s = 0; s < rangeMin; s += subSize) {
    const from = startMin + s;
    const to = Math.min(nowMin, from + subSize - 1);
    let c = 0;
    for (let mi = from; mi <= to; mi++) {
      const b = minutes.get(mi);
      if (b) c += b.count;
    }
    volume.push({ offsetMin: from - nowMin, count: c });
  }

  const rangeSec = rangeMin * 60;
  return {
    rangeMin,
    totalRequests: total,
    avgRps: rangeSec ? Math.round((total / rangeSec) * 10) / 10 : 0,
    errorRatePct: total ? Math.round((errors / total) * 1000) / 10 : 0,
    distinctRoutes: epMap.size,
    statusCodes: status,
    topEndpoints,
    volume,
  };
}
