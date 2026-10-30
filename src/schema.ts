/**
 * A small JSON Schema subset: enough to check tool results against an outputSchema and to lint the shape of
 * inputSchema/outputSchema documents. Supported keywords: type, properties, required, items,
 * additionalProperties, enum, const, anyOf, oneOf, allOf. Other keywords ($ref, format, minimum, pattern, ...)
 * are ignored, so the validator errs on the side of accepting.
 */

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

type Json = unknown;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: Json, type: string): boolean {
  const t = typeOf(v);
  if (type === 'number') return t === 'number' || t === 'integer';
  return t === type;
}

export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

function show(v: Json): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 40 ? s.slice(0, 37) + '...' : s;
}

/** Validate a value against a schema; returns readable errors ("$.city: required"), empty when valid. */
export function validate(value: Json, schema: Json, path = '$'): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path}: no value is allowed here`];
  if (!isPlainObject(schema)) return [];
  const errors: string[] = [];

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) errors.push(...validate(value, sub, path));
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    if (!schema.anyOf.some((sub) => validate(value, sub, path).length === 0)) errors.push(`${path}: matches none of anyOf`);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const n = schema.oneOf.filter((sub) => validate(value, sub, path).length === 0).length;
    if (n !== 1) errors.push(`${path}: matches ${n} of oneOf, expected exactly 1`);
  }
  if ('const' in schema && !deepEqual(value, schema.const)) errors.push(`${path}: expected ${show(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(value, e))) {
    errors.push(`${path}: ${show(value)} is not one of ${show(schema.enum)}`);
  }
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((t): t is string => typeof t === 'string');
    if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
      // a wrong type makes the nested checks noise
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }

  if (isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) errors.push(`${path}.${key}: required`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) errors.push(...validate(value[key], sub, `${path}.${key}`));
    }
    const extra = Object.keys(value).filter((k) => !(k in props));
    if (schema.additionalProperties === false) {
      for (const k of extra) errors.push(`${path}.${k}: not allowed (additionalProperties is false)`);
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const k of extra) errors.push(...validate(value[k], schema.additionalProperties, `${path}.${k}`));
    }
  }

  if (Array.isArray(value)) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((sub, i) => {
        if (i < value.length) errors.push(...validate(value[i], sub, `${path}[${i}]`));
      });
    } else if (schema.items !== undefined) {
      value.forEach((v, i) => errors.push(...validate(v, schema.items, `${path}[${i}]`)));
    }
  }
  return errors;
}

/**
 * Structural problems of a schema document: unknown type names, properties that is not an object, required
 * that is not a list of strings, and so on. Recurses into properties, items, additionalProperties and the
 * combinators. Returns readable problems, empty when the schema looks sound.
 */
export function lintSchema(schema: Json, path = '$', depth = 0): string[] {
  if (typeof schema === 'boolean') return [];
  if (!isPlainObject(schema)) return [`${path}: a schema must be an object, got ${typeOf(schema)}`];
  if (depth > 32) return [];
  const problems: string[] = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) {
      if (typeof t !== 'string' || !TYPES.has(t)) problems.push(`${path}.type: ${show(t)} is not a JSON Schema type`);
    }
  }
  if (schema.properties !== undefined) {
    if (Array.isArray(schema.properties)) {
      problems.push(`${path}.properties: is an array, must be an object (an empty PHP array encodes as [] - send {})`);
    } else if (!isPlainObject(schema.properties)) {
      problems.push(`${path}.properties: must be an object`);
    } else {
      for (const [k, sub] of Object.entries(schema.properties)) problems.push(...lintSchema(sub, `${path}.properties.${k}`, depth + 1));
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === 'string')) {
      problems.push(`${path}.required: must be an array of strings`);
    } else if (new Set(schema.required).size !== schema.required.length) {
      problems.push(`${path}.required: has duplicates`);
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) schema.items.forEach((sub, i) => problems.push(...lintSchema(sub, `${path}.items[${i}]`, depth + 1)));
    else problems.push(...lintSchema(schema.items, `${path}.items`, depth + 1));
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    problems.push(...lintSchema(schema.additionalProperties, `${path}.additionalProperties`, depth + 1));
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    problems.push(`${path}.enum: must be a non-empty array`);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = schema[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0) problems.push(`${path}.${key}: must be a non-empty array`);
    else list.forEach((sub, i) => problems.push(...lintSchema(sub, `${path}.${key}[${i}]`, depth + 1)));
  }
  return problems;
}
