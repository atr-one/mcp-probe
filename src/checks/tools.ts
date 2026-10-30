import { lintSchema } from '../schema.js';
import type { Finding, McpTool } from '../types.js';
import { isObject, listAll, type ProbeContext } from './context.js';
import { finding } from './registry.js';

export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
export const DESCRIPTION_MIN = 20;
export const DESCRIPTION_MAX = 1024;
export const SIMILARITY = 0.85;
const SIMILAR_MIN_WORDS = 6;

/** tools/list with pagination. Undefined when it failed outright. */
export async function listTools(ctx: ProbeContext): Promise<McpTool[] | undefined> {
  const items = await listAll(ctx, 'tools/list', 'tools', { failed: 'tools.list_failed', pagination: 'tools.pagination' });
  if (!items) return undefined;
  const tools: McpTool[] = [];
  items.forEach((t, i) => {
    if (isObject(t) && typeof t.name === 'string') tools.push(t as McpTool);
    else ctx.add(finding('tools.name_invalid', `tools[${i}] is not an object with a string name`));
  });
  if (tools.length === 0) ctx.add(finding('tools.empty', 'tools/list returned an empty list'));
  return tools;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Jaccard similarity of the word sets of two texts (0..1). */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common);
}

/** Lint a tool catalog. Pure: no I/O, so it is easy to test and to use on a catalog you already have. */
export function lintTools(tools: McpTool[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<string, number>();

  for (const tool of tools) {
    const name = tool.name;
    if (!TOOL_NAME.test(name)) {
      out.push(finding('tools.name_invalid', `"${name}" does not match ${TOOL_NAME.source}${name.length > 64 ? ` (${name.length} chars)` : ''}`, name));
    }
    seen.set(name, (seen.get(name) ?? 0) + 1);

    // description
    const desc = typeof tool.description === 'string' ? tool.description.trim() : '';
    if (desc === '') out.push(finding('tools.description_missing', 'No description', name));
    else if (desc.length < DESCRIPTION_MIN) out.push(finding('tools.description_short', `Description is ${desc.length} chars: "${desc}"`, name));
    else if (desc.length > DESCRIPTION_MAX) out.push(finding('tools.description_long', `Description is ${desc.length} chars`, name));

    // inputSchema
    const input = tool.inputSchema;
    if (input === undefined || input === null) {
      out.push(finding('tools.input_schema_missing', 'No inputSchema', name));
    } else if (!isObject(input)) {
      out.push(finding('tools.input_schema_invalid', `inputSchema is ${Array.isArray(input) ? 'an array' : typeof input}, must be an object`, name));
    } else {
      if (input.type !== 'object') out.push(finding('tools.input_schema_type', `inputSchema.type is ${JSON.stringify(input.type) ?? 'missing'}`, name));
      const problems = lintSchema(input);
      if (problems.length > 0) out.push(finding('tools.input_schema_invalid', problems.slice(0, 3).join('; ') + (problems.length > 3 ? `; and ${problems.length - 3} more` : ''), name));
      const props = isObject(input.properties) ? input.properties : {};
      if (Array.isArray(input.required)) {
        const unknown = input.required.filter((r): r is string => typeof r === 'string' && !(r in props));
        if (unknown.length > 0) out.push(finding('tools.required_unknown', `required lists ${unknown.map((u) => `"${u}"`).join(', ')}, not in properties`, name));
      }
      const undescribed = Object.entries(props)
        .filter(([, p]) => isObject(p) && (typeof p.description !== 'string' || p.description.trim() === ''))
        .map(([k]) => k);
      if (undescribed.length > 0) out.push(finding('tools.param_description', `${undescribed.length} of ${Object.keys(props).length} parameters without description: ${undescribed.join(', ')}`, name));
    }

    // outputSchema
    const output = tool.outputSchema;
    if (output === undefined) {
      out.push(finding('tools.output_schema_missing', 'No outputSchema', name));
    } else if (!isObject(output) || output.type !== 'object') {
      out.push(finding('tools.output_schema_invalid', isObject(output) ? `outputSchema.type is ${JSON.stringify(output.type) ?? 'missing'}, must be "object"` : 'outputSchema is not an object', name));
    } else {
      const problems = lintSchema(output);
      if (problems.length > 0) out.push(finding('tools.output_schema_invalid', problems.slice(0, 3).join('; ') + (problems.length > 3 ? `; and ${problems.length - 3} more` : ''), name));
    }

    // annotations
    if (!isObject(tool.annotations) || Object.keys(tool.annotations).filter((k) => k !== 'title').length === 0) {
      out.push(finding('tools.annotations_missing', 'No annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)', name));
    }
  }

  for (const [name, n] of seen) {
    if (n > 1) out.push(finding('tools.name_duplicate', `"${name}" appears ${n} times`, name));
  }

  // duplicate and near-duplicate descriptions
  const described = tools.filter((t) => typeof t.description === 'string' && t.description.trim() !== '');
  for (let i = 0; i < described.length; i++) {
    for (let j = i + 1; j < described.length; j++) {
      const a = described[i]!;
      const b = described[j]!;
      const da = (a.description as string).trim();
      const db = (b.description as string).trim();
      if (da.toLowerCase() === db.toLowerCase()) {
        out.push(finding('tools.description_duplicate', `"${a.name}" and "${b.name}" have the same description`, `${a.name}, ${b.name}`));
      } else if (words(da).size >= SIMILAR_MIN_WORDS && words(db).size >= SIMILAR_MIN_WORDS) {
        const s = similarity(da, db);
        if (s >= SIMILARITY) out.push(finding('tools.description_similar', `"${a.name}" and "${b.name}" descriptions overlap ${Math.round(s * 100)}%`, `${a.name}, ${b.name}`));
      }
    }
  }
  return out;
}
