// Mirrors the backend curated frontier families (src/frontier.ts) so the table
// can badge the models the product foregrounds.
const FRONTIER_PATTERNS = [
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
