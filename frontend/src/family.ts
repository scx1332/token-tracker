/**
 * Model families for the revenue leaderboard.
 *
 * The board asks "who moves the tokens", and a lab that ships a point release
 * every six weeks answers it three times: Opus 5, Opus 4.8 and Opus 4.7 are the
 * same product line being paid for by the same customers, and splitting them
 * flatters whichever lab happens to have consolidated on one slug. So a curated
 * set of rules folds versions and re-releases of one line into one row.
 *
 * Curated, not inferred: "gpt-5.6-sol" and "gpt-5.6-luna" are genuinely
 * different models sold side by side, while "deepseek-v4-flash" and
 * "deepseek-v4-flash-0731" are one model re-cut. No regex over slugs can tell
 * those apart, so anything not named here stands alone.
 */
export interface Family {
  /** Stable key the grouping sums under. */
  key: string;
  /** Row label. */
  label: string;
}

const RULES: { test: RegExp; key: string; label: string }[] = [
  // Anthropic: one row per product line, every version inside it.
  { test: /^anthropic\/claude-opus/, key: "claude-opus", label: "Claude Opus" },
  { test: /^anthropic\/claude-sonnet/, key: "claude-sonnet", label: "Claude Sonnet" },
  { test: /^anthropic\/claude-fable/, key: "claude-fable", label: "Claude Fable" },
  { test: /^anthropic\/claude-haiku/, key: "claude-haiku", label: "Claude Haiku" },
  // Z.ai: every Flash cut is one product line (this rule runs first, so the
  // GLM 5 rule below never claims one); the chat models of the current
  // generation, 5.2 + 5.3, are the other.
  { test: /^z-ai\/glm-.*flash/, key: "glm-flash", label: "GLM Flash" },
  { test: /^z-ai\/glm-5\.[23]/, key: "glm-5.2-5.3", label: "GLM 5.2 + 5.3" },
  // DeepSeek ships dated re-cuts of the same model — "-0731", "-0813".
  { test: /^deepseek\/deepseek-v4-flash/, key: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { test: /^deepseek\/deepseek-v4-pro/, key: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  // Qwen 3.8 Max and its refresh.
  { test: /^qwen\/qwen3\.8-max/, key: "qwen3.8-max", label: "Qwen3.8 Max" },
  // Every Google Flash tier — Flash and Flash Lite, all generations.
  { test: /^google\/gemini-.*flash/, key: "gemini-flash", label: "Gemini Flash" },
];

/** The family a model slug is counted under — itself, when no rule matches. */
export function familyOf(modelId: string, name?: string): Family {
  const id = modelId.toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(id)) return { key: rule.key, label: rule.label };
  }
  return { key: modelId, label: name ?? modelId };
}

/** True when the slug is folded into a multi-model family. */
export function isGrouped(modelId: string): boolean {
  return familyOf(modelId).key !== modelId;
}

export interface FamilyRow<T> {
  key: string;
  label: string;
  spendUsd: number;
  tokens: number;
  /** Members, biggest first — the leaderboard links to the head of this list. */
  members: T[];
}

/**
 * Sum rows into families, biggest est. spend first. Members keep their own
 * order by spend so the row can name and link its largest constituent.
 */
export function groupByFamily<T extends { modelId: string; name?: string; tokens: number | null; spendUsd: number | null }>(
  rows: T[],
): FamilyRow<T>[] {
  const byKey = new Map<string, FamilyRow<T>>();
  for (const row of rows) {
    const fam = familyOf(row.modelId, row.name);
    const existing = byKey.get(fam.key);
    const target =
      existing ?? { key: fam.key, label: fam.label, spendUsd: 0, tokens: 0, members: [] as T[] };
    target.spendUsd += row.spendUsd ?? 0;
    target.tokens += row.tokens ?? 0;
    target.members.push(row);
    if (!existing) byKey.set(fam.key, target);
  }
  for (const row of byKey.values()) {
    row.members.sort((a, b) => (b.spendUsd ?? 0) - (a.spendUsd ?? 0));
  }
  return [...byKey.values()].sort((a, b) => b.spendUsd - a.spendUsd || b.tokens - a.tokens);
}

/**
 * Fold a race series (per-model totals per bucket) into per-family series:
 * the top `topN` families by window total, plus everything else summed into
 * one "Others" band so each stack adds up to the whole tracked book.
 */
export function familySeries(
  points: { date: string; spendByModel: Record<string, number>; tokensByModel: Record<string, number> }[],
  mode: "spend" | "tokens",
  topN = 8,
): { dates: string[]; series: { key: string; label: string; values: number[] }[] } {
  const dates = points.map((p) => p.date);
  const valuesAt = (p: (typeof points)[number]) => (mode === "spend" ? p.spendByModel : p.tokensByModel) ?? {};
  const labels = new Map<string, string>();
  const totals = new Map<string, number>();
  const perBucket = points.map(() => new Map<string, number>());

  points.forEach((p, i) => {
    for (const [modelId, raw] of Object.entries(valuesAt(p))) {
      const v = Number(raw) || 0;
      const fam = familyOf(modelId);
      // A family's label comes from a rule, or from the one model in it; the
      // slug is the only name the race payload carries.
      labels.set(fam.key, fam.label);
      totals.set(fam.key, (totals.get(fam.key) ?? 0) + v);
      perBucket[i]!.set(fam.key, (perBucket[i]!.get(fam.key) ?? 0) + v);
    }
  });

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const named = ranked.slice(0, topN);
  const rest = new Set(ranked.slice(topN));

  const series = named.map((key) => ({
    key,
    label: shortLabel(labels.get(key) ?? key),
    values: perBucket.map((b) => b.get(key) ?? 0),
  }));
  if (rest.size > 0) {
    series.push({
      key: "__others",
      label: `+${rest.size} more`,
      values: perBucket.map((b) => {
        let sum = 0;
        for (const key of rest) sum += b.get(key) ?? 0;
        return sum;
      }),
    });
  }
  return { dates, series };
}

/** Slugs make poor legend entries: drop the author, keep the model. */
function shortLabel(labelOrSlug: string): string {
  if (!labelOrSlug.includes("/")) return labelOrSlug;
  const [path, variant] = labelOrSlug.split(":");
  const base = (path ?? labelOrSlug).split("/").pop() ?? labelOrSlug;
  return variant ? `${base}:${variant}` : base;
}
