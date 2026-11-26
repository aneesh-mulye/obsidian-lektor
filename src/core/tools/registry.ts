// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from 'zod';
import type { ToolCall, ToolDefinition } from '../providers/types';
import type { ToolBudget } from './budget';
import { type StepResult, type Tool, type ToolContext, ToolError } from './types';

const fail = (content: string, summary: string, extra: Partial<StepResult> = {}): StepResult => ({ ok: false, content, summary, ...extra });

/** All tools Lektor knows; each chat enables a subset (DESIGN.md § Tools framework). */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool<unknown>>();

  register<A>(tool: Tool<A>): void {
    if (this.#tools.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered.`);
    this.#tools.set(tool.name, tool);
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  /** The named tools in the native tool-calling format (JSON Schema arguments). */
  definitions(names: Iterable<string>): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const name of names) {
      const tool = this.#tools.get(name);
      if (!tool) continue;
      const { $schema: _s, ...parameters } = z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>;
      out.push({ name, description: tool.description, parameters });
    }
    return out;
  }

  /**
   * Run one call: only if the tool is enabled, its arguments pass its schema,
   * approval (if any) is given and its cap allows (INVARIANTS.md T1, T2).
   * Never throws for anything the model did; failures become tool errors.
   */
  async execute(call: ToolCall, enabled: ReadonlySet<string>, budget: ToolBudget, ctx: ToolContext): Promise<StepResult> {
    const tool = enabled.has(call.name) ? this.#tools.get(call.name) : undefined;
    if (!tool) return fail(`There is no tool called "${call.name}". Use only the tools you were given.`, `Unknown tool ${call.name}`);

    let args = call.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as unknown;
      } catch {
        // left as a string; the schema will reject it
      }
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
      return fail(`Invalid arguments for ${tool.name}: ${issues}`, `${tool.name}: invalid arguments`);
    }

    if (tool.approval !== 'never') {
      const ok = await ctx.approve({ tool: tool.name, title: `Allow ${tool.name}?`, detail: JSON.stringify(parsed.data) });
      if (!ok) return fail(`The user declined this ${tool.name} call.`, `${tool.name}: declined`);
    }

    if (tool.cap && !budget.take(tool.cap)) {
      return fail(
        `Limit reached: no more ${tool.cap === 'searches' ? 'searches' : 'page fetches'} are allowed for this message. Answer with what you have.`,
        `${tool.name}: limit reached`,
        { limit: true },
      );
    }

    try {
      const out = await tool.run(parsed.data, ctx);
      return {
        ok: true,
        content: out.content,
        summary: out.summary,
        ...(out.urls ? { urls: out.urls } : {}),
        ...(out.proposal ? { proposal: out.proposal, proposalId: out.proposal.id } : {}),
        ...(out.transient ? { transient: out.transient } : {}),
        ...(out.shared ? { shared: out.shared } : {}),
      };
    } catch (err) {
      if (ctx.signal.aborted) return fail('Stopped by the user.', `${tool.name}: stopped`);
      const message = err instanceof ToolError ? err.message : `${tool.name} failed: ${err instanceof Error ? err.message : 'unknown error'}`;
      return fail(message, `${tool.name}: ${err instanceof ToolError ? err.message : 'failed'}`);
    }
  }
}
