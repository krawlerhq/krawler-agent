// Model builder for the v1.0 tool-loop path. Reads the active provider from
// config and returns an AI-SDK LanguageModel handle. Kept separate from the
// legacy heartbeat's buildModel (src/model.ts) so they can diverge: the
// heartbeat uses generateObject for structured JSON, the planner uses
// generateText with tools.

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

import type { Config, Provider } from '../config.js';
import { getActiveCredentials } from '../config.js';

// Ollama is routed through @ai-sdk/openai with the daemon's built-in
// OpenAI-compatible endpoint at `<base>/v1/chat/completions` (Ollama
// 0.1.14+). Keeps us off ollama-ai-provider-v2, which pins zod@^4 while
// the rest of the AI SDK is on zod@^3. The stub API key is ignored by
// Ollama but @ai-sdk/openai requires a non-empty string.
function ollamaLanguageModel(baseUrl: string | undefined, model: string): LanguageModel {
  const base = (baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  return createOpenAI({ apiKey: 'ollama', baseURL: `${base}/v1` })(model);
}

export function buildLanguageModel(config: Config): LanguageModel {
  const creds = getActiveCredentials(config);
  switch (config.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: creds.apiKey })(config.model);
    case 'openai':
      return createOpenAI({ apiKey: creds.apiKey })(config.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: creds.apiKey })(config.model);
    case 'openrouter':
      return createOpenRouter({ apiKey: creds.apiKey }).chat(config.model);
    case 'ollama':
      return ollamaLanguageModel(creds.baseUrl, config.model);
  }
}

// Fact-extractor default mapping: "one tier down" per design.md §10 #3. If
// the user overrides factExtractor.model in config, use that verbatim.
export function buildFactExtractorModel(config: Config): {
  provider: Provider;
  model: string;
  languageModel: LanguageModel;
} {
  const provider: Provider = config.factExtractor.provider ?? config.provider;
  const model = config.factExtractor.model || defaultExtractorModel(config.provider, config.model);
  const creds = getActiveCredentials({ ...config, provider });
  let languageModel: LanguageModel;
  switch (provider) {
    case 'anthropic':
      languageModel = createAnthropic({ apiKey: creds.apiKey })(model);
      break;
    case 'openai':
      languageModel = createOpenAI({ apiKey: creds.apiKey })(model);
      break;
    case 'google':
      languageModel = createGoogleGenerativeAI({ apiKey: creds.apiKey })(model);
      break;
    case 'openrouter':
      languageModel = createOpenRouter({ apiKey: creds.apiKey }).chat(model);
      break;
    case 'ollama':
      languageModel = ollamaLanguageModel(creds.baseUrl, model);
      break;
  }
  return { provider, model, languageModel };
}

function defaultExtractorModel(provider: Provider, mainModel: string): string {
  switch (provider) {
    case 'anthropic':
      if (mainModel.includes('opus')) return 'claude-haiku-4-5-20251001';
      if (mainModel.includes('sonnet')) return 'claude-haiku-4-5-20251001';
      return mainModel;
    case 'openai':
      if (mainModel.includes('gpt-4o') && !mainModel.includes('mini')) return 'gpt-4o-mini';
      return mainModel;
    case 'google':
      if (mainModel.includes('pro')) return 'gemini-2.5-flash';
      return mainModel;
    case 'openrouter':
      return mainModel; // OpenRouter users pick their own routing
    case 'ollama':
      return mainModel; // Local is free; no tier-down benefit
  }
}
