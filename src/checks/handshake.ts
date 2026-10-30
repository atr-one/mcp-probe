import { PROTOCOL_VERSION, TransportError, type RpcResult } from '../client.js';
import { estimateTokens } from '../tokens.js';
import { VERSION } from '../version.js';
import { call, describe, isObject, snippet, type ProbeContext } from './context.js';
import { finding } from './registry.js';

export const KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

export interface InitResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  instructions?: string;
}

/**
 * initialize, notifications/initialized and ping. Returns the initialize result when the session is usable,
 * undefined when the probe cannot go on (no connection, auth, HTTP or protocol failure).
 */
export async function runHandshake(ctx: ProbeContext): Promise<InitResult | undefined> {
  const { client, report } = ctx;
  let r: RpcResult;
  try {
    r = await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-probe', version: VERSION },
    });
  } catch (e) {
    if (!(e instanceof TransportError)) throw e;
    report.connected = false;
    ctx.add(finding('connection.failed', `initialize: ${e.message}`));
    return undefined;
  }
  report.connected = true;

  if (r.status === 401) {
    await authDiscovery(ctx, r);
    return undefined;
  }
  if (r.status === 403) {
    const server = r.headers.get('server');
    const ray = r.headers.get('cf-ray');
    const via = server ? ` (server: ${server}${ray ? ', cf-ray ' + ray : ''})` : '';
    ctx.add(finding('http.forbidden', `initialize answered HTTP 403${via}: ${snippet(r.response?.error?.message ?? r.body) || '(empty body)'}`));
    return undefined;
  }
  if (r.status === 405) {
    const allow = r.headers.get('allow');
    ctx.add(finding('http.method_not_allowed', `POST answered HTTP 405${allow ? ' (Allow: ' + allow + ')' : ''}`));
    return undefined;
  }
  if (r.status < 200 || r.status >= 300) {
    ctx.add(finding('http.status', `initialize: ${describe(r)}`));
    return undefined;
  }
  if (r.problem === 'content-type') {
    ctx.add(finding('http.content_type', `initialize answered Content-Type "${r.contentType || '(none)'}"`));
  }
  if (!r.response) {
    ctx.add(finding('handshake.invalid_response', `initialize: ${describe(r)}`));
    return undefined;
  }
  if (r.response.error) {
    ctx.add(finding('handshake.rpc_error', `initialize: ${describe(r)}`));
    return undefined;
  }
  const result = r.response.result;
  if (!isObject(result)) {
    ctx.add(finding('handshake.invalid_response', 'initialize result is not an object'));
    return undefined;
  }

  // protocol version
  const version = result.protocolVersion;
  if (typeof version !== 'string' || !KNOWN_PROTOCOL_VERSIONS.includes(version)) {
    ctx.add(finding('handshake.protocol_unknown', typeof version === 'string' ? `protocolVersion "${snippet(version, 40)}" is not a published revision` : 'initialize result has no protocolVersion'));
  } else if (version !== PROTOCOL_VERSION) {
    ctx.add(finding('handshake.protocol_version', `Negotiated ${version} (requested ${PROTOCOL_VERSION})`));
  }
  if (typeof version === 'string') client.protocolVersion = version;

  // server info
  const info = isObject(result.serverInfo) ? result.serverInfo : undefined;
  const missing = ['name', 'version'].filter((k) => typeof info?.[k] !== 'string' || info[k] === '');
  if (missing.length > 0) ctx.add(finding('handshake.server_info', info ? `serverInfo has no ${missing.join(' or ')}` : 'initialize result has no serverInfo'));

  // capabilities
  let capabilities: Record<string, unknown> = {};
  if (!isObject(result.capabilities)) {
    ctx.add(finding('handshake.capabilities', 'initialize result has no capabilities object'));
  } else {
    capabilities = result.capabilities;
    if (!('tools' in capabilities)) ctx.add(finding('handshake.no_tools', `capabilities: ${Object.keys(capabilities).join(', ') || '(empty)'}`));
  }

  // instructions
  const instructions = typeof result.instructions === 'string' && result.instructions !== '' ? result.instructions : undefined;
  ctx.add(finding('handshake.instructions', instructions
    ? `Instructions: ${instructions.length} chars, ~${estimateTokens(instructions)} tokens`
    : 'No instructions in the initialize result'));

  // session
  const sid = client.sessionId;
  if (sid) {
    ctx.add(finding('handshake.session', `Session id issued (${sid.length} chars); sent back on every request`));
    if (!/^[\x21-\x7e]+$/.test(sid)) ctx.add(finding('handshake.session_id_invalid', 'Mcp-Session-Id contains characters outside 0x21-0x7E'));
  } else {
    ctx.add(finding('handshake.session', 'No Mcp-Session-Id: the server is stateless'));
  }

  report.server = {
    sessionId: Boolean(sid),
    transport: r.transport,
    capabilities,
    ...(typeof version === 'string' ? { protocolVersion: version } : {}),
    ...(typeof info?.name === 'string' ? { name: info.name } : {}),
    ...(typeof info?.title === 'string' ? { title: info.title } : {}),
    ...(typeof info?.version === 'string' ? { version: info.version } : {}),
    ...(instructions ? { instructionsChars: instructions.length } : {}),
  };

  // initialized
  try {
    const n = await client.notify('notifications/initialized');
    if (n.status !== 202) {
      ctx.add(finding('handshake.initialized', `notifications/initialized answered HTTP ${n.status}${n.body ? ': ' + snippet(n.body, 100) : ''} (expected 202 Accepted)`));
    }
  } catch (e) {
    if (!(e instanceof TransportError)) throw e;
    ctx.add(finding('handshake.initialized', `notifications/initialized: ${e.message}`));
  }

  // ping
  const p = await call(ctx, 'ping');
  if (p instanceof TransportError || !p.response || p.response.error) ctx.add(finding('handshake.ping', `ping: ${describe(p)}`));

  return { protocolVersion: typeof version === 'string' ? version : PROTOCOL_VERSION, capabilities, ...(instructions ? { instructions } : {}) };
}

/** Parse the auth-params of a WWW-Authenticate header value (enough for resource_metadata, error, scope). */
export function parseAuthParams(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    const key = m[1]!.toLowerCase();
    if (!(key in out)) out[key] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]!;
  }
  return out;
}

/** After a 401: report it, then look for the OAuth protected resource metadata (RFC 9728) the client would follow. */
async function authDiscovery(ctx: ProbeContext, r: RpcResult): Promise<void> {
  const www = r.headers.get('www-authenticate') ?? '';
  const serverSays = r.response?.error?.message ?? r.body;
  ctx.add(finding('http.unauthorized', `initialize answered HTTP 401${www ? ' (WWW-Authenticate: ' + snippet(www, 120) + ')' : ' without WWW-Authenticate'}${serverSays ? ': ' + snippet(serverSays, 240) : ''}`));

  const candidates: string[] = [];
  const params = parseAuthParams(www);
  if (params.resource_metadata) candidates.push(params.resource_metadata);
  const u = new URL(ctx.client.url);
  const path = u.pathname.replace(/\/+$/, '');
  if (path) candidates.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  candidates.push(`${u.origin}/.well-known/oauth-protected-resource`);

  const fetchImpl = ctx.opts.fetch ?? globalThis.fetch;
  for (const url of [...new Set(candidates)]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ctx.opts.timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const doc: unknown = await res.json().catch(() => undefined);
      if (!isObject(doc)) continue;
      const servers = Array.isArray(doc.authorization_servers) ? doc.authorization_servers.filter((s) => typeof s === 'string') : [];
      const how = url === params.resource_metadata ? 'via resource_metadata' : 'at the well-known path (not linked from WWW-Authenticate)';
      if (servers.length === 0) {
        ctx.add(finding('auth.metadata_missing', `Protected resource metadata ${how} (${url}) lists no authorization_servers`));
      } else {
        ctx.add(finding('auth.metadata', `Protected resource metadata ${how}: ${url}; authorization servers: ${servers.join(', ')}`));
        if (!params.resource_metadata) ctx.add(finding('auth.metadata_missing', 'The 401 has no resource_metadata parameter in WWW-Authenticate; clients have to guess the well-known URL'));
      }
      return;
    } catch {
      /* try the next candidate */
    } finally {
      clearTimeout(timer);
    }
  }
  ctx.add(finding('auth.metadata_missing', `No OAuth protected resource metadata found (tried ${[...new Set(candidates)].join(', ')})`));
}
