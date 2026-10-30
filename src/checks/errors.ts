import { randomBytes } from 'node:crypto';
import { TransportError, type RpcResult } from '../client.js';
import type { McpTool } from '../types.js';
import { call, describe, isObject, type ProbeContext } from './context.js';
import { finding } from './registry.js';

export type Outcome =
  | { kind: 'transport'; detail: string }
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'rpc-error'; code: number; detail: string }
  | { kind: 'is-error' }
  | { kind: 'success' }
  | { kind: 'malformed'; detail: string };

/** What a tools/call answer amounts to, from the client's point of view. */
export function classify(r: RpcResult | TransportError): Outcome {
  if (r instanceof TransportError) return { kind: 'transport', detail: r.message };
  if (r.response?.error) {
    if (r.status >= 500) return { kind: 'http', status: r.status, detail: describe(r) };
    return { kind: 'rpc-error', code: r.response.error.code, detail: describe(r) };
  }
  if (r.status < 200 || r.status >= 300) return { kind: 'http', status: r.status, detail: describe(r) };
  if (!r.response) return { kind: 'malformed', detail: describe(r) };
  const result = r.response.result;
  if (!isObject(result)) return { kind: 'malformed', detail: 'result is not an object' };
  return result.isError === true ? { kind: 'is-error' } : { kind: 'success' };
}

function said(o: Outcome): string {
  switch (o.kind) {
    case 'transport': return o.detail;
    case 'http': return o.detail;
    case 'rpc-error': return `JSON-RPC error ${o.code}`;
    case 'is-error': return 'an isError result';
    case 'success': return 'a successful result';
    case 'malformed': return o.detail;
  }
}

/**
 * The tool for the invalid-arguments probe: one with required arguments (calling it with none must be refused
 * before any work is done), preferring tools marked read-only. Tools without required arguments are never called.
 */
export function pickInvalidArgsTool(tools: McpTool[]): McpTool | undefined {
  const withRequired = tools.filter((t) => isObject(t.inputSchema) && Array.isArray(t.inputSchema.required) && t.inputSchema.required.length > 0);
  const readOnly = withRequired.find((t) => isObject(t.annotations) && t.annotations.readOnlyHint === true);
  if (readOnly) return readOnly;
  return withRequired.find((t) => !(isObject(t.annotations) && t.annotations.destructiveHint === true));
}

export async function runErrorContract(ctx: ProbeContext, tools: McpTool[]): Promise<void> {
  const summary: string[] = [];

  // an unknown tool
  const ghost = `mcp_probe_no_such_tool_${randomBytes(3).toString('hex')}`;
  const unknown = classify(await call(ctx, 'tools/call', { name: ghost, arguments: {} }));
  summary.push(`unknown tool -> ${said(unknown)}`);
  if (unknown.kind === 'transport' || unknown.kind === 'http' || unknown.kind === 'malformed') {
    ctx.add(finding('errors.unknown_tool', `tools/call "${ghost}": ${said(unknown)}`));
  } else if (unknown.kind === 'success') {
    ctx.add(finding('errors.unknown_tool', `tools/call "${ghost}" returned a successful result for a tool that does not exist`));
  } else if (unknown.kind === 'is-error') {
    ctx.add(finding('errors.unknown_tool_code', `tools/call "${ghost}" returned an isError result, not JSON-RPC error -32602`));
  } else if (unknown.code !== -32602) {
    ctx.add(finding('errors.unknown_tool_code', `tools/call "${ghost}" returned JSON-RPC error ${unknown.code}, not -32602`));
  }

  // a call without its required arguments
  const target = pickInvalidArgsTool(tools);
  if (!target) {
    ctx.add(finding('errors.invalid_arguments_skipped', 'No tool has required arguments; the invalid-arguments probe was skipped'));
    summary.push('invalid arguments -> skipped');
  } else {
    const o = classify(await call(ctx, 'tools/call', { name: target.name, arguments: {} }));
    summary.push(`${target.name} without required arguments -> ${said(o)}`);
    if (o.kind === 'transport' || o.kind === 'http' || o.kind === 'malformed') {
      ctx.add(finding('errors.invalid_arguments', `tools/call "${target.name}" with {}: ${said(o)}`, target.name));
    } else if (o.kind === 'success') {
      const req = (target.inputSchema as { required: unknown[] }).required.join(', ');
      ctx.add(finding('errors.invalid_arguments_accepted', `tools/call "${target.name}" with {} succeeded although ${req} ${(target.inputSchema as { required: unknown[] }).required.length > 1 ? 'are' : 'is'} required`, target.name));
    }
  }

  // an unknown method
  const m = classify(await call(ctx, 'mcp_probe/no_such_method', {}));
  summary.push(`unknown method -> ${said(m)}`);
  if (!(m.kind === 'rpc-error' && m.code === -32601)) {
    ctx.add(finding('errors.unknown_method', `"mcp_probe/no_such_method" answered ${said(m)}, expected JSON-RPC error -32601`));
  }

  ctx.add(finding('errors.summary', summary.join('; ')));
}
