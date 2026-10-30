import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { asReport, compareReports, exitCodeForNew, loadReport } from '../src/compare.js';
import { emptyReport } from '../src/probe.js';
import { exitCode, formatConsole, formatMarkdown, resultCode } from '../src/report.js';
import type { Finding, Report } from '../src/types.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const read = (name: string): Report => JSON.parse(readFileSync(fixture(name), 'utf8')) as Report;
const before = read('report-before.json');
const after = read('report-after.json');
const brief = (fs: Finding[]): string[] => fs.map((f) => `${f.severity} ${f.id} ${f.subject ?? ''}`.trim());

describe('compareReports', () => {
  it('lists new and gone findings, most severe first', () => {
    const c = compareReports(before, after);
    expect(brief(c.newFindings)).toEqual(['error tools.description_missing get_forecast', 'info tools.annotations_missing get_forecast']);
    expect(brief(c.goneFindings)).toEqual(['warn tools.description_short Search Docs!', 'warn tools.param_description Search Docs!']);
  });

  it('does not count a finding whose figures changed as new', () => {
    // latency.summary, cost.summary and scenario.passed carry other milliseconds and token counts in after
    const c = compareReports(before, after);
    const changed = ['latency.summary', 'cost.summary', 'cost.heaviest', 'scenario.passed'];
    expect([...c.newFindings, ...c.goneFindings].filter((f) => changed.includes(f.id))).toEqual([]);
  });

  it('reports the deltas of tokens, tool count and tools/list p50', () => {
    const c = compareReports(before, after);
    expect(c.tokens).toEqual({ previous: 154, current: 231, delta: 77 });
    expect(c.toolCount).toEqual({ previous: 2, current: 3, delta: 1 });
    expect(c.toolsListP50).toEqual({ previous: 15, current: 22, delta: 7 });
    expect(c.toolsAdded).toEqual(['get_forecast']);
    expect(c.toolsRemoved).toEqual([]);
    expect(c.previous).toEqual({ url: before.url, startedAt: '2026-10-29T06:00:00.000Z', version: before.probe.version });
  });

  it('finds nothing new when a report is compared with itself', () => {
    const c = compareReports(after, after);
    expect([c.newFindings, c.goneFindings]).toEqual([[], []]);
    expect(c.tokens.delta).toBe(0);
  });

  it('pairs repeated findings of one check and subject by message, then counts the surplus', () => {
    const f = (message: string): Finding => ({ id: 'tools.input_schema_invalid', severity: 'error', message, hint: 'h', subject: 't' });
    const a = { ...emptyReport('http://x'), findings: [f('$.a: bad'), f('$.b: bad')] };
    const b = { ...emptyReport('http://x'), findings: [f('$.b: bad'), f('$.c: bad'), f('$.d: bad')] };
    const c = compareReports(a, b);
    // $.b pairs exactly; $.a and $.c pair as the same finding with a new message; $.d is the surplus
    expect(c.newFindings.map((x) => x.message)).toEqual(['$.d: bad']);
    expect(c.goneFindings).toEqual([]);
  });

  it('leaves a figure open when one report does not have it', () => {
    const down = emptyReport('http://x');
    const c = compareReports(before, down);
    expect(c.tokens).toEqual({ previous: 154 });
    expect(c.toolCount).toEqual({ previous: 2 });
    expect(c.toolsRemoved).toEqual(['get_weather', 'Search Docs!']);
  });
});

describe('exit codes against a baseline', () => {
  it('fails only on new findings at or above --fail-on', () => {
    const c = compareReports(before, after);
    expect(exitCode(after, 'error')).toBe(1);
    expect(exitCodeForNew(after, c, 'error')).toBe(1); // the new description_missing error
    expect(exitCodeForNew(after, c, 'never')).toBe(0);

    // the known errors of before alone do not fail the run
    const same = compareReports(before, before);
    expect(exitCode(before, 'warn')).toBe(1);
    expect(exitCodeForNew(before, same, 'warn')).toBe(0);
    expect(resultCode(before, { failOn: 'warn', comparison: same, failOnNew: true })).toBe(0);
    expect(resultCode(before, { failOn: 'warn', comparison: same })).toBe(1);
  });

  it('still exits 2 without a connection', () => {
    const down = emptyReport('http://x');
    expect(exitCodeForNew(down, compareReports(before, down), 'never')).toBe(2);
  });
});

describe('reports with a comparison', () => {
  it('adds a section to the console output', () => {
    const c = compareReports(before, after);
    const text = formatConsole(after, { comparison: c, failOn: 'error', failOnNew: true });
    expect(text).toContain('Compared with the baseline (probed 2026-10-29T06:00:00.000Z');
    expect(text).toMatch(/Context\s+154 -> 231 \(\+77\) tokens/);
    expect(text).toMatch(/Tools\s+2 -> 3 \(\+1\); added get_forecast/);
    expect(text).toMatch(/tools\/list p50 15 ms -> 22 ms \(\+7\)/);
    expect(text).toMatch(/New\s+1 error, 1 info\n\s+error\s+tools\.description_missing\s+get_forecast: No description/);
    expect(text).toMatch(/Gone\s+2 warnings/);
    expect(text).toContain('fails at --fail-on error, new findings only (exit 1)');
  });

  it('adds a section to the Markdown report', () => {
    const md = formatMarkdown(after, { comparison: compareReports(before, after), failOn: 'warn', failOnNew: true });
    expect(md).toContain('## Compared with the baseline');
    expect(md).toContain('| Context tokens | 154 -> 231 (+77) |');
    expect(md).toContain('| Tools added | get_forecast |');
    expect(md).toContain('### New findings: 1 error, 1 info');
    expect(md).toContain('| error | `tools.description_missing` | get_forecast | No description |');
    expect(md).toContain('### Gone findings: 2 warnings');
    expect(md).toContain('fails at --fail-on warn, new findings only (exit 1)');
  });
});

describe('loading a baseline', () => {
  it('reads a JSON report', async () => {
    const r = await loadReport(fixture('report-before.json'));
    expect(r.tools.count).toBe(2);
  });

  it('names what is wrong with a file that is not a report', async () => {
    await expect(loadReport(fixture('no-such-report.json'))).rejects.toThrow(/no such file/);
    await expect(loadReport(fixture('mock-server.mjs'))).rejects.toThrow(/not valid JSON/);
    expect(() => asReport([])).toThrow(/not a JSON object/);
    expect(() => asReport({ findings: [] })).toThrow(/not an mcp-probe JSON report/);
    expect(() => asReport({ probe: { name: 'mcp-probe' } })).toThrow(/findings, tools.names or latency is missing/);
  });

  it('takes --baseline and --fail-on-new on the command line', () => {
    const a = parseArgs(['http://x/mcp', '--baseline', 'prev.json', '--fail-on-new', '--fail-on', 'warn']);
    expect([a.baseline, a.failOnNew, a.failOn]).toEqual(['prev.json', true, 'warn']);
    expect(parseArgs(['http://x/mcp']).failOnNew).toBe(false);
    expect(() => parseArgs(['http://x/mcp', '--fail-on-new'])).toThrow(/needs --baseline/);
  });
});
