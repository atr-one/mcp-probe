# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 0.2.0 - 2026-10-30

- GitHub Action: `action.yml` at the repository root, used as `uses: atr-one/mcp-probe@v0.2.0`. Inputs `url`, `headers` (one `Name: value` per line), `scenario`, `fail-on`, `baseline`, `fail-on-new`, `json`, `md`; output `exit-code`. It builds mcp-probe from the tagged source and appends the Markdown report to the job summary. CI runs the action against the mock server.
- `--baseline <file>` compares the run with an earlier JSON report: new and gone findings (matched by check id and subject), and the deltas of estimated context tokens, tool count and `tools/list` p50. Shown in the console and Markdown reports.
- `--fail-on-new`: with `--baseline`, only new findings at or above `--fail-on` lead to exit 1.
- Library: `compareReports(previous, current)`, `loadReport(file)`, `exitCodeForNew(...)` and `resultCode(...)`; `formatConsole` and `formatMarkdown` take `{ comparison, failOnNew }`.
- JSON report schema: `schema/report.schema.json` (JSON Schema 2020-12) describes the report with `schemaVersion: 1`, is shipped in the package as `mcp-probe/schema/report.schema.json`, and is checked by a test against a real report from the mock server.

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
