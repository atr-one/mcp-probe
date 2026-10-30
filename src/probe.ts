import { McpClient } from './client.js';
import { catalogCost, costFindings } from './checks/cost.js';
import type { ProbeContext, ResolvedOptions } from './checks/context.js';
import { runErrorContract } from './checks/errors.js';
import { runExtras } from './checks/extras.js';
import { runHandshake } from './checks/handshake.js';
import { latencyFindings, runLatency, summarizeTimings } from './checks/latency.js';
import { finding } from './checks/registry.js';
import { loadScenarios, runScenarios } from './checks/scenarios.js';
import { lintTools, listTools } from './checks/tools.js';
import type { ProbeOptions, Report, Scenario } from './types.js';
import { VERSION } from './version.js';

export const DEFAULTS = { timeoutMs: 20_000, tokenBudget: 8_000, latencyRuns: 5, slowMs: 2_000 } as const;

function resolve(options: ProbeOptions): ResolvedOptions {
  const num = (v: number | undefined, d: number, min: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d);
  const o: ResolvedOptions = {
    headers: { ...(options.headers ?? {}) },
    timeoutMs: num(options.timeoutMs, DEFAULTS.timeoutMs, 1),
    tokenBudget: num(options.tokenBudget, DEFAULTS.tokenBudget, 0),
    latencyRuns: Math.floor(num(options.latencyRuns, DEFAULTS.latencyRuns, 0)),
    slowMs: num(options.slowMs, DEFAULTS.slowMs, 0),
    skip: new Set(options.skip ?? []),
    onProgress: options.onProgress ?? (() => undefined),
  };
  if (options.scenarios) o.scenarios = options.scenarios;
  if (options.scenarioFile) o.scenarioFile = options.scenarioFile;
  if (options.fetch) o.fetch = options.fetch;
  return o;
}

export function emptyReport(url: string): Report {
  return {
    schemaVersion: 1,
    probe: { name: 'mcp-probe', version: VERSION },
    url,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    connected: false,
    tools: { count: 0, names: [] },
    latency: [],
    scenarios: [],
    findings: [],
    summary: { error: 0, warn: 0, info: 0 },
  };
}

/**
 * Audit the MCP server at `url` (Streamable HTTP) and return the report. Never throws for server-side
 * problems: they become findings. Throws only for an invalid URL.
 */
export async function probe(url: string, options: ProbeOptions = {}): Promise<Report> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError(`Not an http(s) URL: ${url}`);
  const opts = resolve(options);
  const started = performance.now();
  const report = emptyReport(url);
  const clientOptions: ConstructorParameters<typeof McpClient>[1] = { headers: opts.headers, timeoutMs: opts.timeoutMs };
  if (opts.fetch) clientOptions.fetch = opts.fetch;
  const client = new McpClient(url, clientOptions);
  const ctx: ProbeContext = { client, report, opts, add: (f) => report.findings.push(f) };
  const step = opts.onProgress;

  // scenarios are read first: a broken file should not cost a whole run to discover
  let scenarios: Scenario[] | undefined = opts.scenarios;
  if (!scenarios && opts.scenarioFile && !opts.skip.has('scenarios')) {
    try {
      scenarios = await loadScenarios(opts.scenarioFile);
    } catch (e) {
      ctx.add(finding('scenario.file', (e as Error).message));
    }
  }

  try {
    step('initialize');
    const init = await runHandshake(ctx);
    if (init) {
      step('tools/list');
      const tools = await listTools(ctx);
      if (tools) {
        report.tools = { count: tools.length, names: tools.map((t) => t.name) };
        if (!opts.skip.has('tools')) lintTools(tools).forEach(ctx.add);
        if (!opts.skip.has('cost')) {
          report.cost = catalogCost(tools, opts.tokenBudget, init.instructions);
          costFindings(report.cost, tools.length).forEach(ctx.add);
        }
      }
      if (!opts.skip.has('latency') && opts.latencyRuns > 0) {
        step(`latency (${opts.latencyRuns} x tools/list)`);
        await runLatency(ctx);
      }
      if (!opts.skip.has('errors') && tools) {
        step('error contract');
        await runErrorContract(ctx, tools);
      }
      if (!opts.skip.has('scenarios') && scenarios && scenarios.length > 0) {
        step(`scenarios (${scenarios.length})`);
        await runScenarios(ctx, scenarios, tools);
      }
      if (!opts.skip.has('resources')) {
        step('resources and prompts');
        await runExtras(ctx, init.capabilities);
      }
      await client.close();
    }
  } finally {
    report.latency = summarizeTimings(client.timings);
    if (report.server && !opts.skip.has('latency')) latencyFindings(ctx, report.latency);
    for (const f of report.findings) report.summary[f.severity]++;
    report.durationMs = Math.round(performance.now() - started);
  }
  return report;
}
