import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { TransportError } from '../client.js';
import { validate } from '../schema.js';
import type { McpTool, Scenario, ScenarioExpect, ScenarioResult } from '../types.js';
import { call, describe, isObject, snippet, type ProbeContext } from './context.js';
import { finding } from './registry.js';

const EXPECT_KEYS: Record<keyof ScenarioExpect, string> = { isError: 'boolean', contains: 'string', maxMs: 'number', schemaValid: 'boolean' };

/**
 * Check and normalize scenario data: a list of scenarios, or an object with a `scenarios` list.
 * Throws an Error that names the offending entry.
 */
export function parseScenarios(data: unknown): Scenario[] {
  const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.scenarios) ? data.scenarios : undefined;
  if (!list) throw new Error('expected a list of scenarios, or an object with a "scenarios" list');
  return list.map((raw, i) => {
    const at = `scenario ${i + 1}`;
    if (!isObject(raw)) throw new Error(`${at}: must be an object`);
    for (const k of Object.keys(raw)) {
      if (!['name', 'tool', 'arguments', 'expect'].includes(k)) throw new Error(`${at}: unknown key "${k}"`);
    }
    if (typeof raw.tool !== 'string' || raw.tool === '') throw new Error(`${at}: "tool" must be a non-empty string`);
    if (raw.name !== undefined && typeof raw.name !== 'string') throw new Error(`${at}: "name" must be a string`);
    if (raw.arguments !== undefined && raw.arguments !== null && !isObject(raw.arguments)) throw new Error(`${at}: "arguments" must be an object`);
    const s: Scenario = { tool: raw.tool };
    if (typeof raw.name === 'string') s.name = raw.name;
    if (isObject(raw.arguments)) s.arguments = raw.arguments;
    if (raw.expect !== undefined && raw.expect !== null) {
      if (!isObject(raw.expect)) throw new Error(`${at}: "expect" must be an object`);
      for (const [k, v] of Object.entries(raw.expect)) {
        const type = EXPECT_KEYS[k as keyof ScenarioExpect];
        if (!type) throw new Error(`${at}: unknown expect key "${k}" (known: ${Object.keys(EXPECT_KEYS).join(', ')})`);
        if (typeof v !== type) throw new Error(`${at}: expect.${k} must be a ${type}`);
      }
      s.expect = raw.expect as ScenarioExpect;
    }
    return s;
  });
}

/** Read a YAML or JSON scenario file (YAML is a superset of JSON, so one parser reads both). */
export async function loadScenarios(path: string): Promise<Scenario[]> {
  const text = await readFile(path, 'utf8');
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message.split('\n')[0]}`);
  }
  try {
    return parseScenarios(data);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

/** All text of a tool result: its text content items, then structuredContent as JSON. */
export function resultText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const c of result.content) {
      if (isObject(c) && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n');
}

export async function runScenarios(ctx: ProbeContext, scenarios: Scenario[], tools: McpTool[] | undefined): Promise<void> {
  for (const sc of scenarios) {
    const name = sc.name ?? sc.tool;
    const expect = sc.expect ?? {};
    const res: ScenarioResult = { name, tool: sc.tool, passed: false, failures: [] };
    ctx.report.scenarios.push(res);
    const fail = (id: Parameters<typeof finding>[0], message: string): void => {
      res.failures.push(message);
      ctx.add(finding(id, message, name));
    };

    const tool = tools?.find((t) => t.name === sc.tool);
    if (tools && !tool) {
      fail('scenario.unknown_tool', `"${sc.tool}" is not in tools/list`);
      continue;
    }

    const r = await call(ctx, 'tools/call', { name: sc.tool, arguments: sc.arguments ?? {} });
    if (!(r instanceof TransportError)) res.ms = Math.round(r.ms);
    if (r instanceof TransportError || (r.status < 200 || r.status >= 300) || !r.response) {
      fail('scenario.failed', describe(r));
      continue;
    }
    if (r.response.error) {
      // a JSON-RPC error is an error outcome too; it satisfies expect.isError: true
      res.isError = true;
      if (expect.isError !== true) fail('scenario.failed', describe(r));
    } else {
      const result = isObject(r.response.result) ? r.response.result : undefined;
      if (!result) {
        fail('scenario.failed', 'result is not an object');
        continue;
      }
      const isError = result.isError === true;
      res.isError = isError;
      if (expect.isError !== undefined && isError !== expect.isError) {
        const text = snippet(resultText(result), 160);
        fail('scenario.is_error', `isError is ${isError}, expected ${expect.isError}${text ? ': ' + text : ''}`);
      }
      if (expect.contains !== undefined && !resultText(result).includes(expect.contains)) {
        fail('scenario.contains', `result does not contain "${snippet(expect.contains, 60)}"`);
      }
      const schema = tool?.outputSchema;
      // error results are not held to the outputSchema
      const wantSchema = !isError && expect.schemaValid !== false && (expect.schemaValid === true || schema !== undefined);
      if (wantSchema) {
        if (schema === undefined) {
          fail('scenario.schema', tools ? `"${sc.tool}" declares no outputSchema to validate against` : 'tools/list failed, no outputSchema to validate against');
        } else if (result.structuredContent === undefined) {
          fail('scenario.schema', 'the tool declares an outputSchema but the result has no structuredContent');
        } else {
          const errors = validate(result.structuredContent, schema);
          if (errors.length > 0) fail('scenario.schema', errors.slice(0, 3).join('; ') + (errors.length > 3 ? `; and ${errors.length - 3} more` : ''));
        }
      }
    }
    if (expect.maxMs !== undefined && res.ms !== undefined && res.ms > expect.maxMs) {
      fail('scenario.slow', `took ${res.ms} ms, limit ${expect.maxMs} ms`);
    }
    res.passed = res.failures.length === 0;
    if (res.passed) ctx.add(finding('scenario.passed', `passed in ${res.ms} ms${res.isError ? ' (error result, as expected)' : ''}`, name));
  }
}
