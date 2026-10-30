import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { probe } from '../src/index.js';
import { formatJson } from '../src/report.js';
import { lintSchema, validate } from '../src/schema.js';
import type { Report } from '../src/types.js';
import { createMockServer } from './fixtures/mock-server.mjs';

const schema = JSON.parse(readFileSync(new URL('../schema/report.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;

/**
 * The published schema allows properties it does not declare, so that consumers keep working when optional
 * fields are added. For the tests every object with declared properties is closed, so a field added to the
 * report without a line in the schema fails here.
 */
function closed(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(closed);
  if (typeof s !== 'object' || s === null) return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) out[k] = k === 'const' || k === 'enum' ? v : closed(v);
  if ('properties' in out && !('additionalProperties' in out)) out.additionalProperties = false;
  return out;
}
const strict = closed(schema);

/** The report as --json writes it: undefined fields are dropped. */
const asJson = (r: Report): unknown => JSON.parse(formatJson(r));
const problems = (r: unknown): string[] => [...validate(r, schema), ...validate(r, strict)];

const running: ReturnType<typeof createMockServer>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.close()));
});
async function mockUrl(options: Parameters<typeof createMockServer>[0] = {}): Promise<string> {
  const mock = createMockServer(options);
  running.push(mock);
  return mock.listen();
}

describe('schema/report.schema.json', () => {
  it('is a sound schema document', () => {
    expect(lintSchema(schema)).toEqual([]);
    expect((schema.properties as Record<string, { const?: unknown }>).schemaVersion!.const).toBe(1);
  });

  it('describes a real report against the mock server', async () => {
    const url = await mockUrl({ sse: true, session: true });
    const report = await probe(url, {
      latencyRuns: 2,
      scenarios: [
        { name: 'weather in Berlin', tool: 'get_weather', arguments: { city: 'Berlin' }, expect: { isError: false } },
        { name: 'deliberately failing', tool: 'get_weather', arguments: { city: 'Oslo' }, expect: { contains: 'Lisbon' } },
      ],
    });
    const json = asJson(report) as Report;
    // every optional part is present, so the whole schema is exercised
    expect(json.schemaVersion).toBe(1);
    expect(Object.keys(json)).toEqual(expect.arrayContaining(['server', 'cost', 'resources', 'prompts']));
    expect(json.scenarios.map((s) => s.passed)).toEqual([true, false]);
    expect(problems(json)).toEqual([]);
  });

  it('describes a report without a connection and the fixture reports', async () => {
    const down = await probe('http://127.0.0.1:9/mcp', { fetch: () => Promise.reject(new TypeError('fetch failed')) });
    expect(down.connected).toBe(false);
    expect(problems(asJson(down))).toEqual([]);
    for (const name of ['report-before.json', 'report-after.json']) {
      expect(problems(JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')))).toEqual([]);
    }
  });

  it('rejects what is not a version 1 report', async () => {
    const url = await mockUrl();
    const json = asJson(await probe(url, { latencyRuns: 0, skip: ['errors', 'resources'] })) as Record<string, unknown>;
    expect(validate({ ...json, schemaVersion: 2 }, schema)).toEqual(['$.schemaVersion: expected 1']);
    expect(validate({ ...json, findings: [{ id: 'x', severity: 'fatal', message: 'm', hint: 'h' }] }, schema)).toEqual(['$.findings[0].severity: "fatal" is not one of ["error","warn","info"]']);
    const noSummary = { ...json };
    delete noSummary.summary;
    expect(validate(noSummary, schema)).toEqual(['$.summary: required']);
    expect(validate({ ...json, extra: true }, strict)).toEqual(['$.extra: not allowed (additionalProperties is false)']);
  });
});
