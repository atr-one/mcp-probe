import type { Finding } from '../types.js';
import { isObject, listAll, type ProbeContext } from './context.js';
import { finding } from './registry.js';

const list = (names: string[], max = 8): string => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));

export function lintResources(items: unknown[]): Finding[] {
  const out: Finding[] = [];
  const uris = new Map<string, number>();
  const noName: string[] = [];
  const noDesc: string[] = [];
  items.forEach((r, i) => {
    const o = isObject(r) ? r : {};
    const uri = typeof o.uri === 'string' && o.uri !== '' ? o.uri : `#${i + 1}`;
    if (uri.startsWith('#')) out.push(finding('resources.lint', `resource ${uri} has no uri`));
    else uris.set(uri, (uris.get(uri) ?? 0) + 1);
    if (typeof o.name !== 'string' || o.name === '') noName.push(uri);
    if (typeof o.description !== 'string' || o.description.trim() === '') noDesc.push(typeof o.name === 'string' && o.name ? o.name : uri);
  });
  if (noName.length) out.push(finding('resources.lint', `${noName.length} of ${items.length} resources have no name: ${list(noName)}`));
  if (noDesc.length) out.push(finding('resources.lint', `${noDesc.length} of ${items.length} resources have no description: ${list(noDesc)}`));
  for (const [uri, n] of uris) if (n > 1) out.push(finding('resources.lint', `uri ${uri} is listed ${n} times`, uri));
  return out;
}

export function lintPrompts(items: unknown[]): Finding[] {
  const out: Finding[] = [];
  const names = new Map<string, number>();
  const noDesc: string[] = [];
  const argsNoDesc: string[] = [];
  items.forEach((p, i) => {
    const o = isObject(p) ? p : {};
    const name = typeof o.name === 'string' && o.name !== '' ? o.name : '';
    if (!name) {
      out.push(finding('prompts.lint', `prompt #${i + 1} has no name`));
      return;
    }
    names.set(name, (names.get(name) ?? 0) + 1);
    if (typeof o.description !== 'string' || o.description.trim() === '') noDesc.push(name);
    if (Array.isArray(o.arguments)) {
      for (const a of o.arguments) {
        if (isObject(a) && (typeof a.description !== 'string' || a.description.trim() === '')) argsNoDesc.push(`${name}.${typeof a.name === 'string' ? a.name : '?'}`);
      }
    }
  });
  if (noDesc.length) out.push(finding('prompts.lint', `${noDesc.length} of ${items.length} prompts have no description: ${list(noDesc)}`));
  if (argsNoDesc.length) out.push(finding('prompts.lint', `${argsNoDesc.length} prompt argument${argsNoDesc.length === 1 ? '' : 's'} without description: ${list(argsNoDesc)}`));
  for (const [name, n] of names) if (n > 1) out.push(finding('prompts.lint', `prompt "${name}" is listed ${n} times`, name));
  return out;
}

/** resources/list and prompts/list, when the server advertises them. */
export async function runExtras(ctx: ProbeContext, capabilities: Record<string, unknown>): Promise<void> {
  if ('resources' in capabilities) {
    const items = await listAll(ctx, 'resources/list', 'resources', { failed: 'resources.list_failed', pagination: 'resources.list_failed' });
    if (items) {
      ctx.report.resources = items.length;
      ctx.add(finding('resources.summary', `${items.length} resource${items.length === 1 ? '' : 's'}`));
      lintResources(items).forEach((f) => ctx.add(f));
    }
  }
  if ('prompts' in capabilities) {
    const items = await listAll(ctx, 'prompts/list', 'prompts', { failed: 'prompts.list_failed', pagination: 'prompts.list_failed' });
    if (items) {
      ctx.report.prompts = items.length;
      ctx.add(finding('prompts.summary', `${items.length} prompt${items.length === 1 ? '' : 's'}`));
      lintPrompts(items).forEach((f) => ctx.add(f));
    }
  }
}
