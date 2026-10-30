#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { USAGE, UsageError, parseArgs } from './args.js';
import { CHECKS } from './checks/registry.js';
import { compareReports, loadReport } from './compare.js';
import { probe } from './probe.js';
import { formatConsole, formatJson, formatMarkdown, resultCode, type CompareOptions } from './report.js';
import type { Report } from './types.js';
import { VERSION } from './version.js';

function useColor(flag: boolean | undefined): boolean {
  if (flag !== undefined) return flag;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`mcp-probe: ${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (args.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (args.listChecks) {
    const w = Math.max(...Object.keys(CHECKS).map((k) => k.length));
    for (const [id, def] of Object.entries(CHECKS)) process.stdout.write(`${id.padEnd(w)}  ${def.severity.padEnd(5)}  ${def.title}\n`);
    return 0;
  }
  if (!args.url) {
    process.stderr.write(`mcp-probe: the server URL is missing\n\n${USAGE}\n`);
    return 2;
  }
  try {
    const u = new URL(args.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    process.stderr.write(`mcp-probe: not an http(s) URL: ${args.url}\n`);
    return 2;
  }

  // the baseline is read first: a wrong path should not cost a whole run to discover
  let baseline: Report | undefined;
  if (args.baseline) {
    try {
      baseline = await loadReport(args.baseline);
    } catch (e) {
      process.stderr.write(`mcp-probe: --baseline ${(e as Error).message}\n`);
      return 2;
    }
  }

  const progress = process.stderr.isTTY;
  const report = await probe(args.url, {
    headers: args.headers,
    timeoutMs: args.timeoutMs,
    tokenBudget: args.budget,
    latencyRuns: args.runs,
    skip: args.skip,
    ...(args.scenario ? { scenarioFile: args.scenario } : {}),
    onProgress: progress ? (step) => process.stderr.write(`\r\x1b[Kprobing: ${step}`) : undefined,
  });
  if (progress) process.stderr.write('\r\x1b[K');

  const outcome: CompareOptions = { failOn: args.failOn, failOnNew: args.failOnNew };
  if (baseline) outcome.comparison = compareReports(baseline, report);
  process.stdout.write(formatConsole(report, { ...outcome, color: useColor(args.color) }));
  if (args.json) await writeFile(args.json, formatJson(report), 'utf8');
  if (args.md) await writeFile(args.md, formatMarkdown(report, outcome), 'utf8');
  return resultCode(report, outcome);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`mcp-probe: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 2;
  },
);
