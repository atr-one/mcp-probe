import type { Finding, Severity } from '../types.js';

interface CheckDef {
  severity: Severity;
  /** One line on what the check looks at (used by the README table and --list-checks). */
  title: string;
  /** How to fix it. */
  hint: string;
}

/** Every check mcp-probe can report, with its fixed severity and fix hint. */
export const CHECKS = {
  // connection and HTTP
  'connection.failed': { severity: 'error', title: 'No HTTP answer to initialize (DNS, TLS, refused, timeout)', hint: 'Check the URL, DNS, the TLS certificate and firewalls; raise --timeout if the server is slow to start.' },
  'http.unauthorized': { severity: 'error', title: 'initialize answered 401', hint: 'Send credentials with --header "Authorization: Bearer <token>". For OAuth clients the 401 must carry WWW-Authenticate with resource_metadata pointing to the protected resource metadata (RFC 9728).' },
  'auth.metadata': { severity: 'info', title: 'OAuth protected resource metadata found after a 401', hint: 'MCP clients follow resource_metadata to the authorization server; keep authorization_servers in it current.' },
  'auth.metadata_missing': { severity: 'warn', title: '401 without usable OAuth discovery', hint: 'Answer 401 with WWW-Authenticate: Bearer resource_metadata="https://host/.well-known/oauth-protected-resource" and serve that document (RFC 9728), or OAuth-capable clients cannot sign in.' },
  'http.forbidden': { severity: 'error', title: 'initialize answered 403', hint: 'A WAF or bot protection (Cloudflare, Akamai) often blocks non-browser clients; exempt the MCP path for API clients, or send the headers the server expects.' },
  'http.method_not_allowed': { severity: 'error', title: 'POST to the endpoint answered 405', hint: 'Streamable HTTP clients POST JSON-RPC to the endpoint URL. Check the path (often /mcp) and whether the server only speaks the old HTTP+SSE transport (2024-11-05).' },
  'http.status': { severity: 'error', title: 'initialize answered another non-2xx status', hint: 'Answer initialize with HTTP 200 and a JSON-RPC response.' },
  'http.content_type': { severity: 'error', title: 'Response Content-Type is neither application/json nor text/event-stream', hint: 'Set Content-Type: application/json (or text/event-stream for a streamed answer); clients dispatch on it.' },

  // handshake
  'handshake.invalid_response': { severity: 'error', title: 'initialize did not return a JSON-RPC response with the request id', hint: 'Answer {"jsonrpc":"2.0","id":<the request id>,"result":{...}} as JSON or as an SSE data: line.' },
  'handshake.rpc_error': { severity: 'error', title: 'initialize returned a JSON-RPC error', hint: 'initialize must succeed for a client that sends a protocolVersion, capabilities and clientInfo.' },
  'handshake.protocol_version': { severity: 'info', title: 'The server negotiated a different protocol version than requested', hint: 'Fine if deliberate; supporting the newest revision gives clients structured output, elicitation and the newer auth rules.' },
  'handshake.protocol_unknown': { severity: 'error', title: 'protocolVersion missing or not a known revision', hint: 'Return one of the published revisions (2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25), preferably the one the client asked for.' },
  'handshake.server_info': { severity: 'warn', title: 'serverInfo is missing a name or version', hint: 'Return serverInfo {name, version} (title optional); clients show it and logs use it.' },
  'handshake.capabilities': { severity: 'error', title: 'capabilities missing or not an object', hint: 'Return a capabilities object, e.g. {"tools":{}}.' },
  'handshake.no_tools': { severity: 'warn', title: 'The tools capability is not advertised', hint: 'Advertise "tools": {} in capabilities, or clients may never call tools/list.' },
  'handshake.instructions': { severity: 'info', title: 'Server instructions (presence and size)', hint: 'Instructions are added to the model context by many clients: keep them short and about how to use the tools together.' },
  'handshake.session': { severity: 'info', title: 'Whether the server issued an Mcp-Session-Id', hint: 'Stateless servers need no session; stateful ones must accept the id back on every request.' },
  'handshake.session_id_invalid': { severity: 'warn', title: 'Mcp-Session-Id has characters outside visible ASCII', hint: 'The spec limits session ids to visible ASCII (0x21-0x7E); use a UUID or a random token.' },
  'handshake.initialized': { severity: 'warn', title: 'notifications/initialized was not answered 202 Accepted', hint: 'Answer notifications (messages without an id) with HTTP 202 and no body.' },
  'handshake.ping': { severity: 'warn', title: 'ping failed', hint: 'Answer ping with an empty result {}; clients use it as a health check.' },

  // tool catalog
  'tools.list_failed': { severity: 'error', title: 'tools/list failed', hint: 'tools/list must return {"tools":[...]} (and nextCursor while there are more pages).' },
  'tools.empty': { severity: 'warn', title: 'tools/list returned no tools', hint: 'Expected at least one tool; check that the tools are registered for this endpoint and credentials.' },
  'tools.pagination': { severity: 'error', title: 'nextCursor pagination is broken (repeats, wrong type, endless)', hint: 'Return an opaque string nextCursor only while more pages exist, and never the same cursor twice.' },
  'tools.name_invalid': { severity: 'error', title: 'Tool name does not match ^[a-zA-Z0-9_-]{1,64}$', hint: 'Use letters, digits, _ and - only, at most 64 characters; several clients and model APIs reject other names.' },
  'tools.name_duplicate': { severity: 'error', title: 'Two tools share a name', hint: 'Tool names must be unique within a server.' },
  'tools.description_missing': { severity: 'error', title: 'Tool has no description', hint: 'The description is what the model reads to decide when to call the tool: say what it does, when to use it and what it returns.' },
  'tools.description_short': { severity: 'warn', title: 'Description shorter than 20 characters', hint: 'One or two sentences: what the tool does, when to use it, what it returns.' },
  'tools.description_long': { severity: 'warn', title: 'Description longer than 1024 characters', hint: 'Long descriptions cost context on every turn; move examples and edge cases into parameter descriptions or docs.' },
  'tools.description_duplicate': { severity: 'warn', title: 'Two tools have the same description', hint: 'The model cannot tell the tools apart; describe what makes each one different.' },
  'tools.description_similar': { severity: 'info', title: 'Two tools have nearly the same description (word overlap >= 85%)', hint: 'Say what makes each tool different, or merge them into one tool with a parameter.' },
  'tools.input_schema_missing': { severity: 'error', title: 'Tool has no inputSchema', hint: 'inputSchema is required; a tool without arguments uses {"type":"object","properties":{}}.' },
  'tools.input_schema_type': { severity: 'error', title: 'inputSchema.type is not "object"', hint: 'The input schema must be a JSON Schema with "type": "object".' },
  'tools.input_schema_invalid': { severity: 'error', title: 'inputSchema is not a sound JSON Schema', hint: 'Fix the reported keywords; clients and model APIs validate tool schemas and may drop the whole server.' },
  'tools.required_unknown': { severity: 'error', title: 'required names a property that is not in properties', hint: 'Every name in required must be declared in properties, or no call can satisfy the schema.' },
  'tools.param_description': { severity: 'warn', title: 'Some parameters have no description', hint: 'Describe every parameter: format, units, allowed values and an example; the model fills arguments from these.' },
  'tools.output_schema_missing': { severity: 'info', title: 'Tool has no outputSchema', hint: 'An outputSchema (2025-06-18) lets clients validate and use structuredContent without parsing text.' },
  'tools.output_schema_invalid': { severity: 'error', title: 'outputSchema is not an object schema or not sound', hint: 'outputSchema must be a JSON Schema with "type": "object".' },
  'tools.annotations_missing': { severity: 'info', title: 'Tool has no annotations', hint: 'Set annotations such as readOnlyHint, destructiveHint, idempotentHint and openWorldHint so clients can decide what needs confirmation.' },

  // context cost
  'cost.summary': { severity: 'info', title: 'Estimated context size of the tool catalog', hint: 'Every tool definition sits in the model context on every turn; trim descriptions and schemas that do not help the model choose or fill a call.' },
  'cost.over_budget': { severity: 'warn', title: 'Tool catalog estimate is above the token budget (--budget, default 8000)', hint: 'Shorten descriptions, drop rarely used tools, merge near-duplicates, or split the server into narrower endpoints.' },
  'cost.heaviest': { severity: 'info', title: 'The five heaviest tools', hint: 'Start trimming with these.' },

  // latency
  'latency.summary': { severity: 'info', title: 'Request latency (tools/list repeated --runs times)', hint: 'Protocol methods (initialize, tools/list, ping) should answer in well under a second.' },
  'latency.slow': { severity: 'warn', title: 'A protocol method has p95 above 2000 ms', hint: 'Cache the tool catalog and keep initialize free of slow work (database, upstream calls).' },
  'latency.failed': { severity: 'warn', title: 'Some repeated tools/list requests failed', hint: 'Intermittent failures under light load point at rate limits, cold starts or an unstable upstream.' },

  // error contract
  'errors.summary': { severity: 'info', title: 'How the server answered the error probes', hint: 'Errors a client can read (JSON-RPC errors or isError results) let agents recover instead of hanging.' },
  'errors.unknown_tool': { severity: 'error', title: 'Calling an unknown tool hung, failed at HTTP level or succeeded', hint: 'Answer tools/call for an unknown name with JSON-RPC error -32602 (or an isError result), with HTTP 200.' },
  'errors.unknown_tool_code': { severity: 'info', title: 'Unknown tool answered, but not as JSON-RPC error -32602', hint: 'The 2025-06-18 spec lists unknown tools as protocol error -32602; an isError result also works with most clients.' },
  'errors.invalid_arguments': { severity: 'error', title: 'A call with invalid arguments hung or failed at HTTP level', hint: 'Validate arguments and answer an isError result (or JSON-RPC -32602) that says what is wrong, with HTTP 200.' },
  'errors.invalid_arguments_accepted': { severity: 'warn', title: 'A call missing its required arguments succeeded', hint: 'Validate arguments against inputSchema before running the tool, and say what is missing.' },
  'errors.invalid_arguments_skipped': { severity: 'info', title: 'No tool suitable for the invalid-arguments probe', hint: 'The probe only calls a tool without its required arguments; tools with no required arguments are not called.' },
  'errors.unknown_method': { severity: 'warn', title: 'An unknown JSON-RPC method did not answer -32601', hint: 'Answer methods you do not implement with JSON-RPC error -32601 (Method not found).' },

  // scenarios
  'scenario.file': { severity: 'error', title: 'The scenario file could not be read or is malformed', hint: 'See the scenario format in the README: a list of {tool, arguments, expect}.' },
  'scenario.unknown_tool': { severity: 'error', title: 'A scenario names a tool that tools/list does not have', hint: 'Fix the tool name in the scenario, or check that the tool is exposed with these credentials.' },
  'scenario.failed': { severity: 'error', title: 'A scenario call failed (timeout, HTTP error, JSON-RPC error)', hint: 'The call itself did not produce a tool result; see the message.' },
  'scenario.is_error': { severity: 'error', title: 'isError differs from expect.isError', hint: 'Check the arguments, or the server-side failure the result text describes.' },
  'scenario.contains': { severity: 'error', title: 'Result text does not contain expect.contains', hint: 'Check the arguments or update the expected text.' },
  'scenario.slow': { severity: 'error', title: 'The call took longer than expect.maxMs', hint: 'Speed up the tool or raise maxMs.' },
  'scenario.schema': { severity: 'error', title: 'structuredContent does not match the tool outputSchema', hint: 'Servers must return structuredContent that conforms to the declared outputSchema; fix the result or the schema.' },
  'scenario.passed': { severity: 'info', title: 'A scenario passed', hint: 'Nothing to do.' },

  // resources and prompts
  'resources.summary': { severity: 'info', title: 'Resources listed', hint: 'Nothing to do.' },
  'resources.list_failed': { severity: 'warn', title: 'resources/list failed although resources are advertised', hint: 'Implement resources/list, or stop advertising the resources capability.' },
  'resources.lint': { severity: 'info', title: 'Resources without name/description, or duplicate URIs', hint: 'Give every resource a unique uri, a name and a description.' },
  'prompts.summary': { severity: 'info', title: 'Prompts listed', hint: 'Nothing to do.' },
  'prompts.list_failed': { severity: 'warn', title: 'prompts/list failed although prompts are advertised', hint: 'Implement prompts/list, or stop advertising the prompts capability.' },
  'prompts.lint': { severity: 'info', title: 'Prompts without description, undescribed arguments, duplicate names', hint: 'Give every prompt a unique name, a description and described arguments.' },
} satisfies Record<string, CheckDef>;

export type CheckId = keyof typeof CHECKS;

export function finding(id: CheckId, message: string, subject?: string): Finding {
  const def: CheckDef = CHECKS[id];
  const f: Finding = { id, severity: def.severity, message, hint: def.hint };
  if (subject !== undefined) f.subject = subject;
  return f;
}
