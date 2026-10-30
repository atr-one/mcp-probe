import { SEVERITY_RANK, type Finding, type Report, type Severity } from './types.js';

export type FailOn = Severity | 'never';

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

export interface ConsoleOptions {
  color?: boolean;
  failOn?: FailOn;
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

  const { error, warn, info } = report.summary;
  const counts = `${plural(error, 'error')}, ${plural(warn, 'warning')}, ${info} info`;
  const failOn = options.failOn ?? 'error';
  const code = exitCode(report, failOn);
  const verdict = code === 2 ? s.red('could not connect') : code === 1 ? s.red(`fails at --fail-on ${failOn}`) : s.green('passes');
  out.push('', `${s.bold('Result')}  ${counts} in ${fmt(report.durationMs)} ms; ${verdict} (exit ${code})`);
  return out.join('\n') + '\n';
}

const cell = (v: string | number | undefined): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function formatMarkdown(report: Report, options: { failOn?: FailOn } = {}): string {
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
  const code = exitCode(report, options.failOn ?? 'error');
  out.push(`- Result: ${report.summary.error} errors, ${report.summary.warn} warnings, ${report.summary.info} info (exit ${code})`, '');

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
