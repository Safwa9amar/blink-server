// Host-level resource stats for the dashboard's Blink Server → Health "Host resources"
// card — read purely from the OS / process (no cPanel API token). These are
// whole-machine figures for the server host (the shared hosting box), not an account
// quota: memory + disk + load average + uptime.
import os from "node:os";
import { statfsSync } from "node:fs";

export interface HostStats {
  memUsed: number;
  memTotal: number;
  cpuCount: number;
  loadAvg: number[]; // [1m, 5m, 15m]
  diskUsed: number;
  diskTotal: number;
  sysUptimeMs: number;
  node: string;
  platform: string;
}

export function getHostStats(): HostStats {
  const memTotal = os.totalmem();
  const memUsed = memTotal - os.freemem();

  let diskUsed = 0;
  let diskTotal = 0;
  try {
    const st = statfsSync(process.cwd());
    diskTotal = st.blocks * st.bsize;
    diskUsed = (st.blocks - st.bfree) * st.bsize;
  } catch {
    /* statfs unavailable — leave 0 */
  }

  return {
    memUsed,
    memTotal,
    cpuCount: os.cpus().length,
    loadAvg: os.loadavg(),
    diskUsed,
    diskTotal,
    sysUptimeMs: Math.round(os.uptime() * 1000),
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
  };
}
