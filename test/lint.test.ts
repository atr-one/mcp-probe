import { describe, expect, it } from 'vitest';
import { catalogCost, costFindings, toolCost } from '../src/checks/cost.js';
import { lintPrompts, lintResources } from '../src/checks/extras.js';
import { lintTools, similarity } from '../src/checks/tools.js';
import { estimateTokens } from '../src/tokens.js';
import type { McpTool } from '../src/types.js';

const good: McpTool = {
  name: 'get_weather',
  description: 'Current weather for a city: temperature and a short condition text.',
  inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
  outputSchema: { type: 'object', properties: { temperature: { type: 'number' } } },
  annotations: { readOnlyHint: true },
};

const ids = (tools: McpTool[]): string[] => lintTools(tools).map((f) => f.id).sort();

describe('lintTools', () => {
  it('has nothing to say about a clean tool', () => {
    expect(lintTools([good])).toEqual([]);
  });

  it('checks the name pattern and uniqueness', () => {
    expect(ids([{ ...good, name: 'has space' }])).toEqual(['tools.name_invalid']);
    expect(ids([{ ...good, name: 'x'.repeat(65) }])).toEqual(['tools.name_invalid']);
    expect(ids([{ ...good, name: 'a.b' }])).toEqual(['tools.name_invalid']);
    const dup = lintTools([good, { ...good, description: 'Something else entirely that is long enough to pass.' }]);
    expect(dup.map((f) => f.id)).toEqual(['tools.name_duplicate']);
  });

  it('checks the description band', () => {
    expect(ids([{ ...good, description: undefined }])).toEqual(['tools.description_missing']);
    expect(ids([{ ...good, description: '   ' }])).toEqual(['tools.description_missing']);
    expect(ids([{ ...good, description: 'Gets weather.' }])).toEqual(['tools.description_short']);
    expect(ids([{ ...good, description: 'word '.repeat(300) }])).toEqual(['tools.description_long']);
  });

  it('checks the input schema', () => {
    expect(ids([{ ...good, inputSchema: undefined }])).toEqual(['tools.input_schema_missing']);
    expect(ids([{ ...good, inputSchema: { type: 'string' } }])).toEqual(['tools.input_schema_type']);
    expect(ids([{ ...good, inputSchema: { type: 'object', properties: [] } }])).toEqual(['tools.input_schema_invalid']);
    expect(ids([{ ...good, inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'A' } }, required: ['a', 'b'] } }])).toEqual(['tools.required_unknown']);
  });

  it('lists parameters without description', () => {
    const f = lintTools([{ ...good, inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string', description: 'B' }, c: {} } } }]);
    expect(f).toHaveLength(1);
    expect(f[0]!.id).toBe('tools.param_description');
    expect(f[0]!.message).toBe('2 of 3 parameters without description: a, c');
  });

  it('reports outputSchema and annotations at info level', () => {
    const f = lintTools([{ ...good, outputSchema: undefined, annotations: { title: 'Weather' } }]);
    expect(f.map((x) => [x.id, x.severity])).toEqual([
      ['tools.output_schema_missing', 'info'],
      ['tools.annotations_missing', 'info'],
    ]);
    expect(ids([{ ...good, outputSchema: { type: 'array' } }])).toEqual(['tools.output_schema_invalid']);
  });

  it('finds duplicate and near-duplicate descriptions', () => {
    const a = { ...good, name: 'a' };
    const b = { ...good, name: 'b' };
    expect(ids([a, b])).toEqual(['tools.description_duplicate']);
    const c = { ...good, name: 'c', description: 'Current weather for a city: the temperature and a short condition text.' };
    const near = lintTools([a, c]);
    expect(near.map((f) => f.id)).toEqual(['tools.description_similar']);
    expect(near[0]!.subject).toBe('a, c');
  });

  it('measures similarity as word-set overlap', () => {
    expect(similarity('a b c d', 'a b c d')).toBe(1);
    expect(similarity('a b c d', 'a b e f')).toBeCloseTo(2 / 6);
  });

  it('attaches a hint to every finding', () => {
    for (const f of lintTools([{ name: 'bad name', inputSchema: { type: 'object', properties: { x: {} }, required: ['y'] } }])) {
      expect(f.hint.length).toBeGreaterThan(10);
      expect(f.subject).toBe('bad name');
    }
  });
});

describe('estimateTokens', () => {
  it('counts ASCII at 4 characters per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });

  it('counts other characters at 2 per token', () => {
    expect(estimateTokens('привет')).toBe(3);
    expect(estimateTokens('日本語の')).toBe(2);
    expect(estimateTokens('ab日本')).toBe(2); // 2/4 + 2/2 = 1.5
  });
});

describe('context cost', () => {
  it('measures name, description and inputSchema only', () => {
    const expected = JSON.stringify({ name: good.name, description: good.description, inputSchema: good.inputSchema });
    expect(toolCost(good)).toEqual({ name: 'get_weather', chars: expected.length, tokens: Math.ceil(expected.length / 4) });
  });

  it('sums the catalog, ranks the heaviest and warns over budget', () => {
    const big = { ...good, name: 'big', description: 'd'.repeat(4000) };
    const cost = catalogCost([good, big], 500, 'Use the tools.');
    expect(cost.heaviest[0]!.name).toBe('big');
    expect(cost.tokens).toBe(cost.perTool[0]!.tokens + cost.perTool[1]!.tokens);
    expect(cost.instructionsTokens).toBe(4);
    expect(cost.wireChars).toBeGreaterThan(cost.chars);
    const ids = costFindings(cost, 2).map((f) => f.id);
    expect(ids).toEqual(['cost.summary', 'cost.over_budget', 'cost.heaviest']);
    expect(costFindings(catalogCost([good], 8000), 1).map((f) => f.id)).toEqual(['cost.summary']);
  });
});

describe('resources and prompts lint', () => {
  it('reports missing names, descriptions and duplicates', () => {
    const r = lintResources([{ uri: 'a://1', name: 'one', description: 'One' }, { uri: 'a://1' }, { name: 'nouri' }]);
    expect(r.map((f) => f.message)).toEqual([
      'resource #3 has no uri',
      '1 of 3 resources have no name: a://1',
      '2 of 3 resources have no description: a://1, nouri',
      'uri a://1 is listed 2 times',
    ]);
    const p = lintPrompts([{ name: 'p', arguments: [{ name: 'x' }] }, { name: 'p', description: 'P' }]);
    expect(p.map((f) => f.message)).toEqual([
      '1 of 2 prompts have no description: p',
      '1 prompt argument without description: p.x',
      'prompt "p" is listed 2 times',
    ]);
    expect(p.every((f) => f.severity === 'info')).toBe(true);
  });
});
