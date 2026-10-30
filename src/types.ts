export type Severity = 'error' | 'warn' | 'info';

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

export interface Finding {
  /** Stable check id, e.g. "tools.name_invalid". */
  id: string;
  severity: Severity;
  message: string;
  /** How to fix it. */
  hint: string;
  /** What the finding is about: a tool, resource, prompt or scenario name. */
  subject?: string;
}

/** Check groups that can be turned off with `skip`. The handshake always runs. */
export type CheckGroup = 'tools' | 'cost' | 'latency' | 'errors' | 'scenarios' | 'resources';

export const CHECK_GROUPS: readonly CheckGroup[] = ['tools', 'cost', 'latency', 'errors', 'scenarios', 'resources'];

export interface ScenarioExpect {
  /** Expect the result to be (true) or not to be (false) an error. Not checked when absent. */
  isError?: boolean;
  /** A substring that must appear in the text content (or the serialized structuredContent). */
  contains?: string;
  /** Upper bound for the call in milliseconds. */
  maxMs?: number;
  /**
   * Validate structuredContent against the tool's outputSchema. Defaults to true when the tool has an
   * outputSchema and the result is not an error; false turns the validation off.
   */
  schemaValid?: boolean;
}

export interface Scenario {
  name?: string;
  tool: string;
  arguments?: Record<string, unknown>;
  expect?: ScenarioExpect;
}

export interface ProbeOptions {
  /** Extra HTTP headers sent with every request, e.g. { Authorization: 'Bearer x' }. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default 20000. */
  timeoutMs?: number;
  /** Context budget for the tool catalog in estimated tokens. Default 8000. */
  tokenBudget?: number;
  /** How many times tools/list is repeated for the latency figures. Default 5. */
  latencyRuns?: number;
  /** p95 above this (ms) for a protocol method is reported as latency.slow. Default 2000. */
  slowMs?: number;
  /** Scenarios to run (tools/call with expectations). */
  scenarios?: Scenario[];
  /** A YAML or JSON scenario file; read when `scenarios` is not given. */
  scenarioFile?: string;
  /** Check groups to skip. */
  skip?: CheckGroup[];
  /** A fetch implementation; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Called with a short label before each step. */
  onProgress?: (step: string) => void;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolCost {
  name: string;
  chars: number;
  tokens: number;
}

export interface CostReport {
  /** Characters of the model-visible catalog (name, description, inputSchema of every tool). */
  chars: number;
  /** Estimated tokens of the same. */
  tokens: number;
  /** Characters of the full tools/list payload as sent (outputSchema, annotations and all). */
  wireChars: number;
  budget: number;
  instructionsTokens: number;
  heaviest: ToolCost[];
  perTool: ToolCost[];
}

export interface LatencyStat {
  method: string;
  count: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export interface ScenarioResult {
  name: string;
  tool: string;
  passed: boolean;
  ms?: number;
  isError?: boolean;
  failures: string[];
}

export interface ServerSummary {
  name?: string;
  title?: string;
  version?: string;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  instructionsChars?: number;
  sessionId: boolean;
  transport?: 'json' | 'sse';
}

export interface Report {
  schemaVersion: 1;
  probe: { name: 'mcp-probe'; version: string };
  url: string;
  startedAt: string;
  durationMs: number;
  /** False when no HTTP answer could be had at all (DNS, TLS, refused, timeout). */
  connected: boolean;
  server?: ServerSummary;
  tools: { count: number; names: string[] };
  cost?: CostReport;
  latency: LatencyStat[];
  scenarios: ScenarioResult[];
  resources?: number;
  prompts?: number;
  findings: Finding[];
  summary: { error: number; warn: number; info: number };
}
