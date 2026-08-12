// Shared domain types for the OpenRouter token/price tracker.

/** Raw pricing block as returned by OpenRouter (all values are USD, as strings). */
export interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
  image_output?: string;
  audio?: string;
  audio_output?: string;
  web_search?: string;
  internal_reasoning?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  input_cache_write_1h?: string;
  input_audio_cache?: string;
  [key: string]: string | undefined;
}

export interface OpenRouterModel {
  id: string;
  canonical_slug?: string;
  hugging_face_id?: string | null;
  name: string;
  created?: number;
  description?: string;
  context_length?: number | null;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    instruct_type?: string | null;
  };
  pricing?: OpenRouterPricing;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
  knowledge_cutoff?: string | null;
  per_request_limits?: unknown;
}

/** A single provider endpoint that serves a model (from /models/:author/:slug/endpoints). */
export interface OpenRouterEndpoint {
  name?: string;
  provider_name?: string;
  tag?: string;
  context_length?: number | null;
  pricing?: OpenRouterPricing;
  quantization?: string | null;
  max_completion_tokens?: number | null;
  supported_parameters?: string[];
  status?: number | string | null;
  uptime_last_30m?: number | null;
}

/** Normalized pricing in USD-per-token (or per-unit) floats, ready for storage. */
export interface NormalizedPricing {
  promptUsd: number | null;
  completionUsd: number | null;
  requestUsd: number | null;
  imageUsd: number | null;
  webSearchUsd: number | null;
  internalReasoningUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
}

/** One usage/volume data point for a model over a time bucket. */
export interface UsagePoint {
  modelId: string;
  variantSlug?: string | null;
  bucketDate: string; // YYYY-MM-DD (UTC)
  tokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  requests: number | null;
}
