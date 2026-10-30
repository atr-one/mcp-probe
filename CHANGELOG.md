# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 0.1.0 - 2026-10-30

First release.

- Streamable HTTP client: JSON-RPC 2.0 over POST, `application/json` and `text/event-stream` answers (chunked SSE parsing, response picked by id), `Mcp-Session-Id` and `MCP-Protocol-Version` handling, per-request timeout, session `DELETE` at the end.
- Handshake checks: HTTP status (401 with OAuth protected resource discovery, 403, 405), content type, negotiated protocol version, `serverInfo`, capabilities, instructions, session id, `notifications/initialized`, `ping`.
- Tool catalog lint over all `tools/list` pages: names, uniqueness, description length, duplicate and near-duplicate descriptions, `inputSchema` soundness, `required` against `properties`, parameter descriptions, `outputSchema`, annotations.
- Context cost estimate of the tool catalog with a configurable budget and the five heaviest tools.
- Latency per method with p50/p95; `tools/list` repeated `--runs` times.
- Error contract: unknown tool, missing required arguments, unknown method.
- Scenarios from YAML or JSON: `isError`, `contains`, `maxMs`, `structuredContent` validated against `outputSchema` (a built-in JSON Schema subset).
- Resources and prompts listing and lint when advertised.
- Console report (colors on a TTY), JSON and Markdown reports, exit codes 0/1/2 with `--fail-on`.
- Library API: `probe(url, options)` and the building blocks.
