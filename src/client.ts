/**
 * A minimal MCP Streamable HTTP client: JSON-RPC 2.0 over POST, the answer either application/json or a
 * text/event-stream whose data: lines carry JSON-RPC messages. It keeps the Mcp-Session-Id the server hands
 * out on initialize and the negotiated MCP-Protocol-Version, and times every request.
 */
import { SseParser, matchResponse, type JsonRpcResponse } from './sse.js';
import { VERSION } from './version.js';

/** The protocol version mcp-probe asks for in initialize. */
export const PROTOCOL_VERSION = '2025-06-18';

export type Problem = 'http' | 'content-type' | 'invalid-json' | 'no-response';

export interface RpcResult {
  method: string;
  status: number;
  contentType: string;
  headers: Headers;
  /** Wall time from sending the request to having the response (or the end of the body). */
  ms: number;
  transport?: 'json' | 'sse';
  /** The JSON-RPC response with the request's id, when one arrived. */
  response?: JsonRpcResponse;
  /** Why the answer is not a clean 2xx JSON-RPC response. */
  problem?: Problem;
  /** Up to 2 KB of the body when it was not a usable response. */
  body?: string;
  /** Other messages (notifications, server requests) seen in an SSE stream before the response. */
  extraMessages: number;
}

export class TransportError extends Error {
  readonly kind: 'network' | 'timeout';
  readonly method: string;
  constructor(message: string, kind: 'network' | 'timeout', method: string) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.method = method;
  }
}

export interface ClientOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const BODY_SNIPPET = 2048;

export class McpClient {
  readonly url: string;
  sessionId?: string;
  protocolVersion?: string;
  /** Every request made, in order. */
  readonly timings: { method: string; ms: number }[] = [];
  private nextId = 1;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(url: string, options: ClientOptions = {}) {
    this.url = url;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 20_000;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new Error('No fetch implementation: mcp-probe needs Node.js 18 or newer.');
    this.fetchImpl = f;
  }

  /** Send a request and wait for its response. Throws TransportError when no HTTP answer arrives in time. */
  request(method: string, params?: unknown): Promise<RpcResult> {
    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    return this.post(method, message, id);
  }

  /** Send a notification (no id, no response expected; servers answer 202 Accepted). */
  notify(method: string, params?: unknown): Promise<RpcResult> {
    const message: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    return this.post(method, message, undefined);
  }

  /** End the session with DELETE when the server issued one. Returns the HTTP status, or undefined. */
  async close(): Promise<number | undefined> {
    if (!this.sessionId) return undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, { method: 'DELETE', headers: this.requestHeaders(), signal: ctrl.signal });
      await res.body?.cancel().catch(() => undefined);
      return res.status;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private requestHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': `mcp-probe/${VERSION} (+https://github.com/atr-one/mcp-probe)`,
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    for (const [k, v] of Object.entries(this.headers)) h[k.toLowerCase()] = v;
    return h;
  }

  private async post(method: string, message: Record<string, unknown>, id: number | undefined): Promise<RpcResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const started = performance.now();
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: this.requestHeaders(),
          body: JSON.stringify(message),
          signal: ctrl.signal,
        });
      } catch (e) {
        throw this.transportError(e, ctrl.signal.aborted, method);
      }
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const out: RpcResult = { method, status: res.status, contentType, headers: res.headers, ms: 0, extraMessages: 0 };
      if (method === 'initialize' && res.ok) {
        const sid = res.headers.get('mcp-session-id');
        if (sid) this.sessionId = sid;
      }
      try {
        if (id !== undefined && res.ok && contentType.startsWith('text/event-stream')) {
          await this.readSse(res, id, out);
        } else {
          this.readBody(await res.text(), res.ok, id, out);
        }
      } catch (e) {
        throw this.transportError(e, ctrl.signal.aborted, method);
      }
      out.ms = Math.round((performance.now() - started) * 10) / 10;
      this.timings.push({ method, ms: out.ms });
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  private readBody(text: string, ok: boolean, id: number | undefined, out: RpcResult): void {
    if (id === undefined) {
      if (text) out.body = text.slice(0, BODY_SNIPPET);
      if (!ok) out.problem = 'http';
      return;
    }
    let parsed: unknown;
    let parsedOk = false;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
        parsedOk = true;
      } catch {
        /* reported below */
      }
    }
    const response = parsedOk ? matchResponse(parsed, id) : undefined;
    if (response) {
      out.response = response;
      out.transport = 'json';
    }
    const isJson = /^application\/([\w.+-]*\+)?json\b/.test(out.contentType);
    if (!ok) out.problem = 'http';
    else if (!isJson) out.problem = 'content-type';
    else if (!parsedOk) out.problem = 'invalid-json';
    else if (!response) out.problem = 'no-response';
    if (out.problem) out.body = text.slice(0, BODY_SNIPPET);
  }

  private async readSse(res: Response, id: number, out: RpcResult): Promise<void> {
    out.transport = 'sse';
    if (!res.body) {
      out.problem = 'no-response';
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let seen = '';
    for (;;) {
      const { done, value } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (seen.length < BODY_SNIPPET) seen += text.slice(0, BODY_SNIPPET - seen.length);
      const events = done ? [...parser.push(text), ...parser.end()] : parser.push(text);
      for (const ev of events) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          out.extraMessages++;
          continue;
        }
        const response = matchResponse(parsed, id);
        if (response) {
          out.response = response;
          // the server may keep the stream open for more messages; we have what we came for
          reader.cancel().catch(() => undefined);
          return;
        }
        out.extraMessages++;
      }
      if (done) break;
    }
    out.problem = 'no-response';
    out.body = seen;
  }

  private transportError(e: unknown, aborted: boolean, method: string): TransportError {
    if (aborted) return new TransportError(`no answer within ${this.timeoutMs} ms`, 'timeout', method);
    return new TransportError(describeNetworkError(e), 'network', method);
  }
}

/** Node's fetch says "fetch failed" and keeps the reason in `cause`; surface it. */
export function describeNetworkError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return `${e.message}: ${code ? code + ' ' : ''}${cause.message}`.trim();
  }
  return e.message;
}
