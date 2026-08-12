// Curated "frontier" model families to always surface, regardless of the day's
// usage ranking. Matched as case-insensitive substrings of the model id so they
// survive version/date suffixes and variants. The user specifically called out
// DeepSeek Flash, GLM 5.2 and GPT-5.6 Luna; the rest are the obvious frontier
// text families. The dashboard also features models dynamically by token volume,
// so this list only guarantees presence — it is not the whole story.

export const FRONTIER_PATTERNS: string[] = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-chat",
  "z-ai/glm-5.2",
  "z-ai/glm-5",
  "z-ai/glm-4.7",
  "openai/gpt-5.6-luna",
  "openai/gpt-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "google/gemini-3",
  "qwen/qwen3",
  "moonshotai/kimi",
  "x-ai/grok",
  "meta/",
  "mistralai/",
];

export function isFrontier(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return FRONTIER_PATTERNS.some((p) => id.includes(p));
}
