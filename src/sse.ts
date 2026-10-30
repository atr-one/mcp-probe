/**
 * A small Server-Sent Events parser (the WHATWG event-stream format) that takes text in chunks of any size,
 * plus the helper that picks the JSON-RPC response with a given id out of the messages.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private hasData = false;
  private eventType = '';
  private lastId: string | undefined;
  private started = false;

  /** Feed a decoded chunk; returns the events completed by it. */
  push(chunk: string): SseEvent[] {
    if (!this.started && chunk.length > 0) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let start = 0;
    let i = 0;
    while (i < this.buffer.length) {
      const c = this.buffer[i];
      if (c === '\n' || c === '\r') {
        // a CR at the very end may be the first half of CRLF: wait for the next chunk
        if (c === '\r' && i + 1 >= this.buffer.length) break;
        const line = this.buffer.slice(start, i);
        if (c === '\r' && this.buffer[i + 1] === '\n') i++;
        start = i + 1;
        this.line(line, out);
      }
      i++;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /**
   * End of stream. The spec drops an event that was not closed by a blank line; servers that close the
   * stream right after their last data line are common, so it is dispatched here instead.
   */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    let rest = this.buffer;
    this.buffer = '';
    if (rest.endsWith('\r')) rest = rest.slice(0, -1);
    if (rest.length > 0) this.line(rest, out);
    this.dispatch(out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataLines.push(value);
      this.hasData = true;
    } else if (field === 'event') {
      this.eventType = value;
    } else if (field === 'id') {
      if (!value.includes('\0')) this.lastId = value;
    }
  }

  private dispatch(out: SseEvent[]): void {
    if (this.hasData) {
      const ev: SseEvent = { event: this.eventType || 'message', data: this.dataLines.join('\n') };
      if (this.lastId !== undefined) ev.id = this.lastId;
      out.push(ev);
    }
    this.dataLines = [];
    this.hasData = false;
    this.eventType = '';
  }
}

/** Parse a complete event stream. */
export function parseSse(text: string): SseEvent[] {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.end()];
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The JSON-RPC response for `id` in a parsed message (a single message or a batch). An error response with
 * a null id also counts: JSON-RPC answers so when it could not read the id of the request.
 */
export function matchResponse(message: unknown, id: string | number): JsonRpcResponse | undefined {
  const list = Array.isArray(message) ? message : [message];
  for (const m of list) {
    if (!isObject(m)) continue;
    const hasResult = 'result' in m;
    const hasError = 'error' in m && isObject(m.error);
    if (!hasResult && !hasError) continue;
    if (m.id === id || (m.id === null && hasError)) {
      const res: JsonRpcResponse = { id: m.id as string | number | null };
      if (hasResult) res.result = m.result;
      if (hasError) {
        const e = m.error as Record<string, unknown>;
        res.error = { code: typeof e.code === 'number' ? e.code : NaN, message: typeof e.message === 'string' ? e.message : '' };
        if ('data' in e) res.error.data = e.data;
      }
      return res;
    }
  }
  return undefined;
}

/** Find the response for `id` among SSE events; `others` counts the messages that were not it. */
export function findResponse(events: SseEvent[], id: string | number): { response?: JsonRpcResponse; others: number } {
  let others = 0;
  for (const ev of events) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      others++;
      continue;
    }
    const response = matchResponse(parsed, id);
    if (response) return { response, others };
    others++;
  }
  return { others };
}
