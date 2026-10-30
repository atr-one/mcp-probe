import { readFile } from 'node:fs/promises';
import { SEVERITY_RANK, type Finding, type Report } from './types.js';
import type { FailOn } from './report.js';

/** A figure in both reports; a side is undefined when that report does not have it (a skipped check, no connection). */
export interface Delta {
  previous?: number;
  current?: number;
  /** current - previous, when both are known. */
  delta?: number;
}

export interface ReportComparison {
  previous: { url: string; startedAt: string; version: string };
  /** Findings of the current report that the previous one did not have, most severe first. */
  newFindings: Finding[];
  /** Findings of the previous report that are no longer there, most severe first. */
  goneFindings: Finding[];
  /** Estimated context tokens of the tool catalog. */
  tokens: Delta;
  toolCount: Delta;
  /** p50 of tools/list in milliseconds. */
  toolsListP50: Delta;
  toolsAdded: string[];
  toolsRemoved: string[];
}

function delta(previous: number | undefined, current: number | undefined): Delta {
  const d: Delta = {};
  if (previous !== undefined) d.previous = previous;
  if (current !== undefined) d.current = current;
  if (previous !== undefined && current !== undefined) d.delta = current - previous;
  return d;
}

const key = (f: Finding): string => `${f.id}\u0000${f.subject ?? ''}`;
const bySeverity = (a: Finding, b: Finding): number => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];

/**
 * What changed between two reports. A finding is identified by its check id and subject; the message is not
 * part of the identity, because it carries figures (milliseconds, token counts) that differ on every run. When
 * one id and subject occur several times, identical messages are paired first and the surplus on either side
 * is new or gone.
 */
export function compareReports(previous: Report, current: Report): ReportComparison {
  const prev = new Map<string, Finding[]>();
  for (const f of previous.findings) prev.set(key(f), [...(prev.get(key(f)) ?? []), f]);
  const curr = new Map<string, Finding[]>();
  for (const f of current.findings) curr.set(key(f), [...(curr.get(key(f)) ?? []), f]);

  const newFindings: Finding[] = [];
  const goneFindings: Finding[] = [];
  for (const k of new Set([...prev.keys(), ...curr.keys()])) {
    const p = [...(prev.get(k) ?? [])];
    const c = [...(curr.get(k) ?? [])];
    // pair identical messages, then pair the rest in order; what is left over is new or gone
    for (let i = c.length - 1; i >= 0; i--) {
      const j = p.findIndex((x) => x.message === c[i]!.message);
      if (j >= 0) {
        p.splice(j, 1);
        c.splice(i, 1);
      }
    }
    const paired = Math.min(p.length, c.length);
    newFindings.push(...c.slice(paired));
    goneFindings.push(...p.slice(paired));
  }

  const p50 = (r: Report): number | undefined => r.latency.find((l) => l.method === 'tools/list')?.p50;
  const prevNames = new Set(previous.tools.names);
  const currNames = new Set(current.tools.names);
  return {
    previous: { url: previous.url, startedAt: previous.startedAt, version: previous.probe.version },
    newFindings: newFindings.sort(bySeverity),
    goneFindings: goneFindings.sort(bySeverity),
    tokens: delta(previous.cost?.tokens, current.cost?.tokens),
    toolCount: delta(previous.server ? previous.tools.count : undefined, current.server ? current.tools.count : undefined),
    toolsListP50: delta(p50(previous), p50(current)),
    toolsAdded: current.tools.names.filter((n) => !prevNames.has(n)),
    toolsRemoved: previous.tools.names.filter((n) => !currNames.has(n)),
  };
}

/** Like exitCode, but only new findings count: 0 ok, 1 new findings at or above `failOn`, 2 no connection. */
export function exitCodeForNew(current: Report, comparison: ReportComparison, failOn: FailOn = 'error'): number {
  if (!current.connected) return 2;
  if (failOn === 'never') return 0;
  const threshold = SEVERITY_RANK[failOn];
  return comparison.newFindings.some((f) => SEVERITY_RANK[f.severity] >= threshold) ? 1 : 0;
}

/** Check that parsed JSON looks like an mcp-probe report; throws an Error naming what is wrong. */
export function asReport(data: unknown, source = 'baseline'): Report {
  const r = data as Partial<Report> | null;
  if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new Error(`${source}: not a JSON object`);
  if (r.probe?.name !== 'mcp-probe') throw new Error(`${source}: not an mcp-probe JSON report (no probe.name "mcp-probe")`);
  if (!Array.isArray(r.findings) || !r.tools || !Array.isArray(r.tools.names) || !Array.isArray(r.latency)) {
    throw new Error(`${source}: findings, tools.names or latency is missing`);
  }
  return r as Report;
}

/** Read a JSON report written earlier with --json. */
export async function loadReport(file: string): Promise<Report> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`${file}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`);
  }
  return asReport(data, file);
}
