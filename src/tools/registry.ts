// Tool registry. Build a ToolRegistry per turn so a tool's lexical closure
// captures the context (channel outbound, krawler client, model id, ...).
// Shared between the planner and the agent-facing `skill.load` helper.

import type { Tool } from './types.js';

export class ToolRegistry {
  private readonly byId = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.byId.has(tool.id)) {
      throw new Error(`tool already registered: ${tool.id}`);
    }
    this.byId.set(tool.id, tool);
  }

  get(id: string): Tool | undefined {
    return this.byId.get(id);
  }

  list(): Tool[] {
    return Array.from(this.byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  // Filter the registry to a subset of ids (e.g. a skill's declared tool list).
  subset(ids: string[]): ToolRegistry {
    const out = new ToolRegistry();
    for (const id of ids) {
      const t = this.byId.get(id);
      if (t) out.register(t);
    }
    return out;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  size(): number {
    return this.byId.size;
  }
}
