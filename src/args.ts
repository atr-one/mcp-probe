import type { FailOn } from './report.js';
import { CHECK_GROUPS, type CheckGroup } from './types.js';

export interface CliArgs {
  url?: string;
  headers: Record<string, string>;
  scenario?: string;
  json?: string;
  md?: string;
  baseline?: string;
  failOnNew: boolean;
  failOn: FailOn;
  timeoutMs: number;
  budget: number;
  runs: number;
  skip: CheckGroup[];
  color?: boolean;
  help: boolean;
  version: boolean;
  listChecks: boolean;
}

export const USAGE = `Usage: mcp-probe <url> [options]

Audit a remote MCP server over Streamable HTTP and report what to fix.

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
      --skip <groups>         comma-separated: ${CHECK_GROUPS.join(', ')}
      --no-color              plain output (also when NO_COLOR is set or stdout is not a TTY)
      --color                 force colors
      --list-checks           print every check id with its severity and exit
  -h, --help                  show this help
  -v, --version               show the version

Exit codes: 0 ok, 1 findings at or above --fail-on, 2 connection failure or bad arguments.`;

export class UsageError extends Error {}

/** "20", "20s", "1500ms", "1m" -> milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
  if (!m) throw new UsageError(`--timeout: cannot read "${text}" (use seconds, or 1500ms / 30s / 1m)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : n * 60_000;
  if (ms <= 0) throw new UsageError('--timeout must be positive');
  return Math.round(ms);
}

export function parseHeader(text: string): [string, string] {
  const i = text.indexOf(':');
  if (i <= 0) throw new UsageError(`--header: expected "Name: value", got "${text}"`);
  const name = text.slice(0, i).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new UsageError(`--header: "${name}" is not a valid header name`);
  return [name, text.slice(i + 1).trim()];
}

function positiveInt(flag: string, text: string, min: number): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`${flag}: expected an integer >= ${min}, got "${text}"`);
  return n;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { headers: {}, failOnNew: false, failOn: 'error', timeoutMs: 20_000, budget: 8_000, runs: 5, skip: [], help: false, version: false, listChecks: false };
  const rest = [...argv];
  const value = (flag: string, inline: string | undefined): string => {
    if (inline !== undefined) return inline;
    const v = rest.shift();
    if (v === undefined) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  while (rest.length > 0) {
    const raw = rest.shift()!;
    if (raw === '--') {
      for (const r of rest.splice(0)) {
        if (args.url) throw new UsageError(`unexpected argument "${r}"`);
        args.url = r;
      }
      break;
    }
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    switch (flag) {
      case '-H':
      case '--header': {
        const [k, v] = parseHeader(value(flag, inline));
        args.headers[k] = v;
        break;
      }
      case '-s':
      case '--scenario': args.scenario = value(flag, inline); break;
      case '--json': args.json = value(flag, inline); break;
      case '--md': args.md = value(flag, inline); break;
      case '--baseline': args.baseline = value(flag, inline); break;
      case '--fail-on-new': args.failOnNew = true; break;
      case '--fail-on': {
        const v = value(flag, inline);
        if (!['error', 'warn', 'info', 'never'].includes(v)) throw new UsageError(`--fail-on: expected error, warn, info or never, got "${v}"`);
        args.failOn = v as FailOn;
        break;
      }
      case '--timeout': args.timeoutMs = parseDuration(value(flag, inline)); break;
      case '--budget': args.budget = positiveInt(flag, value(flag, inline), 1); break;
      case '--runs': args.runs = positiveInt(flag, value(flag, inline), 0); break;
      case '--skip': {
        for (const g of value(flag, inline).split(',').map((x) => x.trim()).filter(Boolean)) {
          if (!(CHECK_GROUPS as readonly string[]).includes(g)) throw new UsageError(`--skip: unknown group "${g}" (known: ${CHECK_GROUPS.join(', ')})`);
          args.skip.push(g as CheckGroup);
        }
        break;
      }
      case '--color': args.color = true; break;
      case '--no-color': args.color = false; break;
      case '--list-checks': args.listChecks = true; break;
      case '-h':
      case '--help': args.help = true; break;
      case '-v':
      case '--version': args.version = true; break;
      default:
        if (raw.startsWith('-')) throw new UsageError(`unknown option "${raw}"`);
        if (args.url) throw new UsageError(`unexpected argument "${raw}" (the URL is already "${args.url}")`);
        args.url = raw;
    }
  }
  if (args.failOnNew && !args.baseline) throw new UsageError('--fail-on-new needs --baseline <file>');
  return args;
}
