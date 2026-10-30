import { TransportError } from '../client.js';
import type { LatencyStat } from '../types.js';
import { call, describe, type ProbeContext } from './context.js';
import { finding } from './registry.js';

/** Nearest-rank percentile of a list of numbers (p in 0..100). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function summarizeTimings(timings: { method: string; ms: number }[]): LatencyStat[] {
  const byMethod = new Map<string, number[]>();
  for (const t of timings) {
    const list = byMethod.get(t.method) ?? [];
    list.push(t.ms);
    byMethod.set(t.method, list);
  }
  return [...byMethod].map(([method, ms]) => ({
    method,
    count: ms.length,
    p50: Math.round(percentile(ms, 50)),
    p95: Math.round(percentile(ms, 95)),
    min: Math.round(Math.min(...ms)),
    max: Math.round(Math.max(...ms)),
  }));
}

/** Repeat tools/list to get a latency distribution, then judge the protocol methods. */
export async function runLatency(ctx: ProbeContext): Promise<void> {
  const failures: string[] = [];
  for (let i = 0; i < ctx.opts.latencyRuns; i++) {
    const r = await call(ctx, 'tools/list');
    if (r instanceof TransportError || !r.response || r.response.error) failures.push(describe(r));
  }
  if (failures.length > 0) {
    ctx.add(finding('latency.failed', `${failures.length} of ${ctx.opts.latencyRuns} repeated tools/list requests failed; first: ${failures[0]}`));
  }
}

/** Findings from the timings of every request made during the probe. */
export function latencyFindings(ctx: ProbeContext, stats: LatencyStat[]): void {
  const parts = stats
    .filter((s) => !s.method.startsWith('notifications/') && s.method !== 'tools/call')
    .map((s) => (s.count > 1 ? `${s.method} p50 ${s.p50} ms, p95 ${s.p95} ms (${s.count} requests)` : `${s.method} ${s.p50} ms`));
  if (parts.length > 0) ctx.add(finding('latency.summary', parts.join('; ')));
  for (const s of stats) {
    if (s.method === 'tools/call' || s.method.startsWith('notifications/')) continue;
    if (s.p95 > ctx.opts.slowMs) ctx.add(finding('latency.slow', `${s.method} p95 ${s.p95} ms is above ${ctx.opts.slowMs} ms`, s.method));
  }
}
