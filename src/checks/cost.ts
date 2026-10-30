import { countChars, estimateTokens } from '../tokens.js';
import type { CostReport, Finding, McpTool, ToolCost } from '../types.js';
import { finding } from './registry.js';

/**
 * The part of a tool definition most clients put in the model context: name, description and inputSchema.
 * (title, outputSchema and annotations are protocol metadata that clients usually keep to themselves.)
 */
export function modelView(tool: McpTool): Record<string, unknown> {
  const view: Record<string, unknown> = { name: tool.name };
  if (tool.description !== undefined) view.description = tool.description;
  if (tool.inputSchema !== undefined) view.inputSchema = tool.inputSchema;
  return view;
}

export function toolCost(tool: McpTool): ToolCost {
  const json = JSON.stringify(modelView(tool));
  return { name: tool.name, chars: countChars(json), tokens: estimateTokens(json) };
}

export function catalogCost(tools: McpTool[], budget: number, instructions?: string): CostReport {
  const perTool = tools.map(toolCost);
  const heaviest = [...perTool].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  return {
    chars: perTool.reduce((s, t) => s + t.chars, 0),
    tokens: perTool.reduce((s, t) => s + t.tokens, 0),
    wireChars: countChars(JSON.stringify({ tools })),
    budget,
    instructionsTokens: instructions ? estimateTokens(instructions) : 0,
    heaviest,
    perTool,
  };
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export function costFindings(cost: CostReport, toolCount: number): Finding[] {
  const out: Finding[] = [];
  const share = cost.budget > 0 ? Math.round((cost.tokens / cost.budget) * 100) : 0;
  out.push(finding('cost.summary', `${toolCount} tools take ~${fmt(cost.tokens)} tokens (${fmt(cost.chars)} chars as name + description + inputSchema; ${fmt(cost.wireChars)} chars on the wire), ${share}% of the ${fmt(cost.budget)}-token budget${cost.instructionsTokens ? `; instructions add ~${fmt(cost.instructionsTokens)}` : ''}`));
  if (cost.tokens > cost.budget) {
    out.push(finding('cost.over_budget', `~${fmt(cost.tokens)} tokens is over the ${fmt(cost.budget)}-token budget by ~${fmt(cost.tokens - cost.budget)}`));
  }
  if (cost.heaviest.length > 1) {
    out.push(finding('cost.heaviest', cost.heaviest.map((t) => `${t.name} ~${fmt(t.tokens)}`).join(', ')));
  }
  return out;
}
