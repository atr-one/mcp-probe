import { exitCodeForNew, type Delta, type ReportComparison } from './compare.js';
import { SEVERITY_RANK, type Finding, type Report, type Severity } from './types.js';

export type FailOn = Severity | 'never';

export interface CompareOptions {
  failOn?: FailOn;
  /** A comparison with an earlier report (compareReports), shown as its own section. */
  comparison?: ReportComparison;
  /** Only the new findings of the comparison decide the exit code. */
  failOnNew?: boolean;
}

/** The exit code for these options: exitCode, or exitCodeForNew when failOnNew is set with a comparison. */
export function resultCode(report: Report, options: CompareOptions = {}): number {
  const failOn = options.failOn ?? 'error';
  return options.failOnNew && options.comparison ? exitCodeForNew(report, options.comparison, failOn) : exitCode(report, failOn);
}

/** 0 ok, 1 findings at or above `failOn`, 2 no connection. */
export function exitCode(report: Report, failOn: FailOn = 'error'): number {
  if (!report.connected) return 2;
  if (failOn === 'never') return 0;
  const threshold = SEVERITY_RANK[failOn];
  return report.findings.some((f) => SEVERITY_RANK[f.severity] >= threshold) ? 1 : 0;
}

/** Findings ordered error, warn, info, grouped by check id in order of first appearance. */
export function groupFindings(findings: Finding[]): { id: string; severity: Severity; hint: string; items: Finding[] }[] {
  const groups = new Map<string, { id: string; severity: Severity; hint: string; items: Finding[] }>();
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  for (const f of sorted) {
    const g = groups.get(f.id) ?? { id: f.id, severity: f.severity, hint: f.hint, items: [] };
    g.items.push(f);
    groups.set(f.id, g);
  }
  return [...groups.values()];
}

const fmt = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

function line(f: Finding): string {
  return f.subject ? `${f.subject}: ${f.message}` : f.message;
}

const signed = (n: number): string => (n > 0 ? '+' : n < 0 ? '-' : '+') + fmt(Math.abs(n));

/** "154 -> 180 (+26)", "n/a -> 180" */
function showDelta(d: Delta, unit = ''): string {
  const side = (v: number | undefined): string => (v === undefined ? 'n/a' : fmt(v) + unit);
  return `${side(d.previous)} -> ${side(d.current)}` + (d.delta !== undefined ? ` (${signed(d.delta)})` : '');
}

function countBySeverity(findings: Finding[]): string {
  const n = (sev: Severity): number => findings.filter((f) => f.severity === sev).length;
  const parts = [n('error') ? plural(n('error'), 'error') : '', n('warn') ? plural(n('warn'), 'warning') : '', n('info') ? `${n('info')} info` : ''];
  return parts.filter(Boolean).join(', ') || 'none';
}

function verdict(report: Report, options: CompareOptions): string {
  const failOn = options.failOn ?? 'error';
  const scope = options.failOnNew && options.comparison ? `--fail-on ${failOn}, new findings only` : `--fail-on ${failOn}`;
  const code = resultCode(report, options);
  if (code === 2) return 'could not connect';
  if (code === 1) return `fails at ${scope}`;
  return options.failOnNew && options.comparison ? `passes at ${scope}` : 'passes';
}

interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  green(s: string): string;
}

function style(color: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), green: wrap(32, 39) };
}

export interface ConsoleOptions extends CompareOptions {
  color?: boolean;
  /** Lines shown per check before "... and N more". Default 5. */
  maxPerCheck?: number;
}

export function formatConsole(report: Report, options: ConsoleOptions = {}): string {
  const s = style(options.color ?? false);
  const max = options.maxPerCheck ?? 5;
  const out: string[] = [];
  const label = (k: string) => '  ' + s.dim(k.padEnd(10));

  out.push(`${s.bold('mcp-probe')} ${report.probe.version}  ${report.url}`);
  out.push('');
  const srv = report.server;
  if (srv) {
    const traits = [srv.protocolVersion ? `protocol ${srv.protocolVersion}` : '', srv.transport === 'sse' ? 'SSE answers' : 'JSON answers', srv.sessionId ? 'session id' : 'stateless'].filter(Boolean);
    out.push(label('Server') + `${srv.name ?? '(no name)'} ${srv.version ?? ''}`.trim() + ` (${traits.join(', ')})`);
  } else {
    out.push(label('Server') + (report.connected ? 'handshake failed' : 'not reached'));
  }
  if (srv) {
    const cost = report.cost ? `, ~${fmt(report.cost.tokens)} tokens in context (budget ${fmt(report.cost.budget)})` : '';
    out.push(label('Tools') + `${report.tools.count}${cost}`);
    if (report.resources !== undefined || report.prompts !== undefined) {
      out.push(label('Extras') + [report.resources !== undefined ? plural(report.resources, 'resource') : '', report.prompts !== undefined ? plural(report.prompts, 'prompt') : ''].filter(Boolean).join(', '));
    }
  }
  const lat = report.latency.filter((l) => ['initialize', 'ping', 'tools/list'].includes(l.method));
  if (lat.length > 0) {
    out.push(label('Latency') + lat.map((l) => (l.count > 1 ? `${l.method} p50 ${l.p50} ms / p95 ${l.p95} ms (${l.count})` : `${l.method} ${l.p50} ms`)).join('; '));
  }
  if (report.scenarios.length > 0) {
    const passed = report.scenarios.filter((x) => x.passed).length;
    const failed = report.scenarios.length - passed;
    out.push(label('Scenarios') + `${passed} passed` + (failed ? `, ${s.red(failed + ' failed')}` : ''));
  }

  const titles: Record<Severity, string> = { error: s.red(s.bold('ERRORS')), warn: s.yellow(s.bold('WARNINGS')), info: s.cyan(s.bold('INFO')) };
  let current: Severity | undefined;
  for (const g of groupFindings(report.findings)) {
    if (g.severity !== current) {
      current = g.severity;
      out.push('', titles[g.severity]);
    }
    const color = g.severity === 'error' ? s.red : g.severity === 'warn' ? s.yellow : s.cyan;
    const count = g.items.length > 1 ? s.dim(` (${g.items.length})`) : '';
    out.push(`  ${color(g.id)}${count}`);
    for (const f of g.items.slice(0, max)) out.push(`    ${line(f)}`);
    if (g.items.length > max) {
      const rest = g.items.slice(max).map((f) => f.subject).filter(Boolean);
      out.push(s.dim(`    ... and ${g.items.length - max} more${rest.length ? ': ' + rest.slice(0, 10).join(', ') + (rest.length > 10 ? ', ...' : '') : ''}`));
    }
    if (g.severity !== 'info') out.push(s.dim(`    fix: ${g.hint}`));
  }

  if (report.cost && report.cost.heaviest.length > 1) {
    out.push('', s.bold('Heaviest tools') + s.dim(' (estimated tokens in context)'));
    const w = Math.max(...report.cost.heaviest.map((t) => t.name.length));
    for (const t of report.cost.heaviest) out.push(`  ${t.name.padEnd(w)}  ${fmt(t.tokens).padStart(6)}`);
  }

  const cmp = options.comparison;
  if (cmp) {
    out.push('', s.bold('Compared with the baseline') + s.dim(` (probed ${cmp.previous.startedAt} with mcp-probe ${cmp.previous.version})`));
    if (cmp.previous.url !== report.url) out.push(label('URL') + `was ${cmp.previous.url}`);
    out.push(label('Context') + showDelta(cmp.tokens) + ' tokens');
    const names = [cmp.toolsAdded.length ? `added ${cmp.toolsAdded.join(', ')}` : '', cmp.toolsRemoved.length ? `removed ${cmp.toolsRemoved.join(', ')}` : ''].filter(Boolean);
    out.push(label('Tools') + showDelta(cmp.toolCount) + (names.length ? `; ${names.join('; ')}` : ''));
    out.push(label('Latency') + 'tools/list p50 ' + showDelta(cmp.toolsListP50, ' ms'));
    const shown = 20;
    for (const [title, findings] of [['New', cmp.newFindings], ['Gone', cmp.goneFindings]] as const) {
      out.push(label(title) + countBySeverity(findings));
      for (const f of findings.slice(0, shown)) {
        const color = f.severity === 'error' ? s.red : f.severity === 'warn' ? s.yellow : s.cyan;
        out.push(`    ${color(f.severity.padEnd(5))}  ${f.id}  ${line(f)}`);
      }
      if (findings.length > shown) out.push(s.dim(`    ... and ${findings.length - shown} more`));
    }
  }

  const { error, warn, info } = report.summary;
  const counts = `${plural(error, 'error')}, ${plural(warn, 'warning')}, ${info} info`;
  const code = resultCode(report, options);
  const text = verdict(report, options);
  out.push('', `${s.bold('Result')}  ${counts} in ${fmt(report.durationMs)} ms; ${code === 0 ? s.green(text) : s.red(text)} (exit ${code})`);
  return out.join('\n') + '\n';
}

const cell = (v: string | number | undefined): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function formatMarkdown(report: Report, options: CompareOptions = {}): string {
  const out: string[] = [];
  const srv = report.server;
  out.push('# mcp-probe report', '');
  out.push(`- URL: ${report.url}`);
  if (srv) {
    out.push(`- Server: ${[srv.name, srv.version].filter(Boolean).join(' ') || '(no name)'}${srv.title ? ` - ${srv.title}` : ''}`);
    out.push(`- Protocol: ${srv.protocolVersion ?? '(none)'}, ${srv.transport === 'sse' ? 'SSE' : 'JSON'} answers, ${srv.sessionId ? 'session id' : 'stateless'}`);
  } else {
    out.push(`- Server: ${report.connected ? 'handshake failed' : 'not reached'}`);
  }
  out.push(`- Tools: ${report.tools.count}${report.resources !== undefined ? `, resources: ${report.resources}` : ''}${report.prompts !== undefined ? `, prompts: ${report.prompts}` : ''}`);
  out.push(`- Probed: ${report.startedAt} in ${fmt(report.durationMs)} ms with mcp-probe ${report.probe.version}`);
  const code = resultCode(report, options);
  const scope = options.comparison && options.failOnNew ? `; ${verdict(report, options)}` : '';
  out.push(`- Result: ${report.summary.error} errors, ${report.summary.warn} warnings, ${report.summary.info} info${scope} (exit ${code})`, '');

  const cmp = options.comparison;
  if (cmp) {
    out.push('## Compared with the baseline', '');
    out.push(`Baseline probed ${cmp.previous.startedAt} with mcp-probe ${cmp.previous.version}${cmp.previous.url !== report.url ? ` at ${cmp.previous.url}` : ''}.`, '');
    out.push('| Figure | Baseline -> now |', '| --- | --- |');
    out.push(`| Context tokens | ${showDelta(cmp.tokens)} |`);
    out.push(`| Tools | ${showDelta(cmp.toolCount)} |`);
    out.push(`| tools/list p50 | ${showDelta(cmp.toolsListP50, ' ms')} |`);
    if (cmp.toolsAdded.length) out.push(`| Tools added | ${cell(cmp.toolsAdded.join(', '))} |`);
    if (cmp.toolsRemoved.length) out.push(`| Tools removed | ${cell(cmp.toolsRemoved.join(', '))} |`);
    out.push('');
    for (const [title, findings] of [['New findings', cmp.newFindings], ['Gone findings', cmp.goneFindings]] as const) {
      out.push(`### ${title}: ${countBySeverity(findings)}`, '');
      if (findings.length === 0) continue;
      out.push('| Severity | Check | Subject | Message |', '| --- | --- | --- | --- |');
      for (const f of findings) out.push(`| ${f.severity} | \`${f.id}\` | ${cell(f.subject)} | ${cell(f.message)} |`);
      out.push('');
    }
  }

  const groups = groupFindings(report.findings);
  if (groups.length > 0) {
    out.push('## Findings', '', '| Severity | Check | Subject | Message |', '| --- | --- | --- | --- |');
    for (const g of groups) for (const f of g.items) out.push(`| ${f.severity} | \`${f.id}\` | ${cell(f.subject)} | ${cell(f.message)} |`);
    const fixes = groups.filter((g) => g.severity !== 'info');
    if (fixes.length > 0) {
      out.push('', '### How to fix', '');
      for (const g of fixes) out.push(`- \`${g.id}\`: ${g.hint}`);
    }
    out.push('');
  }

  if (report.cost) {
    const c = report.cost;
    out.push('## Context cost', '');
    out.push(`~${fmt(c.tokens)} estimated tokens (${fmt(c.chars)} chars of name + description + inputSchema; ${fmt(c.wireChars)} chars on the wire), budget ${fmt(c.budget)}.${c.instructionsTokens ? ` Instructions add ~${fmt(c.instructionsTokens)} tokens.` : ''}`, '');
    out.push('| Tool | Chars | Est. tokens |', '| --- | ---: | ---: |');
    for (const t of c.heaviest) out.push(`| ${cell(t.name)} | ${fmt(t.chars)} | ${fmt(t.tokens)} |`);
    out.push('');
  }

  if (report.latency.length > 0) {
    out.push('## Latency', '', '| Method | Requests | p50 ms | p95 ms | max ms |', '| --- | ---: | ---: | ---: | ---: |');
    for (const l of report.latency) out.push(`| ${l.method} | ${l.count} | ${l.p50} | ${l.p95} | ${l.max} |`);
    out.push('');
  }

  if (report.scenarios.length > 0) {
    out.push('## Scenarios', '', '| Scenario | Tool | Result | ms | Notes |', '| --- | --- | --- | ---: | --- |');
    for (const sc of report.scenarios) out.push(`| ${cell(sc.name)} | ${cell(sc.tool)} | ${sc.passed ? 'pass' : 'FAIL'} | ${sc.ms ?? ''} | ${cell(sc.failures.join('; '))} |`);
    out.push('');
  }
  return out.join('\n');
}

export function formatJson(report: Report): string {
  return JSON.stringify(report, null, 2) + '\n';
}
