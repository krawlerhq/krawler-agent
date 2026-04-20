// Agent driver: wraps streamText and converts its async iterator +
// tool-hook callbacks into events the Ink <App/> can feed into React
// state. Keeps all the streaming/tool plumbing out of the component
// tree so the UI layer only knows about "got a token", "tool
// started", "tool ended", "turn done".

import { stepCountIs, streamText } from 'ai';

import type { Provider } from '../../config.js';
import { buildModel } from '../../model.js';
import type { KrawlerClient } from '../../krawler.js';
import { buildChatTools } from '../tools.js';
import { buildSettingsTools } from '../settings-tools.js';
import { buildMemoryTools } from '../memory-tools.js';
import type { ToolRenderHooks } from '../tools.js';

export interface DriverDeps {
  krawler: KrawlerClient;
  provider: Provider;
  modelName: string;
  apiKey: string;
  ollamaBaseUrl?: string;
  settingsUrl: string | null;
  profileName: string;
  system: string;
}

export interface RunTurnHandlers {
  onText: (chunk: string) => void;
  onToolStart: (name: string, thought: string) => string; // returns toolId
  onToolEnd: (toolId: string, outcome: string, ok: boolean) => void;
  onError: (err: Error) => void;
  onDone: (fullText: string) => void;
}

export async function runTurn(
  deps: DriverDeps,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  handlers: RunTurnHandlers,
): Promise<void> {
  let pendingToolId: string | null = null;
  const hooks: ToolRenderHooks = {
    onToolStart: (name, thought) => {
      pendingToolId = handlers.onToolStart(name, thought);
    },
    onToolEnd: (_name, outcome, ok) => {
      if (pendingToolId) {
        handlers.onToolEnd(pendingToolId, outcome, ok);
        pendingToolId = null;
      }
    },
  };
  const baseTools = buildChatTools(deps.krawler, hooks);
  // settingsUrl is always null in 0.6+ (local dashboard removed), kept
  // in DriverDeps for shape compatibility with the old caller surface.
  // buildSettingsTools no longer needs the URL — it reads/writes config
  // directly (plus PATCHes server when paired).
  const settingsTools = buildSettingsTools(deps.settingsUrl, deps.profileName, hooks);
  const memoryTools = buildMemoryTools(hooks);
  const tools = { ...baseTools, ...settingsTools, ...memoryTools };

  let fullText = '';
  try {
    const result = streamText({
      model: buildModel({
        provider: deps.provider,
        model: deps.modelName,
        apiKey: deps.apiKey,
        ollamaBaseUrl: deps.ollamaBaseUrl,
      }),
      system: deps.system,
      messages,
      tools,
      // AI SDK v5: maxSteps replaced by stopWhen(stepCountIs). 4 steps is
      // generous for a single user turn; most use 1-2.
      stopWhen: stepCountIs(4),
    });
    for await (const chunk of result.textStream) {
      fullText += chunk;
      handlers.onText(chunk);
    }
    handlers.onDone(fullText);
  } catch (e) {
    handlers.onError(e as Error);
    handlers.onDone(fullText);
  }
}
