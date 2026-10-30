import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probe } from '../src/index.js';
import { exitCode, formatConsole, formatMarkdown } from '../src/report.js';
import type { Report } from '../src/types.js';
import { createMockServer } from './fixtures/mock-server.mjs';

type Mock = ReturnType<typeof createMockServer>;
const running: Mock[] = [];

async function start(options: Parameters<typeof createMockServer>[0] = {}): Promise<{ mock: Mock; url: string }> {
  const mock = createMockServer(options);
  running.push(mock);
  return { mock, url: await mock.listen() };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.close()));
});

const ids = (r: Report): string[] => [...new Set(r.findings.map((f) => f.id))];
const scenarios = [
  { name: 'weather in Berlin', tool: 'get_weather', arguments: { city: 'Berlin' }, expect: { isError: false, contains: 'Berlin', maxMs: 5000 } },
  { name: 'unknown city', tool: 'get_weather', arguments: { city: 'Atlantis' }, expect: { isError: true } },
];

describe('probe against the mock server', () => {
  it('runs every check over plain JSON answers', async () => {
    const { url } = await start();
    const report = await probe(url, { latencyRuns: 3, scenarios });

    expect(report.connected).toBe(true);
    expect(report.server).toMatchObject({ name: 'mock-weather', version: '1.0.0', protocolVersion: '2025-06-18', sessionId: false, transport: 'json' });
    // pagination: one tool per page
    expect(report.tools).toEqual({ count: 2, names: ['get_weather', 'Search Docs!'] });

    // the lint problems of "Search Docs!", and none for get_weather
    const bad = report.findings.filter((f) => f.subject === 'Search Docs!').map((f) => f.id);
    expect(bad).toEqual(expect.arrayContaining(['tools.name_invalid', 'tools.description_short', 'tools.required_unknown', 'tools.param_description', 'tools.output_schema_missing', 'tools.annotations_missing']));
    expect(report.findings.filter((f) => f.subject === 'get_weather' && f.severity !== 'info')).toEqual([]);

    // context cost and latency
    expect(report.cost!.tokens).toBeGreaterThan(50);
    expect(report.cost!.heaviest[0]!.name).toBe('get_weather');
    const list = report.latency.find((l) => l.method === 'tools/list')!;
    expect(list.count).toBe(2 + 3); // two pages, then three repeats
    expect(ids(report)).toEqual(expect.arrayContaining(['cost.summary', 'latency.summary', 'errors.summary']));

    // the error contract holds: -32602 for an unknown tool, isError for missing arguments, -32601 for an unknown method
    expect(ids(report)).not.toContain('errors.unknown_tool');
    expect(ids(report)).not.toContain('errors.unknown_tool_code');
    expect(ids(report)).not.toContain('errors.invalid_arguments_accepted');
    expect(ids(report)).not.toContain('errors.unknown_method');

    // scenarios
    expect(report.scenarios.map((s) => [s.name, s.passed])).toEqual([
      ['weather in Berlin', true],
      ['unknown city', true],
    ]);

    // resources and prompts (advertised): one resource without description, one prompt argument without description
    expect(report.resources).toBe(1);
    expect(report.prompts).toBe(1);
    expect(ids(report)).toEqual(expect.arrayContaining(['resources.lint', 'prompts.lint']));

    expect(report.summary.error).toBeGreaterThan(0);
    expect(exitCode(report)).toBe(1);
    expect(exitCode(report, 'never')).toBe(0);
  });

  it('reads SSE answers and carries the session id', async () => {
    const { mock, url } = await start({ sse: true, session: true });
    const report = await probe(url, { latencyRuns: 2, scenarios: scenarios.slice(0, 1) });
    expect(report.server).toMatchObject({ transport: 'sse', sessionId: true });
    expect(report.findings.find((f) => f.id === 'handshake.session')!.message).toMatch(/Session id issued/);
    expect(ids(report)).not.toContain('tools.list_failed');
    expect(report.scenarios[0]!.passed).toBe(true);
    // every request after initialize carried the session id and the negotiated protocol version
    const later = mock.requests.slice(1);
    expect(later.length).toBeGreaterThan(5);
    expect(later.every((r) => typeof r.headers['mcp-session-id'] === 'string' && r.headers['mcp-protocol-version'] === '2025-06-18')).toBe(true);
    expect(mock.requests[0]!.headers['mcp-protocol-version']).toBeUndefined();
  });

  it('reports a 401 with the OAuth discovery it found', async () => {
    const { url } = await start({ auth: 'secret' });
    const report = await probe(url);
    expect(report.connected).toBe(true);
    expect(ids(report)).toEqual(['http.unauthorized', 'auth.metadata']);
    expect(report.findings[0]!.message).toContain('Authentication required');
    expect(report.findings[1]!.message).toContain('via resource_metadata');
    expect(exitCode(report)).toBe(1);

    const authed = await probe(url, { headers: { Authorization: 'Bearer secret' }, latencyRuns: 0 });
    expect(ids(authed)).not.toContain('http.unauthorized');
    expect(authed.tools.count).toBe(2);
  });

  it('flags an HTTP 500 for an unknown tool', async () => {
    const { url } = await start({ crashOnUnknownTool: true });
    const report = await probe(url, { latencyRuns: 0 });
    const f = report.findings.find((x) => x.id === 'errors.unknown_tool');
    expect(f?.severity).toBe('error');
    expect(f?.message).toMatch(/HTTP 500/);
  });

  it('validates structuredContent against outputSchema in scenarios', async () => {
    const { url } = await start({ badWeatherShape: true });
    const report = await probe(url, { latencyRuns: 0, skip: ['errors', 'resources'], scenarios: scenarios.slice(0, 1) });
    const f = report.findings.find((x) => x.id === 'scenario.schema');
    expect(f?.message).toBe('$.temperature: expected number, got string');
    expect(report.scenarios[0]!.passed).toBe(false);
  });

  it('reads a YAML scenario file and reports a broken one', async () => {
    const { url } = await start();
    const dir = mkdtempSync(join(tmpdir(), 'mcp-probe-'));
    const good = join(dir, 'ok.yaml');
    writeFileSync(good, 'scenarios:\n  - tool: get_weather\n    arguments: { city: Oslo }\n    expect: { contains: "Oslo" }\n  - tool: nope\n');
    const report = await probe(url, { latencyRuns: 0, skip: ['errors', 'resources'], scenarioFile: good });
    expect(report.scenarios.map((s) => s.passed)).toEqual([true, false]);
    expect(ids(report)).toContain('scenario.unknown_tool');

    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, '- arguments: {}\n');
    const r2 = await probe(url, { latencyRuns: 0, skip: ['errors', 'resources'], scenarioFile: bad });
    expect(r2.findings.find((f) => f.id === 'scenario.file')?.message).toMatch(/scenario 1: "tool" must be a non-empty string/);
  });

  it('times out instead of hanging', async () => {
    const { url } = await start({ sse: true });
    // a fetch that never answers tools/list
    const slow: typeof fetch = async (input, init) => {
      if (typeof init?.body === 'string' && init.body.includes('"tools/list"')) {
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return fetch(input, init);
    };
    const report = await probe(url, { fetch: slow, timeoutMs: 200, latencyRuns: 0, skip: ['errors', 'resources'] });
    expect(report.findings.find((f) => f.id === 'tools.list_failed')?.message).toBe('tools/list: no answer within 200 ms');
  });

  it('exits 2 when nothing listens', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const report = await probe(`http://127.0.0.1:${port}/mcp`, { timeoutMs: 2000 });
    expect(report.connected).toBe(false);
    expect(ids(report)).toEqual(['connection.failed']);
    expect(exitCode(report)).toBe(2);
    expect(formatConsole(report)).toContain('not reached');
  });

  it('renders console and Markdown reports', async () => {
    const { url } = await start();
    const report = await probe(url, { latencyRuns: 1, scenarios });
    const text = formatConsole(report, { color: false });
    expect(text).toContain('mock-weather 1.0.0 (protocol 2025-06-18, JSON answers, stateless)');
    expect(text).toContain('ERRORS');
    expect(text).toContain('fix: ');
    expect(text).not.toContain('\x1b[');
    expect(formatConsole(report, { color: true })).toContain('\x1b[31m');
    const md = formatMarkdown(report);
    expect(md).toContain('## Findings');
    expect(md).toContain('## Scenarios');
    expect(md).toContain('| weather in Berlin | get_weather | pass |');
  });
});
