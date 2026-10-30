import { describe, expect, it } from 'vitest';
import { lintSchema, validate } from '../src/schema.js';

const weather = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    temperature: { type: 'number' },
    units: { type: 'string', enum: ['c', 'f'] },
    tags: { type: 'array', items: { type: 'string' } },
    note: { type: ['string', 'null'] },
  },
  required: ['city', 'temperature'],
};

describe('validate', () => {
  it('accepts a conforming value', () => {
    expect(validate({ city: 'Oslo', temperature: 9, units: 'c', tags: ['a'], note: null }, weather)).toEqual([]);
  });

  it('reports type mismatches with a path', () => {
    expect(validate({ city: 'Oslo', temperature: '9' }, weather)).toEqual(['$.temperature: expected number, got string']);
  });

  it('reports missing required properties', () => {
    expect(validate({ city: 'Oslo' }, weather)).toEqual(['$.temperature: required']);
  });

  it('checks enum, items and union types', () => {
    const errors = validate({ city: 'Oslo', temperature: 1, units: 'k', tags: ['a', 2], note: 3 }, weather);
    expect(errors).toEqual([
      '$.units: "k" is not one of ["c","f"]',
      '$.tags[1]: expected string, got integer',
      '$.note: expected string|null, got integer',
    ]);
  });

  it('treats integers as numbers but not the other way round', () => {
    expect(validate(3, { type: 'number' })).toEqual([]);
    expect(validate(3.5, { type: 'integer' })).toEqual(['$: expected integer, got number']);
  });

  it('distinguishes arrays from objects (the PHP [] case)', () => {
    expect(validate([], { type: 'object' })).toEqual(['$: expected object, got array']);
  });

  it('applies additionalProperties false and schema', () => {
    expect(validate({ a: 1, b: 2 }, { type: 'object', properties: { a: {} }, additionalProperties: false })).toEqual([
      '$.b: not allowed (additionalProperties is false)',
    ]);
    expect(validate({ a: 1, b: 'x' }, { type: 'object', additionalProperties: { type: 'integer' } })).toEqual(['$.b: expected integer, got string']);
  });

  it('supports anyOf, oneOf, allOf and const', () => {
    expect(validate('x', { anyOf: [{ type: 'integer' }, { type: 'string' }] })).toEqual([]);
    expect(validate(true, { anyOf: [{ type: 'integer' }, { type: 'string' }] })).toEqual(['$: matches none of anyOf']);
    expect(validate(1, { oneOf: [{ type: 'integer' }, { type: 'number' }] })).toEqual(['$: matches 2 of oneOf, expected exactly 1']);
    expect(validate(1, { allOf: [{ type: 'integer' }, { const: 2 }] })).toEqual(['$: expected 2']);
  });

  it('validates tuple items positionally', () => {
    expect(validate(['a', 1], { type: 'array', items: [{ type: 'string' }, { type: 'string' }] })).toEqual(['$[1]: expected string, got integer']);
  });

  it('ignores keywords outside the subset and boolean schemas', () => {
    expect(validate('abc', { type: 'string', pattern: '^z', minLength: 10 })).toEqual([]);
    expect(validate(1, true)).toEqual([]);
    expect(validate(1, false)).toEqual(['$: no value is allowed here']);
  });
});

describe('lintSchema', () => {
  it('passes a sound schema', () => {
    expect(lintSchema(weather)).toEqual([]);
  });

  it('flags unknown types, array properties, bad required and empty enums', () => {
    expect(lintSchema({ type: 'obj', properties: [], required: 'a', enum: [] })).toEqual([
      '$.type: "obj" is not a JSON Schema type',
      '$.properties: is an array, must be an object (an empty PHP array encodes as [] - send {})',
      '$.required: must be an array of strings',
      '$.enum: must be a non-empty array',
    ]);
  });

  it('recurses into properties and items', () => {
    expect(lintSchema({ type: 'object', properties: { a: { type: 'array', items: { type: 'str' } }, b: 5 } })).toEqual([
      '$.properties.a.items.type: "str" is not a JSON Schema type',
      '$.properties.b: a schema must be an object, got integer',
    ]);
  });

  it('flags duplicate required names', () => {
    expect(lintSchema({ type: 'object', required: ['a', 'a'] })).toEqual(['$.required: has duplicates']);
  });
});
