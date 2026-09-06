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
  // OpenAI's GPT-6 line: Astra and Astra Pro are the same product sold in two
  // sizes, and the batch cuts of each are the same product again.
  { test: /^openai\/gpt-6-astra/, key: "gpt-6-astra", label: "GPT-6 Astra" },
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

/**
 * How a board sums the tape: `of` names the row/band a model lands in, and
 * `memberOf` names the part it shows up as when that row is unfolded on hover.
 * The family grouping unfolds into models; a coarser one (lab, origin, class)
 * unfolds into families, so a lab's tooltip reads "Claude Opus 62% · Claude
 * Sonnet 25% …" rather than fifteen slugs.
 */
export interface Grouping {
  of: (modelId: string, name?: string) => Family;
  memberOf: (modelId: string, name?: string) => string;
}

/** The default board: product lines, unfolding into their models. */
export const FAMILY_GROUPING: Grouping = {
  of: familyOf,
  memberOf: (modelId, name) => name ?? shortLabel(modelId),
};

export interface FamilyRow<T> {
  key: string;
  label: string;
  /** True when a rule named this row — a product line, even if it holds one
   * model today. Such a row keeps its count and its split so a family of one
   * reads the same way as a family of five. */
  grouped: boolean;
  spendUsd: number;
  tokens: number;
  /** Members, biggest first — the leaderboard links to the head of this list. */
  members: T[];
  /** The row unfolded: its members summed by `memberOf`, biggest first. */
  parts: { label: string; spendUsd: number; tokens: number }[];
}

/**
 * Sum rows into groups, biggest est. spend first. Members keep their own
 * order by spend so the row can name and link its largest constituent.
 */
export function groupByFamily<T extends { modelId: string; name?: string; tokens: number | null; spendUsd: number | null }>(
  rows: T[],
  grouping: Grouping = FAMILY_GROUPING,
): FamilyRow<T>[] {
  const byKey = new Map<string, FamilyRow<T>>();
  const partsOf = new Map<string, Map<string, { label: string; spendUsd: number; tokens: number }>>();
  for (const row of rows) {
    const fam = grouping.of(row.modelId, row.name);
    const existing = byKey.get(fam.key);
    const target =
      existing ?? { key: fam.key, label: fam.label, grouped: fam.key !== row.modelId, spendUsd: 0, tokens: 0, members: [] as T[], parts: [] };
    target.spendUsd += row.spendUsd ?? 0;
    target.tokens += row.tokens ?? 0;
    target.members.push(row);
    if (!existing) byKey.set(fam.key, target);
    const partLabel = grouping.memberOf(row.modelId, row.name);
    const parts = partsOf.get(fam.key) ?? new Map();
    const part = parts.get(partLabel) ?? { label: partLabel, spendUsd: 0, tokens: 0 };
    part.spendUsd += row.spendUsd ?? 0;
    part.tokens += row.tokens ?? 0;
    parts.set(partLabel, part);
    partsOf.set(fam.key, parts);
  }
  for (const row of byKey.values()) {
    row.members.sort((a, b) => (b.spendUsd ?? 0) - (a.spendUsd ?? 0));
    row.parts = [...(partsOf.get(row.key)?.values() ?? [])].sort((a, b) => b.spendUsd - a.spendUsd);
  }
  return [...byKey.values()].sort((a, b) => b.spendUsd - a.spendUsd || b.tokens - a.tokens);
}

export interface FamilySeries {
  key: string;
  label: string;
  /** A rule-named product line (or the pooled tail) rather than a lone model. */
  grouped: boolean;
  /** One value per bucket; a bucket the family was silent in is 0, not a gap. */
  values: number[];
  /**
   * What the band is made of, biggest first over the window — the models in
   * the family, or for the pooled band the families it swallowed. Each carries
   * its own per-bucket values so a tooltip can show the split at that date.
   */
  members: { label: string; values: number[] }[];
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
  grouping: Grouping = FAMILY_GROUPING,
): { dates: string[]; series: FamilySeries[] } {
  const dates = points.map((p) => p.date);
  const valuesAt = (p: (typeof points)[number]) => (mode === "spend" ? p.spendByModel : p.tokensByModel) ?? {};
  const labels = new Map<string, string>();
  const totals = new Map<string, number>();
  const perBucket = points.map(() => new Map<string, number>());
  // Per family, the models inside it — kept so a band can explain itself.
  const membersOf = new Map<string, Map<string, number[]>>();
  const grouped = new Set<string>();

  points.forEach((p, i) => {
    for (const [modelId, raw] of Object.entries(valuesAt(p))) {
      const v = Number(raw) || 0;
      const fam = grouping.of(modelId);
      // A family's label comes from a rule, or from the one model in it; the
      // slug is the only name the race payload carries.
      labels.set(fam.key, fam.label);
      if (fam.key !== modelId) grouped.add(fam.key);
      totals.set(fam.key, (totals.get(fam.key) ?? 0) + v);
      perBucket[i]!.set(fam.key, (perBucket[i]!.get(fam.key) ?? 0) + v);
      const members = membersOf.get(fam.key) ?? new Map<string, number[]>();
      const part = grouping.memberOf(modelId);
      const row = members.get(part) ?? new Array(points.length).fill(0);
      row[i] = (row[i] ?? 0) + v;
      members.set(part, row);
      membersOf.set(fam.key, members);
    }
  });

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const named = ranked.slice(0, topN);
  const rest = ranked.slice(topN);

  const sumOf = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const byWindowTotal = (a: { values: number[] }, b: { values: number[] }) => sumOf(b.values) - sumOf(a.values);

  const series: FamilySeries[] = named.map((key) => ({
    key,
    label: shortLabel(labels.get(key) ?? key),
    grouped: grouped.has(key),
    values: perBucket.map((b) => b.get(key) ?? 0),
    // A lone model has nothing to unfold; a product line always does, even the
    // month it holds one cut — the reader still wants to know which cut.
    members: grouped.has(key)
      ? [...(membersOf.get(key) ?? new Map<string, number[]>())].map(([label, values]) => ({ label, values })).sort(byWindowTotal)
      : [],
  }));
  if (rest.length > 0) {
    series.push({
      key: "__others",
      label: `+${rest.length} more`,
      grouped: true,
      values: perBucket.map((b) => {
        let sum = 0;
        for (const key of rest) sum += b.get(key) ?? 0;
        return sum;
      }),
      // The pooled band is made of whole families, not single models.
      members: rest
        .map((key) => ({
          label: shortLabel(labels.get(key) ?? key),
          values: perBucket.map((b) => b.get(key) ?? 0),
        }))
        .sort(byWindowTotal),
    });
  }
  return { dates, series };
}

/**
 * "Claude Opus 5 62% · 4.8 24% · 4.7 14%" — a band's split at one bucket, as
 * hover lines. Shares are of the band, and a member silent that day is left
 * out rather than shown as 0%.
 */
export function breakdownAt(
  series: FamilySeries,
  index: number,
  fmt: (v: number) => string,
  maxRows = 6,
): string[] {
  const total = series.values[index] ?? 0;
  if (total <= 0 || series.members.length === 0) return [];
  const rows = series.members
    .map((m) => ({ label: m.label, value: m.values[index] ?? 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  if (rows.length === 0) return [];
  const shown = rows.slice(0, maxRows);
  const lines = shown.map((r) => `${r.label} ${fmt(r.value)} · ${((r.value / total) * 100).toFixed(0)}%`);
  const hidden = rows.length - shown.length;
  if (hidden > 0) {
    const rest = rows.slice(maxRows).reduce((a, r) => a + r.value, 0);
    lines.push(`+${hidden} more ${fmt(rest)} · ${((rest / total) * 100).toFixed(0)}%`);
  }
  return lines;
}

/** Slugs make poor legend entries: drop the author, keep the model. */
export function shortLabel(labelOrSlug: string): string {
  if (!labelOrSlug.includes("/")) return labelOrSlug;
  const [path, variant] = labelOrSlug.split(":");
  const base = (path ?? labelOrSlug).split("/").pop() ?? labelOrSlug;
  return variant ? `${base}:${variant}` : base;
}
