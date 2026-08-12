import { modelAuthor, modelVariant } from "./openrouter";
import type { ModelUpsert } from "./storage";
import type { OpenRouterModel } from "./types";

/** Convert a raw OpenRouter model into a storage upsert row. */
export function toModelUpsert(
  model: OpenRouterModel & { canonical_slug?: string; links?: { details?: string } },
  extras: { permaslug?: string | null; promotionText?: string | null } = {},
): ModelUpsert {
  const arch = model.architecture ?? {};
  const created = typeof model.created === "number" && model.created > 0
    ? new Date(model.created * 1000).toISOString()
    : null;
  return {
    modelId: model.id,
    canonicalSlug: model.canonical_slug ?? null,
    permaslug: extras.permaslug ?? model.canonical_slug ?? null,
    promotionText: extras.promotionText ?? null,
    name: model.name ?? model.id,
    author: modelAuthor(model.id),
    variant: modelVariant(model.id),
    description: model.description ?? null,
    contextLength: numOrNull(model.context_length),
    modality: arch.modality ?? null,
    inputModalities: arch.input_modalities ?? null,
    outputModalities: arch.output_modalities ?? null,
    tokenizer: arch.tokenizer ?? null,
    huggingFaceId: model.hugging_face_id ?? null,
    supportedParameters: model.supported_parameters ?? null,
    isModerated: model.top_provider?.is_moderated ?? null,
    createdOr: created,
    knowledgeCutoff: model.knowledge_cutoff ?? null,
    endpointsPath: model.links?.details ?? null,
    raw: model,
  };
}

/**
 * Index for attributing usage records (keyed by permaslug + variant) back to a
 * catalog model id. Non-alias ids (no leading "~") win over alias entries.
 */
export interface UsageIndex {
  byVariant: Map<string, string>; // `${permaslug}|${variant}` -> modelId
  byBase: Map<string, string>; // permaslug -> base (standard) modelId
}

export function buildUsageIndex(models: { id: string; canonical_slug?: string | null }[]): UsageIndex {
  const byVariant = new Map<string, string>();
  const byBase = new Map<string, string>();
  for (const model of models) {
    const permaslug = model.canonical_slug ?? null;
    if (!permaslug) continue;
    const variant = modelVariant(model.id) ?? "standard";
    setPreferReal(byVariant, `${permaslug}|${variant}`, model.id);
    if (variant === "standard") setPreferReal(byBase, permaslug, model.id);
  }
  return { byVariant, byBase };
}

function setPreferReal(map: Map<string, string>, key: string, id: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, id);
    return;
  }
  // Prefer a non-alias id if the stored one is an alias.
  if (existing.startsWith("~") && !id.startsWith("~")) map.set(key, id);
}

/** Resolve (permaslug, variant) to a catalog model id, falling back to the base model. */
export function resolveUsageModelId(index: UsageIndex, permaslug: string, variant: string): string | null {
  return index.byVariant.get(`${permaslug}|${variant}`) ?? index.byBase.get(permaslug) ?? null;
}

function numOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
