import { McpClient, TransportError, type RpcResult } from '../client.js';
import type { CheckGroup, Finding, Report, Scenario } from '../types.js';
import { finding, type CheckId } from './registry.js';

export interface ResolvedOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  tokenBudget: number;
  latencyRuns: number;
  slowMs: number;
  scenarios?: Scenario[];
  scenarioFile?: string;
  skip: Set<CheckGroup>;
  fetch?: typeof fetch;
  onProgress: (step: string) => void;
}

/** What every check gets: the client, the report being built and the options. */
export interface ProbeContext {
  client: McpClient;
  report: Report;
  opts: ResolvedOptions;
  add(f: Finding): void;
}

/** A request that turns transport failures into a value instead of an exception. */
export async function call(ctx: ProbeContext, method: string, params?: unknown): Promise<RpcResult | TransportError> {
  try {
    return await ctx.client.request(method, params);
  } catch (e) {
    if (e instanceof TransportError) return e;
    throw e;
  }
}

export function snippet(text: string | undefined, max = 160): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 3) + '...' : flat;
}

/** One line on what went wrong with a request, for messages. */
export function describe(r: RpcResult | TransportError): string {
  if (r instanceof TransportError) return r.message;
  const err = r.response?.error;
  const rpc = err ? `JSON-RPC error ${err.code}: ${snippet(err.message, 200)}` : '';
  if (r.problem === 'http') return `HTTP ${r.status}${rpc ? ', ' + rpc : r.body ? ': ' + snippet(r.body) : ''}`;
  if (rpc) return rpc;
  if (r.problem === 'content-type') return `unexpected Content-Type "${r.contentType || '(none)'}"${r.body ? ': ' + snippet(r.body) : ''}`;
  if (r.problem === 'invalid-json') return `body is not JSON: ${snippet(r.body) || '(empty)'}`;
  if (r.problem === 'no-response') return `no JSON-RPC response with the request id${r.body ? ': ' + snippet(r.body) : ''}`;
  return `HTTP ${r.status}`;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The result object of a successful response, or undefined. */
export function resultOf(r: RpcResult | TransportError): Record<string, unknown> | undefined {
  if (r instanceof TransportError || !r.response || r.response.error) return undefined;
  return isObject(r.response.result) ? r.response.result : undefined;
}

const MAX_PAGES = 100;

/**
 * Follow nextCursor through a list method (tools/list, resources/list, prompts/list). Returns the items (possibly partial) or undefined when the first
 * page failed; problems are reported with the given ids.
 */
export async function listAll(
  ctx: ProbeContext,
  method: string,
  key: string,
  ids: { failed: CheckId; pagination: CheckId },
): Promise<unknown[] | undefined> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await call(ctx, method, cursor === undefined ? undefined : { cursor });
    const label = cursor === undefined ? method : `${method} (page ${page + 1})`;
    const result = resultOf(r);
    if (!result) {
      ctx.add(finding(ids.failed, `${label}: ${describe(r)}`));
      return page === 0 ? undefined : items;
    }
    const list = result[key];
    if (!Array.isArray(list)) {
      ctx.add(finding(ids.failed, `${label}: result.${key} is not an array`));
      return page === 0 ? undefined : items;
    }
    items.push(...list);
    const next = result.nextCursor;
    if (next === undefined || next === null || next === '') return items;
    if (typeof next !== 'string') {
      ctx.add(finding(ids.pagination, `${label}: nextCursor is ${typeof next}, must be a string`));
      return items;
    }
    if (seen.has(next)) {
      ctx.add(finding(ids.pagination, `${label}: nextCursor "${snippet(next, 40)}" was returned before; stopped after ${page + 1} pages`));
      return items;
    }
    seen.add(next);
    cursor = next;
  }
  ctx.add(finding(ids.pagination, `${method}: still returning nextCursor after ${MAX_PAGES} pages; stopped`));
  return items;
}
