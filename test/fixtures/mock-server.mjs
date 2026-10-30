// A tiny in-process MCP server (Streamable HTTP) for tests and for the README example.
// Two tools: get_weather (clean) and "Search Docs!" (lint problems on purpose).
// Run it alone with `npm run mock` (or `node test/fixtures/mock-server.mjs [port]`).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TOOLS = [
  {
    name: 'get_weather',
    title: 'Current weather',
    description: 'Current weather for a city: temperature and a short condition text. Returns an error result when the city is unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, e.g. "Berlin"' },
        units: { type: 'string', enum: ['c', 'f'], description: 'Temperature units: c (default) or f' },
      },
      required: ['city'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        temperature: { type: 'number' },
        units: { type: 'string', enum: ['c', 'f'] },
        condition: { type: 'string' },
      },
      required: ['city', 'temperature', 'units', 'condition'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'Search Docs!',
    description: 'Search docs.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' }, limit: { type: 'integer', description: 'Max results' } },
      required: ['query'],
    },
  },
];

const CITIES = { berlin: 21.5, lisbon: 24, oslo: 9.5 };

/**
 * @param {{ sse?: boolean, session?: boolean, auth?: string, pageSize?: number, crashOnUnknownTool?: boolean, badWeatherShape?: boolean }} [options]
 *   sse: answer requests as text/event-stream (with a progress notification first)
 *   session: issue an Mcp-Session-Id and require it afterwards
 *   auth: a bearer token to require; without it initialize answers 401 with OAuth discovery
 *   pageSize: tools per tools/list page (default 1, so pagination is exercised)
 *   crashOnUnknownTool: answer HTTP 500 to a tools/call of an unknown tool
 *   badWeatherShape: get_weather returns temperature as a string (breaks its outputSchema)
 */
export function createMockServer(options = {}) {
  const pageSize = options.pageSize ?? 1;
  const sessions = new Set();
  /** @type {{ method: string, headers: Record<string, string | string[] | undefined> }[]} */
  const requests = [];

  function toolResult(name, args) {
    if (name === 'get_weather') {
      if (typeof args.city !== 'string' || args.city === '') {
        return { content: [{ type: 'text', text: 'Missing required argument: city' }], isError: true };
      }
      const c = CITIES[args.city.toLowerCase()];
      if (c === undefined) return { content: [{ type: 'text', text: `Unknown city: ${args.city}` }], isError: true };
      const units = args.units === 'f' ? 'f' : 'c';
      const temperature = units === 'f' ? Math.round((c * 9) / 5 + 32) : c;
      const data = { city: args.city, temperature: options.badWeatherShape ? String(temperature) : temperature, units, condition: 'clear' };
      return { content: [{ type: 'text', text: `${args.city}: ${temperature}${units.toUpperCase()}, clear` }], structuredContent: data };
    }
    return { content: [{ type: 'text', text: `No results for ${JSON.stringify(args.q ?? '')}` }] };
  }

  function handle(msg) {
    const { id, method, params = {} } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: params.protocolVersion === '2025-06-18' ? '2025-06-18' : '2025-03-26',
          capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
          serverInfo: { name: 'mock-weather', version: '1.0.0' },
          instructions: 'Use get_weather for current conditions in a city.',
        });
      case 'ping':
        return ok({});
      case 'tools/list': {
        const start = params.cursor ? Number(Buffer.from(params.cursor, 'base64url').toString()) : 0;
        if (!Number.isInteger(start) || start < 0) return err(-32602, 'Invalid cursor');
        const page = TOOLS.slice(start, start + pageSize);
        const next = start + pageSize < TOOLS.length ? Buffer.from(String(start + pageSize)).toString('base64url') : undefined;
        return ok(next ? { tools: page, nextCursor: next } : { tools: page });
      }
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return options.crashOnUnknownTool ? 'crash' : err(-32602, `Unknown tool: ${params.name}`);
        return ok(toolResult(tool.name, params.arguments ?? {}));
      }
      case 'resources/list':
        return ok({ resources: [{ uri: 'docs://readme', name: 'readme', mimeType: 'text/markdown' }] });
      case 'prompts/list':
        return ok({ prompts: [{ name: 'weather_report', description: 'A short weather report for a city.', arguments: [{ name: 'city', required: true }] }] });
      default:
        return err(-32601, `Method not found: ${method}`);
    }
  }

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(payload === undefined ? '' : JSON.stringify(payload));
      };
      if (req.url && req.url.startsWith('/.well-known/oauth-protected-resource')) {
        return send(200, { resource: `http://${req.headers.host}/mcp`, authorization_servers: [`http://${req.headers.host}/auth`] });
      }
      if (req.url !== '/mcp') return send(404, { error: 'not found' });
      if (req.method === 'DELETE') {
        sessions.delete(req.headers['mcp-session-id']);
        return send(204);
      }
      if (req.method !== 'POST') return send(405, undefined, { allow: 'POST, DELETE' });
      if (options.auth && req.headers.authorization !== `Bearer ${options.auth}`) {
        return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Authentication required' } }, {
          'www-authenticate': `Bearer resource_metadata="http://${req.headers.host}/.well-known/oauth-protected-resource/mcp"`,
        });
      }
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      requests.push({ method: msg.method, headers: req.headers });
      const extraHeaders = {};
      if (options.session) {
        if (msg.method === 'initialize') {
          const sid = randomUUID();
          sessions.add(sid);
          extraHeaders['mcp-session-id'] = sid;
        } else if (!sessions.has(req.headers['mcp-session-id'])) {
          return send(400, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'Missing or unknown Mcp-Session-Id' } });
        }
      }
      if (msg.id === undefined) {
        res.writeHead(202, extraHeaders);
        return res.end();
      }
      const answer = handle(msg);
      if (answer === 'crash') return send(500, { error: 'internal' });
      if (options.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...extraHeaders });
        res.write(`: mock stream\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
        // the response split across two writes and lines, to exercise the parser
        const json = JSON.stringify(answer);
        res.write(`id: ${msg.id}\r\ndata: ${json.slice(0, 10)}`);
        setTimeout(() => res.end(`${json.slice(10)}\r\n\r\n`), 2);
        return undefined;
      }
      return send(200, answer, extraHeaders);
    });
  });

  return {
    server,
    requests,
    /** @returns {Promise<string>} the endpoint URL */
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}/mcp`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = createMockServer({ sse: true, session: true });
  mock.listen(Number(process.argv[2] ?? 8765)).then((url) => console.log(`mock MCP server on ${url}`));
}
