# mcp-probe

mcp-probe audits a remote [Model Context Protocol](https://modelcontextprotocol.io) server over the Streamable HTTP transport and tells you what to fix. It performs the handshake the way a client does, lints the tool catalog that agents will read, estimates how much of a model's context window that catalog takes, measures latency, runs your own `tools/call` scenarios with assertions, and checks that the server reports errors instead of hanging or answering HTTP 500. The output is a console report, optional JSON and Markdown files, and an exit code you can use to gate CI.

It has one runtime dependency (`yaml`) and does not use the MCP SDK: the JSON-RPC client and the SSE reader are small and part of this package.

## Install and run

Requires Node.js 18 or newer.

```sh
npx github:atr-one/mcp-probe https://example.com/mcp
```

The package is not on the npm registry yet; installing from GitHub builds it on the fly (the `prepare` script).

or install it in a project:

```sh
npm install --save-dev github:atr-one/mcp-probe
```

```text
Usage: mcp-probe <url> [options]

Options:
  -H, --header "Name: value"  HTTP header for every request (repeatable)
  -s, --scenario <file>       YAML or JSON scenarios to run with tools/call
      --json <file>           write the report as JSON
      --md <file>             write the report as Markdown
      --fail-on <level>       exit 1 on findings at or above: error (default), warn, info, never
      --baseline <file>       compare with an earlier --json report: new and gone findings, deltas
      --fail-on-new           with --baseline: only new findings at or above --fail-on fail the run
      --timeout <time>        per-request timeout: seconds, or with a unit (1500ms, 30s); default 20s
      --budget <tokens>       context budget for the tool catalog; default 8000
      --runs <n>              tools/list repetitions for latency; default 5
      --skip <groups>         comma-separated: tools, cost, latency, errors, scenarios, resources
      --no-color              plain output (also when NO_COLOR is set or stdout is not a TTY)
      --color                 force colors
      --list-checks           print every check id with its severity and exit
  -h, --help                  show this help
  -v, --version               show the version
```

Examples:

```sh
# a server behind a bearer token, failing on warnings too
npx mcp-probe https://api.example.com/mcp -H "Authorization: Bearer $MCP_TOKEN" --fail-on warn

# with scenarios, writing both report files
npx mcp-probe https://api.example.com/mcp --scenario probe.yaml --json report.json --md report.md
```

Exit codes:

| Code | Meaning |
| ---: | --- |
| 0 | No findings at or above `--fail-on` |
| 1 | At least one finding at or above `--fail-on` (default `error`) |
| 2 | No connection to the server (DNS, TLS, refused, timeout on `initialize`), or bad command-line arguments |

## Example output

Real output against the test server in this repository (`npm run mock`, which answers over SSE and issues a session id; it has one clean tool and one with deliberate problems):

```text
$ npx mcp-probe http://127.0.0.1:8765/mcp --scenario examples/probe.yaml
mcp-probe 0.1.0  http://127.0.0.1:8765/mcp

  Server    mock-weather 1.0.0 (protocol 2025-06-18, SSE answers, session id)
  Tools     2, ~154 tokens in context (budget 8,000)
  Extras    1 resource, 1 prompt
  Latency   initialize 78 ms; ping 14 ms; tools/list p50 15 ms / p95 16 ms (7)
  Scenarios 3 passed

ERRORS
  tools.name_invalid
    Search Docs!: "Search Docs!" does not match ^[a-zA-Z0-9_-]{1,64}$
    fix: Use letters, digits, _ and - only, at most 64 characters; several clients and model APIs reject other names.
  tools.required_unknown
    Search Docs!: required lists "query", not in properties
    fix: Every name in required must be declared in properties, or no call can satisfy the schema.

WARNINGS
  tools.description_short
    Search Docs!: Description is 12 chars: "Search docs."
    fix: One or two sentences: what the tool does, when to use it, what it returns.
  tools.param_description
    Search Docs!: 1 of 2 parameters without description: q
    fix: Describe every parameter: format, units, allowed values and an example; the model fills arguments from these.

INFO
  handshake.instructions
    Instructions: 49 chars, ~13 tokens
  handshake.session
    Session id issued (36 chars); sent back on every request
  tools.output_schema_missing
    Search Docs!: No outputSchema
  tools.annotations_missing
    Search Docs!: No annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)
  cost.summary
    2 tools take ~154 tokens (612 chars as name + description + inputSchema; 940 chars on the wire), 2% of the 8,000-token budget; instructions add ~13
  cost.heaviest
    get_weather ~104, Search Docs! ~50
  errors.summary
    unknown tool -> JSON-RPC error -32602; get_weather without required arguments -> an isError result; unknown method -> JSON-RPC error -32601
  scenario.passed (3)
    weather in Berlin: passed in 16 ms
    unknown city is an error result: passed in 15 ms (error result, as expected)
    Fahrenheit: passed in 16 ms
  resources.summary
    1 resource
  resources.lint
    1 of 1 resources have no description: readme
  prompts.summary
    1 prompt
  prompts.lint
    1 prompt argument without description: weather_report.city
  latency.summary
    initialize 78 ms; ping 14 ms; tools/list p50 15 ms, p95 16 ms (7 requests); mcp_probe/no_such_method 16 ms; resources/list 15 ms; prompts/list 16 ms

Heaviest tools (estimated tokens in context)
  get_weather      104
  Search Docs!      50

Result  2 errors, 2 warnings, 15 info in 388 ms; fails at --fail-on error (exit 1)
```

When a check fires for many tools, the console shows the first five and names the rest; the JSON and Markdown reports contain every finding.

## What it checks

Every finding has a stable id, a severity (`error`, `warn` or `info`), a message and a hint on how to fix it. `mcp-probe --list-checks` prints the same list.

### Connection and handshake

mcp-probe sends `initialize` with `protocolVersion: "2025-06-18"`, empty client capabilities and `clientInfo`, then `notifications/initialized` and `ping`. Requests carry `Accept: application/json, text/event-stream`; after `initialize` they also carry `MCP-Protocol-Version` and, when the server issued one, `Mcp-Session-Id`. At the end a session is closed with `DELETE`.

| Id | Severity | What |
| --- | --- | --- |
| `connection.failed` | error | No HTTP answer to `initialize` (DNS, TLS, refused, timeout). Exit code 2. |
| `http.unauthorized` | error | `initialize` answered 401. The server's error message is quoted. |
| `auth.metadata` | info | After a 401: the OAuth protected resource metadata (RFC 9728) that clients would follow, and its authorization servers. |
| `auth.metadata_missing` | warn | A 401 without `resource_metadata` in `WWW-Authenticate`, or no metadata document at all. |
| `http.forbidden` | error | 403, with the `server` header and Cloudflare ray id when present (bot protection is the usual cause). |
| `http.method_not_allowed` | error | 405 to POST: wrong path, or an old HTTP+SSE-only server. |
| `http.status` | error | Any other non-2xx answer to `initialize`. |
| `http.content_type` | error | A 2xx answer that is neither `application/json` nor `text/event-stream`. |
| `handshake.invalid_response` | error | No JSON-RPC response with the request id (not JSON, wrong id, stream ended). |
| `handshake.rpc_error` | error | `initialize` returned a JSON-RPC error. |
| `handshake.protocol_version` | info | The server negotiated an older revision than requested. |
| `handshake.protocol_unknown` | error | `protocolVersion` missing or not a published revision. |
| `handshake.server_info` | warn | `serverInfo` lacks `name` or `version`. |
| `handshake.capabilities` | error | No `capabilities` object. |
| `handshake.no_tools` | warn | `tools` capability not advertised. |
| `handshake.instructions` | info | Size of the server `instructions` (they go into the model context in many clients). |
| `handshake.session` | info | Whether an `Mcp-Session-Id` was issued (stateful) or not (stateless). |
| `handshake.session_id_invalid` | warn | Session id with characters outside visible ASCII. |
| `handshake.initialized` | warn | `notifications/initialized` not answered with 202 Accepted. |
| `handshake.ping` | warn | `ping` failed. |

### Tool catalog lint

`tools/list` is followed through `nextCursor` (up to 100 pages; a repeated cursor stops it).

| Id | Severity | What |
| --- | --- | --- |
| `tools.list_failed` | error | `tools/list` failed or `result.tools` is not an array. |
| `tools.empty` | warn | No tools. |
| `tools.pagination` | error | `nextCursor` repeats, is not a string, or never ends. |
| `tools.name_invalid` | error | Name does not match `^[a-zA-Z0-9_-]{1,64}$`. |
| `tools.name_duplicate` | error | Two tools share a name. |
| `tools.description_missing` | error | No description. |
| `tools.description_short` | warn | Description under 20 characters. |
| `tools.description_long` | warn | Description over 1024 characters. |
| `tools.description_duplicate` | warn | Two tools with the same description. |
| `tools.description_similar` | info | Two descriptions whose word sets overlap 85% or more (Jaccard, at least 6 words each). |
| `tools.input_schema_missing` | error | No `inputSchema`. |
| `tools.input_schema_type` | error | `inputSchema.type` is not `"object"`. |
| `tools.input_schema_invalid` | error | Structural problems: unknown type names, `properties` that is not an object (for example `[]` from an empty PHP array), `required` that is not a string list, empty `enum`, at any depth. |
| `tools.required_unknown` | error | `required` names a property that is not in `properties`. |
| `tools.param_description` | warn | Top-level parameters without a description. |
| `tools.output_schema_missing` | info | No `outputSchema`. |
| `tools.output_schema_invalid` | error | `outputSchema` is not an object schema, or has structural problems. |
| `tools.annotations_missing` | info | No annotations besides `title` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). |

### Context cost

| Id | Severity | What |
| --- | --- | --- |
| `cost.summary` | info | Estimated tokens and characters of the catalog, the share of the budget, and the instructions on top. |
| `cost.over_budget` | warn | The estimate is above `--budget` (default 8,000 tokens). |
| `cost.heaviest` | info | The five heaviest tools. |

See [Context cost](#context-cost-1) below for how the estimate is made.

### Latency

Every request is timed. `tools/list` is repeated `--runs` times (default 5) on top of the initial listing, and p50/p95 (nearest rank) are reported per method.

| Id | Severity | What |
| --- | --- | --- |
| `latency.summary` | info | p50/p95 per protocol method. |
| `latency.slow` | warn | A protocol method (not `tools/call`) with p95 above 2000 ms. |
| `latency.failed` | warn | Some of the repeated `tools/list` requests failed. |

### Error contract

Three requests that a well-behaved server refuses cleanly:

1. `tools/call` of a tool that does not exist. Expected: JSON-RPC error `-32602`; an `isError` result is accepted with an info note.
2. `tools/call` of a real tool with `{}` when it has required arguments. Expected: a JSON-RPC error or an `isError` result. mcp-probe picks a tool marked `readOnlyHint: true` if there is one, never one marked `destructiveHint: true`, and never calls a tool without required arguments, so the call is refused before any work is done.
3. An unknown method. Expected: JSON-RPC error `-32601`.

A hang (timeout), an HTTP 5xx or a success result is a finding.

| Id | Severity | What |
| --- | --- | --- |
| `errors.summary` | info | How each probe was answered. |
| `errors.unknown_tool` | error | The unknown tool call timed out, failed at HTTP level, or succeeded. |
| `errors.unknown_tool_code` | info | Answered, but not as JSON-RPC `-32602`. |
| `errors.invalid_arguments` | error | The call without required arguments timed out or failed at HTTP level. |
| `errors.invalid_arguments_accepted` | warn | The call without required arguments succeeded. |
| `errors.invalid_arguments_skipped` | info | No tool has required arguments, so this probe did not run. |
| `errors.unknown_method` | warn | The unknown method was not answered with `-32601`. |

Use `--skip errors` if you do not want any `tools/call` made outside your own scenarios.

### Scenarios

| Id | Severity | What |
| --- | --- | --- |
| `scenario.file` | error | The scenario file could not be read or is malformed (the message names the entry). |
| `scenario.unknown_tool` | error | The scenario names a tool that `tools/list` does not have. |
| `scenario.failed` | error | Timeout, HTTP error or JSON-RPC error instead of a tool result. |
| `scenario.is_error` | error | `isError` differs from `expect.isError`. |
| `scenario.contains` | error | The result text does not contain `expect.contains`. |
| `scenario.slow` | error | The call took longer than `expect.maxMs`. |
| `scenario.schema` | error | `structuredContent` does not match the tool's `outputSchema`, or is missing although the tool declares one. |
| `scenario.passed` | info | The scenario passed. |

### Resources and prompts

Only when the server advertises the capability.

| Id | Severity | What |
| --- | --- | --- |
| `resources.summary` | info | Number of resources. |
| `resources.list_failed` | warn | `resources/list` failed. |
| `resources.lint` | info | Resources without uri, name or description; duplicate URIs. |
| `prompts.summary` | info | Number of prompts. |
| `prompts.list_failed` | warn | `prompts/list` failed. |
| `prompts.lint` | info | Prompts without description, arguments without description, duplicate names. |

## Scenarios

A scenario file is YAML or JSON: either a list, or an object with a `scenarios` list. Each entry:

| Key | Type | Meaning |
| --- | --- | --- |
| `tool` | string | Tool to call (required). |
| `name` | string | Label in the report; defaults to the tool name. |
| `arguments` | object | Arguments for `tools/call`; defaults to `{}`. |
| `expect.isError` | boolean | The result must (true) or must not (false) be an error. A JSON-RPC error counts as an error outcome. Not checked when absent. |
| `expect.contains` | string | Substring of the result: the text content items plus `structuredContent` serialized as JSON. |
| `expect.maxMs` | number | Time limit for the call in milliseconds. |
| `expect.schemaValid` | boolean | Validate `structuredContent` against the tool's `outputSchema`. On by default when the tool has an `outputSchema` and the result is not an error; `false` turns it off, `true` makes a missing `outputSchema` a failure. |

[`examples/probe.yaml`](examples/probe.yaml):

```yaml
scenarios:
  - name: weather in Berlin
    tool: get_weather
    arguments: { city: Berlin }
    expect:
      isError: false
      contains: Berlin
      maxMs: 2000

  - name: unknown city is an error result
    tool: get_weather
    arguments: { city: Atlantis }
    expect: { isError: true, contains: Unknown city }

  - name: Fahrenheit
    tool: get_weather
    arguments: { city: Oslo, units: f }
    expect: { contains: "49F" }
```

Scenarios call real tools with real arguments. Point them at read-only tools, or at a staging server.

The validator for `outputSchema` supports a subset of JSON Schema: `type` (including type lists and `integer`), `properties`, `required`, `items` (single schema and tuple form), `additionalProperties`, `enum`, `const`, `anyOf`, `oneOf`, `allOf`. Other keywords (`$ref`, `format`, `minimum`, `pattern`, ...) are ignored, so it errs on the side of accepting.

## Use in CI

### GitHub Action

The repository is also a GitHub Action. It sets up Node.js 22, builds mcp-probe from the tagged source, runs it and appends the Markdown report to the job summary.

```yaml
# .github/workflows/mcp.yml
name: MCP server check
on:
  push:
    branches: [main]
  schedule:
    - cron: "0 6 * * *"
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4   # only needed for a scenario file from the repository
      - uses: atr-one/mcp-probe@v0.2.0
        with:
          url: https://staging.example.com/mcp
          headers: |
            Authorization: Bearer ${{ secrets.MCP_TOKEN }}
          scenario: probe.yaml
          fail-on: error
          json: mcp-report.json
```

| Input | Default | Meaning |
| --- | --- | --- |
| `url` | (required) | The MCP endpoint. |
| `headers` | | HTTP headers, one `Name: value` per line; empty lines are skipped. |
| `scenario` | | Scenario file, relative to the workspace. |
| `fail-on` | `error` | Fail the step on findings at or above `error`, `warn`, `info`, or `never`. |
| `baseline` | | An earlier JSON report to compare with; see [Compare with a previous report](#compare-with-a-previous-report). |
| `fail-on-new` | `false` | With `baseline`: `true` fails the step only on new findings at or above `fail-on`. |
| `json` | | Write the JSON report to this path. |
| `md` | | Write the Markdown report to this path. The report goes to the job summary either way. |

The output `exit-code` holds the exit code of mcp-probe (see the table above); the step fails on 1 and 2. The action runs `actions/setup-node`, so later steps in the same job see Node.js 22 unless they set up their own version.

### With npx

```yaml
# .github/workflows/mcp.yml
name: MCP server check
on:
  push:
    branches: [main]
  schedule:
    - cron: "0 6 * * *"
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Probe the MCP server
        run: >
          npx --yes github:atr-one/mcp-probe#v0.1.0 https://staging.example.com/mcp
          --header "Authorization: Bearer ${{ secrets.MCP_TOKEN }}"
          --scenario probe.yaml
          --fail-on error
          --md mcp-report.md --json mcp-report.json
      - name: Add the report to the job summary
        if: always()
        run: cat mcp-report.md >> "$GITHUB_STEP_SUMMARY"
```

The step fails when there are findings at or above `--fail-on` (exit 1) or when the server cannot be reached (exit 2). Use `--fail-on warn` once the warnings are fixed, to keep them fixed.

## Compare with a previous report

`--baseline previous.json` reads a report written earlier with `--json` and adds a section to the console and Markdown output: findings that are new, findings that are gone, and how the estimated context tokens, the tool count and the `tools/list` p50 latency changed.

```text
Compared with the baseline (probed 2026-10-29T06:00:00.000Z with mcp-probe 0.1.0)
  Context   154 -> 231 (+77) tokens
  Tools     2 -> 3 (+1); added get_forecast
  Latency   tools/list p50 15 ms -> 22 ms (+7)
  New       1 error, 1 info
    error  tools.description_missing  get_forecast: No description
    info   tools.annotations_missing  get_forecast: No annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)
  Gone      2 warnings
    warn   tools.description_short  Search Docs!: Description is 12 chars: "Search docs."
    warn   tools.param_description  Search Docs!: 1 of 2 parameters without description: q
```

A finding is matched by its check id and subject (the tool, resource, prompt or scenario name), not by its message, because messages carry figures such as milliseconds that differ on every run. A finding whose message changed is therefore not reported as new. When a check fires several times for one subject, identical messages are paired first and the surplus counts as new or gone. A renamed tool shows its findings as gone under the old name and new under the new one.

With `--fail-on-new` only new findings at or above `--fail-on` lead to exit 1. This suits a server that starts with known warnings: keep its report as the baseline, and CI fails when something new appears, not because of what is already there. Without `--fail-on-new` the comparison is shown and the exit code is the usual one. Exit 2 (no connection, or a baseline that cannot be read) does not change.

```sh
npx mcp-probe https://api.example.com/mcp --json today.json --baseline yesterday.json --fail-on warn --fail-on-new
```

In the GitHub Action the same is `baseline: yesterday.json` and `fail-on-new: true`; the baseline file has to be in the workspace (committed, or restored from an artifact or cache of an earlier run).

## Context cost

Every tool definition an MCP server exposes is placed in the model's context on every turn of a conversation, before the user has asked anything. A server with 40 tools and long descriptions can take 10,000 to 20,000 tokens of that context: it costs money on each request, leaves less room for the conversation and for other servers the user has connected, and a crowded tool list makes it harder for the model to pick the right tool. The size is invisible from the server side, which is why mcp-probe reports it.

How the estimate is made:

- For each tool it serializes `{name, description, inputSchema}` as compact JSON. That is what most clients pass to the model. `title`, `outputSchema` and `annotations` are protocol metadata that clients usually keep to themselves; their size is reported separately as "chars on the wire" (the whole `tools/list` payload).
- Tokens are estimated without a tokenizer: an ASCII character counts as 1/4 token (about 4 characters per token, a common average for English text and JSON), any other character as 1/2 token (Cyrillic, CJK and accented text tokenize less efficiently).
- The server `instructions` are estimated the same way and shown next to the catalog figure, but are not counted against the budget.
- The default budget of 8,000 tokens is a judgement call: a few percent of a large context window, for one server out of several a user may connect. Set your own with `--budget`.

Limits of the heuristic:

- Real tokenizers differ between model families, and none of them is exactly 4 characters per token. The estimate is rough for English and rougher for other scripts and for JSON with many short keys, numbers or escaped characters.
- Clients wrap tools in their own format and may add a fixed preamble for tool use (often a few hundred tokens), which is not included.
- Some clients do pass `outputSchema` or `title` to the model, and some load tools lazily or let the user disable them; the estimate does not model either.

Treat the figure as a way to compare servers and versions, and to find the heaviest tools, not as an exact count.

## Library use

```ts
import { probe, formatConsole, exitCode } from 'mcp-probe';

const report = await probe('https://example.com/mcp', {
  headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
  timeoutMs: 20_000,     // per request
  tokenBudget: 8_000,
  latencyRuns: 5,
  scenarios: [{ tool: 'get_weather', arguments: { city: 'Berlin' }, expect: { isError: false } }],
  // or: scenarioFile: 'probe.yaml'
  skip: [],              // 'tools' | 'cost' | 'latency' | 'errors' | 'scenarios' | 'resources'
});

console.log(formatConsole(report, { color: false }));
for (const f of report.findings) console.log(f.severity, f.id, f.subject ?? '', f.message);
process.exitCode = exitCode(report, 'error');
```

`probe()` does not throw for server-side problems; they become findings. It throws only for a URL that is not http(s). The report object (also what `--json` writes) has `connected`, `server`, `tools`, `cost`, `latency`, `scenarios`, `resources`, `prompts`, `findings` and `summary`; see `src/types.ts`.

The parts are exported too: `McpClient` (the transport), `lintTools`, `catalogCost`, `validate` and `lintSchema` (the JSON Schema subset), `estimateTokens`, `parseSse`, `loadScenarios`, `formatMarkdown`, `formatJson` and `CHECKS` (every check id with its severity, title and hint).

To compare two reports, `compareReports(previous, current)` returns the new and gone findings and the deltas; `loadReport(file)` reads a JSON report, and `exitCodeForNew(current, comparison, failOn)` is the exit code of `--fail-on-new`. Pass the comparison to `formatConsole` or `formatMarkdown` as `{ comparison, failOnNew }` to get the section described above.

```ts
import { compareReports, loadReport, probe } from 'mcp-probe';

const previous = await loadReport('yesterday.json');
const current = await probe('https://example.com/mcp');
const { newFindings, goneFindings, tokens } = compareReports(previous, current);
console.log(`${newFindings.length} new, ${goneFindings.length} gone, tokens ${tokens.delta ?? 'n/a'}`);
```

## Development

```sh
npm install
npm run lint     # tsc --noEmit
npm test         # vitest: unit tests and a full probe against an in-process mock server
npm run build    # compiles to dist/
npm run mock     # the mock server on http://127.0.0.1:8765/mcp
```

## License

MIT, copyright 2026 Dmitrii Maslennikov. See [LICENSE](LICENSE).
