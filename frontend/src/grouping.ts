/**
 * The ways the Best-models board can sum the tape. Each grouping names the
 * row a model lands in and the part it unfolds into on hover:
 *
 *   family — product lines (Claude Opus, Gemini Flash …), unfolding into models
 *   lab    — who trained it, unfolding into product lines
 *   origin — where the lab is, unfolding into product lines
 *   class  — the capability tier it sells in, unfolding into product lines
 *
 * Lab, origin and class are keyed off the author segment or a curated slug
 * rule; family.ts owns the product-line rules. Everything here is a lookup
 * table, so an unknown author or slug gets an honest bucket ("Other labs",
 * "Rest of world") rather than a guess.
 */
import { familyOf, type Family, type Grouping } from "./family";

export type GroupingKey = "family" | "lab" | "origin" | "class";

export interface BoardGrouping extends Grouping {
  key: GroupingKey;
  label: string;
  /** What the rows are, for the panel note. */
  rows: string;
  /** What a row unfolds into on hover. */
  parts: string;
}

// ---------------------------------------------------------------------------
// Lab — the author segment, with the few aliases OpenRouter carries.

const LAB_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "x-ai": "xAI",
  xai: "xAI",
  meta: "Meta",
  "meta-llama": "Meta",
  microsoft: "Microsoft",
  amazon: "Amazon",
  nvidia: "NVIDIA",
  perplexity: "Perplexity",
  mistralai: "Mistral",
  cohere: "Cohere",
  "z-ai": "Z.ai",
  zhipu: "Z.ai",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  moonshotai: "Moonshot",
  tencent: "Tencent",
  minimax: "MiniMax",
  xiaomi: "Xiaomi",
  stepfun: "StepFun",
  baidu: "Baidu",
  bytedance: "ByteDance",
  "bytedance-seed": "ByteDance",
  upstage: "Upstage",
  "thinkingmachines": "Thinking Machines",
  "nousresearch": "Nous",
  inception: "Inception",
  "ai21": "AI21",
  "aion-labs": "Aion",
};

export function labOf(modelId: string): Family {
  const author = (modelId.split("/")[0] ?? "").toLowerCase();
  const label = LAB_LABELS[author];
  if (label) return { key: `lab:${label}`, label };
  // An author outside the table still gets its own row — titled from the slug
  // so a new lab shows up under its name rather than vanishing into "Other".
  return author ? { key: `lab:${author}`, label: author } : { key: "lab:?", label: "Unknown lab" };
}

// ---------------------------------------------------------------------------
// Origin — where the lab is headquartered.

const ORIGIN_OF_AUTHOR: Record<string, string> = {
  // USA
  anthropic: "USA",
  openai: "USA",
  google: "USA",
  "x-ai": "USA",
  xai: "USA",
  meta: "USA",
  "meta-llama": "USA",
  microsoft: "USA",
  amazon: "USA",
  nvidia: "USA",
  perplexity: "USA",
  inception: "USA",
  nousresearch: "USA",
  thinkingmachines: "USA",
  morph: "USA",
  relace: "USA",
  poolside: "USA",
  writer: "USA",
  "arcee-ai": "USA",
  "ibm-granite": "USA",
  perceptron: "USA",
  rekaai: "USA",
  "aion-labs": "USA",
  cognitivecomputations: "USA",
  "anthracite-org": "USA",
  // China
  "z-ai": "China",
  zhipu: "China",
  deepseek: "China",
  qwen: "China",
  moonshotai: "China",
  tencent: "China",
  minimax: "China",
  xiaomi: "China",
  stepfun: "China",
  baidu: "China",
  bytedance: "China",
  "bytedance-seed": "China",
  inclusionai: "China",
  kwaipilot: "China",
  meituan: "China",
  "nex-agi": "China",
  // Elsewhere
  mistralai: "Europe",
  cohere: "Rest of world",
  ai21: "Rest of world",
  upstage: "Rest of world",
  sakana: "Rest of world",
};

export function originOf(modelId: string): Family {
  const author = (modelId.split("/")[0] ?? "").toLowerCase();
  const label = ORIGIN_OF_AUTHOR[author] ?? "Rest of world";
  return { key: `origin:${label}`, label };
}

// ---------------------------------------------------------------------------
// Class — the capability tier a model sells in, named after the GPT-5.6 tiers
// people already use as shorthand. Curated for the lines that carry the tape;
// anything else is read off its slug (mini/flash/lite → Luna, pro/max → Sol,
// the rest → Terra), which is a rough placement, not a benchmark.

export const CLASS_ORDER = ["Top", "Sol", "Terra", "Luna"] as const;
export type ModelClass = (typeof CLASS_ORDER)[number];
export const CLASS_LABELS: Record<ModelClass, string> = {
  Top: "Top · Fable class",
  Sol: "High · Sol class",
  Terra: "Medium · Terra class",
  Luna: "Small · Luna class",
};

const CLASS_RULES: { test: RegExp; cls: ModelClass }[] = [
  // Anthropic
  { test: /^anthropic\/claude-fable/, cls: "Top" },
  { test: /^anthropic\/claude-opus/, cls: "Sol" },
  { test: /^anthropic\/claude-sonnet/, cls: "Terra" },
  { test: /^anthropic\/claude-haiku/, cls: "Luna" },
  // OpenAI — the tiers are named after these.
  { test: /^openai\/gpt-5\.5-pro/, cls: "Top" },
  { test: /^openai\/gpt-[\d.]+-sol/, cls: "Sol" },
  { test: /^openai\/gpt-[\d.]+-terra/, cls: "Terra" },
  { test: /^openai\/gpt-[\d.]+-luna/, cls: "Luna" },
  { test: /^openai\/gpt-[\w.]*-(mini|nano)/, cls: "Luna" },
  { test: /^openai\/gpt-oss/, cls: "Luna" },
  { test: /^openai\/gpt-(4|5)/, cls: "Sol" },
  // Google
  { test: /^google\/gemini-.*flash-lite/, cls: "Luna" },
  { test: /^google\/gemini-.*flash/, cls: "Terra" },
  { test: /^google\/gemini-.*pro/, cls: "Sol" },
  { test: /^google\/gemma/, cls: "Luna" },
  // xAI
  { test: /^x-ai\/grok-4\.[56]/, cls: "Sol" },
  { test: /^x-ai\/grok/, cls: "Terra" },
  // Chinese labs
  { test: /^z-ai\/glm-.*flash/, cls: "Luna" },
  { test: /^z-ai\/glm/, cls: "Terra" },
  { test: /^deepseek\/deepseek-v4-flash/, cls: "Luna" },
  { test: /^deepseek\/deepseek-v4-pro/, cls: "Sol" },
  { test: /^deepseek\//, cls: "Terra" },
  { test: /^moonshotai\/kimi-k3/, cls: "Sol" },
  { test: /^moonshotai\//, cls: "Terra" },
  { test: /^qwen\/qwen[\d.]+-(max|2\.4t)/, cls: "Sol" },
  { test: /^qwen\/qwen[\d.]+-flash/, cls: "Luna" },
  { test: /^qwen\//, cls: "Terra" },
  { test: /^tencent\/hy4/, cls: "Terra" },
  { test: /^tencent\//, cls: "Luna" },
  { test: /^minimax\//, cls: "Terra" },
  { test: /^xiaomi\/mimo-.*-pro/, cls: "Terra" },
  { test: /^xiaomi\//, cls: "Luna" },
  { test: /^stepfun\/.*flash/, cls: "Luna" },
  // Others
  { test: /^meta\/muse-spark-.*contributor/, cls: "Luna" },
  { test: /^meta\/muse-spark/, cls: "Terra" },
  { test: /^nvidia\/.*ultra/, cls: "Sol" },
  { test: /^nvidia\/.*lightning/, cls: "Luna" },
  { test: /^perplexity\/sonar-pro/, cls: "Sol" },
  { test: /^upstage\//, cls: "Luna" },
];

export function classOf(modelId: string): ModelClass {
  const id = modelId.toLowerCase();
  for (const rule of CLASS_RULES) if (rule.test.test(id)) return rule.cls;
  // Slug heuristics for the long tail.
  const slug = id.split("/").pop() ?? id;
  if (/(mini|nano|lite|flash|small|tiny|-\d{1,2}b\b)/.test(slug)) return "Luna";
  if (/(pro|max|ultra|large|opus)/.test(slug)) return "Sol";
  return "Terra";
}

export function classGroupOf(modelId: string): Family {
  const cls = classOf(modelId);
  return { key: `class:${cls}`, label: CLASS_LABELS[cls] };
}

// ---------------------------------------------------------------------------

/** Coarser groupings unfold into product lines, never into raw slugs. */
const familyPart = (modelId: string, name?: string) => {
  const fam = familyOf(modelId, name);
  return fam.key === modelId ? (name ?? fam.label) : fam.label;
};

export const GROUPINGS: BoardGrouping[] = [
  {
    key: "family",
    label: "Product line",
    rows: "product lines — versions and re-cuts of one model summed",
    parts: "models",
    of: familyOf,
    memberOf: (modelId, name) => name ?? (modelId.split("/").pop() ?? modelId),
  },
  {
    key: "lab",
    label: "Lab",
    rows: "labs — who trained the model",
    parts: "product lines",
    of: labOf,
    memberOf: familyPart,
  },
  {
    key: "origin",
    label: "Origin",
    rows: "where the lab is headquartered",
    parts: "product lines",
    of: originOf,
    memberOf: familyPart,
  },
  {
    key: "class",
    label: "Class",
    rows: "capability tiers, named after the GPT-5.6 line — curated for the head of the tape, the tail read off its slug",
    parts: "product lines",
    of: classGroupOf,
    memberOf: familyPart,
  },
];

export function groupingByKey(key: string | undefined): BoardGrouping {
  return GROUPINGS.find((g) => g.key === key) ?? GROUPINGS[0]!;
}
