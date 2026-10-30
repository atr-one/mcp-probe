import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs, parseDuration, parseHeader } from '../src/args.js';
import { CHECKS } from '../src/checks/registry.js';
import { parseAuthParams } from '../src/checks/handshake.js';
import { percentile } from '../src/checks/latency.js';
import { parseScenarios } from '../src/checks/scenarios.js';
import { emptyReport } from '../src/probe.js';
import { exitCode, formatMarkdown } from '../src/report.js';
import { VERSION } from '../src/version.js';

describe('parseArgs', () => {
  it('reads the URL and options', () => {
    const a = parseArgs(['https://x.test/mcp', '-H', 'Authorization: Bearer a:b', '--header=X-Key: 1', '--fail-on', 'warn', '--timeout', '1500ms', '--skip', 'latency,errors', '--json', 'r.json', '--md=r.md', '--runs', '0']);
    expect(a.url).toBe('https://x.test/mcp');
    expect(a.headers).toEqual({ Authorization: 'Bearer a:b', 'X-Key': '1' });
    expect(a.failOn).toBe('warn');
    expect(a.timeoutMs).toBe(1500);
    expect(a.skip).toEqual(['latency', 'errors']);
    expect(a.json).toBe('r.json');
    expect(a.md).toBe('r.md');
    expect(a.runs).toBe(0);
  });

  it('has the documented defaults', () => {
    const a = parseArgs(['http://localhost/mcp']);
    expect([a.failOn, a.timeoutMs, a.budget, a.runs]).toEqual(['error', 20000, 8000, 5]);
  });

  it('rejects bad input', () => {
    expect(() => parseArgs(['--fail-on', 'fatal'])).toThrow(UsageError);
    expect(() => parseArgs(['--skip', 'nope'])).toThrow(/unknown group/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['--json'])).toThrow(/needs a value/);
  });

  it('parses durations and headers', () => {
    expect(parseDuration('20')).toBe(20000);
    expect(parseDuration('2.5s')).toBe(2500);
    expect(parseDuration('1m')).toBe(60000);
    expect(() => parseDuration('soon')).toThrow(UsageError);
    expect(parseHeader('Authorization:  Bearer x ')).toEqual(['Authorization', 'Bearer x']);
    expect(() => parseHeader('no colon')).toThrow(UsageError);
    expect(() => parseHeader('bad name: x')).toThrow(UsageError);
  });
});

describe('parseScenarios', () => {
  it('accepts a list or {scenarios: [...]}', () => {
    expect(parseScenarios([{ tool: 'a' }])).toEqual([{ tool: 'a' }]);
    expect(parseScenarios({ scenarios: [{ tool: 'a', name: 'n', arguments: { x: 1 }, expect: { isError: false, maxMs: 10 } }] })).toEqual([
      { tool: 'a', name: 'n', arguments: { x: 1 }, expect: { isError: false, maxMs: 10 } },
    ]);
  });

  it('names the broken entry', () => {
    expect(() => parseScenarios({})).toThrow(/list of scenarios/);
    expect(() => parseScenarios([{ tool: 'a' }, {}])).toThrow(/scenario 2: "tool"/);
    expect(() => parseScenarios([{ tool: 'a', expect: { contain: 'x' } }])).toThrow(/unknown expect key "contain"/);
    expect(() => parseScenarios([{ tool: 'a', expect: { maxMs: '5' } }])).toThrow(/expect.maxMs must be a number/);
    expect(() => parseScenarios([{ tool: 'a', args: {} }])).toThrow(/unknown key "args"/);
  });
});

describe('helpers', () => {
  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 95)).toBe(10);
  });

  it('parses WWW-Authenticate parameters', () => {
    expect(parseAuthParams('Bearer realm="mcp", resource_metadata="https://a.test/.well-known/oauth-protected-resource/mcp", error=invalid_token')).toEqual({
      realm: 'mcp',
      resource_metadata: 'https://a.test/.well-known/oauth-protected-resource/mcp',
      error: 'invalid_token',
    });
  });

  it('maps findings to exit codes', () => {
    const r = emptyReport('http://x');
    expect(exitCode(r)).toBe(2);
    r.connected = true;
    expect(exitCode(r)).toBe(0);
    r.findings.push({ id: 'tools.param_description', severity: 'warn', message: 'm', hint: 'h' });
    expect(exitCode(r, 'error')).toBe(0);
    expect(exitCode(r, 'warn')).toBe(1);
    expect(exitCode(r, 'never')).toBe(0);
  });

  it('escapes pipes in Markdown tables', () => {
    const r = emptyReport('http://x');
    r.connected = true;
    r.findings.push({ id: 'tools.name_invalid', severity: 'error', message: 'a|b', hint: 'h', subject: 'x|y' });
    expect(formatMarkdown(r)).toContain('| error | `tools.name_invalid` | x\\|y | a\\|b |');
  });
});

describe('project metadata', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

  it('keeps VERSION in step with package.json and the changelog', () => {
    expect(VERSION).toBe(pkg.version);
    expect(changelog).toContain(`## ${pkg.version}`);
  });

  it('documents every check id in the README', () => {
    const missing = Object.keys(CHECKS).filter((id) => !readme.includes('`' + id + '`'));
    expect(missing).toEqual([]);
  });
});
