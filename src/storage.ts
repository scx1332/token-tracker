import pg from "pg";
import type { NormalizedPricing } from "./types";

const { Pool, types } = pg;

// Keep BIGINT (oid 20) as a string so we never lose precision; NUMERIC (1700)
// is already returned as a string by node-postgres.
types.setTypeParser(20, (value: string) => value);
// Return DATE (oid 1082) as the raw "YYYY-MM-DD" string. The default parser
// builds a local-midnight Date, which shifts the day under a non-UTC server
// timezone when re-serialized — corrupting usage bucket dates.
types.setTypeParser(1082, (value: string) => value);

export const MAX_ROWS = 50_000;

export interface StorageOptions {
  schema?: string;
}

export interface ModelUpsert {
  modelId: string;
  canonicalSlug: string | null;
  permaslug: string | null;
  promotionText: string | null;
  name: string;
  author: string;
  variant: string | null;
  description: string | null;
  contextLength: number | null;
  modality: string | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  tokenizer: string | null;
  huggingFaceId: string | null;
  supportedParameters: string[] | null;
  isModerated: boolean | null;
  createdOr: string | null; // ISO timestamp
  knowledgeCutoff: string | null;
  endpointsPath: string | null;
  raw: unknown;
}

export interface PricePointInsert {
  modelId: string;
  provider: string; // "" = model-level/default pricing
  pricing: NormalizedPricing;
  contextLength: number | null;
  quantization: string | null;
  isFree: boolean;
  raw?: unknown;
  observedAt?: Date;
}

export interface UsageUpsert {
  modelId: string;
  provider: string; // "" = model-level
  bucketDate: string; // YYYY-MM-DD
  tokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  requests: number | null;
  estimatedSpendUsd: number | null;
  /** Native reasoning tokens (subset of completion), when the feed reports them. */
  reasoningTokens?: number | null;
  source: string;
}

export interface MarketSnapshotInsert {
  capturedAt: Date;
  totalModels: number;
  activeModels: number;
  freeModels: number;
  totalDailyTokens: number | null;
  totalEstimatedDailySpendUsd: number | null;
  avgPromptUsdPerMtok: number | null;
  medianPromptUsdPerMtok: number | null;
  usageWeightedPromptUsdPerMtok: number | null;
  cheapestFrontierUsdPerMtok: number | null;
  raw?: unknown;
}

export interface LatestPriceState {
  pricing: NormalizedPricing;
  contextLength: number | null;
  quantization: string | null;
}

export interface StoredModel {
  modelId: string;
  canonicalSlug: string | null;
  permaslug: string | null;
  promotionText: string | null;
  name: string;
  author: string;
  variant: string | null;
  description: string | null;
  contextLength: number | null;
  modality: string | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  tokenizer: string | null;
  huggingFaceId: string | null;
  supportedParameters: string[] | null;
  isModerated: boolean | null;
  createdOr: string | null;
  knowledgeCutoff: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  isActive: boolean;
}

export interface ModelWithLatest extends StoredModel {
  promptUsd: number | null;
  completionUsd: number | null;
  requestUsd: number | null;
  imageUsd: number | null;
  isFree: boolean;
  priceObservedAt: string | null;
  latestTokens: number | null;
  latestSpendUsd: number | null;
  latestUsageDate: string | null;
  providerCount: number;
}

export interface PriceHistoryRow {
  provider: string;
  observedAt: string;
  promptUsd: number | null;
  completionUsd: number | null;
  requestUsd: number | null;
  imageUsd: number | null;
  webSearchUsd: number | null;
  internalReasoningUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
  contextLength: number | null;
  quantization: string | null;
  isFree: boolean;
}

export interface UsageRow {
  modelId: string;
  provider: string;
  bucketDate: string;
  tokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  requests: number | null;
  estimatedSpendUsd: number | null;
  reasoningTokens: number | null;
}

export interface MarketRow {
  capturedAt: string;
  totalModels: number;
  activeModels: number;
  freeModels: number;
  totalDailyTokens: number | null;
  totalEstimatedDailySpendUsd: number | null;
  avgPromptUsdPerMtok: number | null;
  medianPromptUsdPerMtok: number | null;
  usageWeightedPromptUsdPerMtok: number | null;
  cheapestFrontierUsdPerMtok: number | null;
}

/** One UTC-day aggregate of a GPU's hourly band snapshots (server-side). */
export interface GpuDailyRow {
  gpuName: string;
  /** YYYY-MM-DD, UTC. */
  date: string;
  /** Best price reachable at any point in the day. */
  minUsd: number | null;
  /** Median of the sweeps' medians — the day's typical price. */
  medianUsd: number | null;
  p25Usd: number | null;
  p75Usd: number | null;
  /** Peak depth observed that day. */
  gpusAvailable: number;
  /** Number of sweeps that contributed. */
  samples: number;
}

/** One price-band snapshot of a GPU's vast.ai offer book (fenced/practical). */
export interface GpuPriceRow {
  gpuName: string;
  capturedAt: string;
  offers: number;
  gpusAvailable: number;
  /** Priced listings the fence excluded as junk (deverified + outliers). */
  excludedOffers: number;
  minUsd: number | null;
  p25Usd: number | null;
  medianUsd: number | null;
  p75Usd: number | null;
  maxUsd: number | null;
  meanUsd: number | null;
  supplyWeightedUsd: number | null;
  minBidUsd: number | null;
  verifiedOffers: number;
  verifiedGpusAvailable: number;
  verifiedMinUsd: number | null;
  verifiedMedianUsd: number | null;
}

/**
 * A band ready to store. Structurally identical to `GpuPriceSnapshot` in
 * `gpu.ts` (which is where it is built) minus the capture timestamp, which the
 * writer supplies once for the whole batch so a pass shares one instant.
 */
export type GpuPriceSnapshotInsert = Omit<GpuPriceRow, "capturedAt">;

export interface IngestRunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  modelsSeen: number | null;
  priceChanges: number | null;
  usageRows: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface DatabaseTableStats {
  tableName: string;
  rowCount: string;
  totalSizeBytes: string;
}

export class Storage {
  private readonly schema: string;

  private constructor(private readonly pool: pg.Pool, options: StorageOptions = {}) {
    this.schema = options.schema ?? "public";
  }

  static async open(connectionString: string, options: StorageOptions = {}): Promise<Storage> {
    const pool = new Pool({ connectionString, max: 10 });
    const storage = new Storage(pool, options);
    await storage.initSchema();
    return storage;
  }

  static async fromPool(pool: pg.Pool, options: StorageOptions = {}): Promise<Storage> {
    const storage = new Storage(pool, options);
    await storage.initSchema();
    return storage;
  }

  private t(name: string): string {
    return `${quoteIdent(this.schema)}.${quoteIdent(name)}`;
  }

  private schemaLockKey(): number {
    // Stable 31-bit hash of the schema name for a Postgres advisory lock.
    let h = 5381;
    const s = `tt-schema:${this.schema}`;
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) & 0x7fffffff;
    return h;
  }

  // Serialize schema creation across processes. `ingest` and `backend` boot at
  // the same time and both run CREATE TABLE IF NOT EXISTS; two racing creates can
  // trip a duplicate pg_type entry (pg_type_typname_nsp_index). An advisory lock
  // keyed by schema gates entry so only one process builds the schema at a time.
  async initSchema(): Promise<void> {
    const lockClient = await this.pool.connect();
    try {
      await lockClient.query("SELECT pg_advisory_lock($1)", [this.schemaLockKey()]);
      await this.createSchemaObjects();
    } finally {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [this.schemaLockKey()]);
      } catch {
        // ignore
      }
      lockClient.release();
    }
  }

  private async createSchemaObjects(): Promise<void> {
    if (this.schema !== "public") {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.schema)}`);
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.t("models")} (
        model_id TEXT PRIMARY KEY,
        canonical_slug TEXT,
        permaslug TEXT,
        promotion_text TEXT,
        name TEXT NOT NULL,
        author TEXT NOT NULL,
        variant TEXT,
        description TEXT,
        context_length BIGINT,
        modality TEXT,
        input_modalities JSONB,
        output_modalities JSONB,
        tokenizer TEXT,
        hugging_face_id TEXT,
        supported_parameters JSONB,
        is_moderated BOOLEAN,
        created_or TIMESTAMPTZ,
        knowledge_cutoff TEXT,
        endpoints_path TEXT,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        raw JSONB
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdent("models_author_idx")} ON ${this.t("models")} (author)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdent("models_active_idx")} ON ${this.t("models")} (is_active)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdent("models_permaslug_idx")} ON ${this.t("models")} (permaslug)`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.t("price_points")} (
        id BIGSERIAL PRIMARY KEY,
        model_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        prompt_usd NUMERIC,
        completion_usd NUMERIC,
        request_usd NUMERIC,
        image_usd NUMERIC,
        web_search_usd NUMERIC,
        internal_reasoning_usd NUMERIC,
        cache_read_usd NUMERIC,
        cache_write_usd NUMERIC,
        context_length BIGINT,
        quantization TEXT,
        is_free BOOLEAN NOT NULL DEFAULT FALSE,
        raw JSONB
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("price_points_lookup_idx")}
       ON ${this.t("price_points")} (model_id, provider, observed_at DESC)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("price_points_observed_idx")}
       ON ${this.t("price_points")} (observed_at DESC)`,
    );

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.t("usage_snapshots")} (
        model_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        bucket_date DATE NOT NULL,
        tokens NUMERIC,
        prompt_tokens NUMERIC,
        completion_tokens NUMERIC,
        requests NUMERIC,
        estimated_spend_usd NUMERIC,
        source TEXT,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (model_id, provider, bucket_date)
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("usage_bucket_idx")}
       ON ${this.t("usage_snapshots")} (bucket_date)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("usage_model_idx")}
       ON ${this.t("usage_snapshots")} (model_id, bucket_date)`,
    );

    // Reasoning tokens arrived after launch — patch existing installs in place.
    await this.pool.query(
      `ALTER TABLE ${this.t("usage_snapshots")} ADD COLUMN IF NOT EXISTS reasoning_tokens NUMERIC`,
    );

    // Usage-weighted effective prices ($/Mtok) per model ('' provider row) and
    // per provider — captures discounts and the real traffic mix, not list price.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.t("effective_price_snapshots")} (
        id BIGSERIAL PRIMARY KEY,
        model_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        eff_input_usd_per_mtok DOUBLE PRECISION,
        eff_output_usd_per_mtok DOUBLE PRECISION,
        total_tokens NUMERIC
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("effective_price_model_idx")}
       ON ${this.t("effective_price_snapshots")} (model_id, captured_at DESC)`,
    );

    // Per-provider request volume (trailing ~30-min window) captured hourly —
    // OpenRouter publishes only the live value, so history exists only here.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.t("provider_volume_snapshots")} (
        id BIGSERIAL PRIMARY KEY,
        model_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        window_minutes INTEGER,
        request_count NUMERIC,
        p50_throughput DOUBLE PRECISION,
        p50_latency DOUBLE PRECISION
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("provider_volume_model_idx")}
       ON ${this.t("provider_volume_snapshots")} (model_id, captured_at DESC)`,
    );

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.t("market_snapshots")} (
        captured_at TIMESTAMPTZ PRIMARY KEY,
        total_models INTEGER NOT NULL,
        active_models INTEGER NOT NULL,
        free_models INTEGER NOT NULL,
        total_daily_tokens NUMERIC,
        total_estimated_daily_spend_usd NUMERIC,
        avg_prompt_usd_per_mtok NUMERIC,
        median_prompt_usd_per_mtok NUMERIC,
        usage_weighted_prompt_usd_per_mtok NUMERIC,
        cheapest_frontier_usd_per_mtok NUMERIC,
        raw JSONB
      )
    `);

    // vast.ai GPU rental price bands. Unlike price_points this is NOT a
    // change-log: the offer book is a continuous auction whose percentiles move
    // every hour, so there is no "unchanged" state worth collapsing. One row per
    // (gpu, hour) keeps the series dense and directly plottable.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.t("gpu_price_snapshots")} (
        gpu_name TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL,
        offers INTEGER NOT NULL DEFAULT 0,
        gpus_available INTEGER NOT NULL DEFAULT 0,
        min_usd NUMERIC,
        p25_usd NUMERIC,
        median_usd NUMERIC,
        p75_usd NUMERIC,
        max_usd NUMERIC,
        mean_usd NUMERIC,
        supply_weighted_usd NUMERIC,
        min_bid_usd NUMERIC,
        verified_offers INTEGER NOT NULL DEFAULT 0,
        verified_gpus_available INTEGER NOT NULL DEFAULT 0,
        verified_min_usd NUMERIC,
        verified_median_usd NUMERIC,
        source TEXT NOT NULL DEFAULT 'bundles',
        PRIMARY KEY (gpu_name, captured_at)
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("gpu_price_captured_idx")}
       ON ${this.t("gpu_price_snapshots")} (captured_at DESC)`,
    );
    // Migration for tables created before the outlier fence existed. Rows from
    // then default to 0 ("nothing known to be excluded"), which is honest.
    await this.pool.query(
      `ALTER TABLE ${this.t("gpu_price_snapshots")}
       ADD COLUMN IF NOT EXISTS excluded_offers INTEGER NOT NULL DEFAULT 0`,
    );

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.t("ingest_runs")} (
        id BIGSERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'running',
        models_seen INTEGER,
        price_changes INTEGER,
        usage_rows INTEGER,
        duration_ms INTEGER,
        error TEXT,
        notes JSONB
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.t("kv_state")} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------

  async upsertModel(model: ModelUpsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("models")} (
        model_id, canonical_slug, permaslug, promotion_text, name, author, variant, description, context_length,
        modality, input_modalities, output_modalities, tokenizer, hugging_face_id,
        supported_parameters, is_moderated, created_or, knowledge_cutoff, endpoints_path,
        last_seen_at, is_active, raw
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),TRUE,$20
      )
      ON CONFLICT (model_id) DO UPDATE SET
        canonical_slug = EXCLUDED.canonical_slug,
        permaslug = EXCLUDED.permaslug,
        promotion_text = EXCLUDED.promotion_text,
        name = EXCLUDED.name,
        author = EXCLUDED.author,
        variant = EXCLUDED.variant,
        description = EXCLUDED.description,
        context_length = EXCLUDED.context_length,
        modality = EXCLUDED.modality,
        input_modalities = EXCLUDED.input_modalities,
        output_modalities = EXCLUDED.output_modalities,
        tokenizer = EXCLUDED.tokenizer,
        hugging_face_id = EXCLUDED.hugging_face_id,
        supported_parameters = EXCLUDED.supported_parameters,
        is_moderated = EXCLUDED.is_moderated,
        created_or = EXCLUDED.created_or,
        knowledge_cutoff = EXCLUDED.knowledge_cutoff,
        endpoints_path = EXCLUDED.endpoints_path,
        last_seen_at = NOW(),
        is_active = TRUE,
        raw = EXCLUDED.raw`,
      [
        model.modelId,
        model.canonicalSlug,
        model.permaslug,
        model.promotionText,
        model.name,
        model.author,
        model.variant,
        model.description,
        model.contextLength,
        model.modality,
        jsonbOrNull(model.inputModalities),
        jsonbOrNull(model.outputModalities),
        model.tokenizer,
        model.huggingFaceId,
        jsonbOrNull(model.supportedParameters),
        model.isModerated,
        model.createdOr,
        model.knowledgeCutoff,
        model.endpointsPath,
        jsonbOrNull(model.raw),
      ],
    );
  }

  /** Mark any model not in `seenIds` as inactive (delisted). Returns count deactivated. */
  async deactivateMissingModels(seenIds: string[]): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${this.t("models")} SET is_active = FALSE
       WHERE is_active = TRUE AND NOT (model_id = ANY($1::text[]))`,
      [seenIds],
    );
    return result.rowCount ?? 0;
  }

  async countModels(): Promise<{ total: number; active: number }> {
    const result = await this.pool.query<{ total: string; active: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE is_active)::text AS active
       FROM ${this.t("models")}`,
    );
    const row = result.rows[0];
    return { total: Number(row?.total ?? 0), active: Number(row?.active ?? 0) };
  }

  async getModelsWithLatest(filter: { activeOnly?: boolean; author?: string; search?: string; modelId?: string; limit?: number } = {}): Promise<ModelWithLatest[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.activeOnly) clauses.push("m.is_active = TRUE");
    if (filter.modelId) {
      params.push(filter.modelId);
      clauses.push(`m.model_id = $${params.length}`);
    }
    if (filter.author) {
      params.push(filter.author);
      clauses.push(`m.author = $${params.length}`);
    }
    if (filter.search) {
      params.push(`%${filter.search.toLowerCase()}%`);
      clauses.push(`(LOWER(m.model_id) LIKE $${params.length} OR LOWER(m.name) LIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(resolveLimit(filter.limit));

    const sql = `
      SELECT m.model_id, m.canonical_slug, m.permaslug, m.promotion_text, m.name, m.author, m.variant, m.description,
             m.context_length, m.modality, m.input_modalities, m.output_modalities,
             m.tokenizer, m.hugging_face_id, m.supported_parameters, m.is_moderated,
             m.created_or, m.knowledge_cutoff, m.first_seen_at, m.last_seen_at, m.is_active,
             p.prompt_usd, p.completion_usd, p.request_usd, p.image_usd, p.is_free, p.observed_at AS price_observed_at,
             u.tokens AS latest_tokens, u.estimated_spend_usd AS latest_spend, u.bucket_date AS latest_usage_date,
             COALESCE(pc.provider_count, 0) AS provider_count
      FROM ${this.t("models")} m
      LEFT JOIN LATERAL (
        SELECT prompt_usd, completion_usd, request_usd, image_usd, is_free, observed_at
        FROM ${this.t("price_points")} pp
        WHERE pp.model_id = m.model_id AND pp.provider = ''
        ORDER BY observed_at DESC LIMIT 1
      ) p ON TRUE
      LEFT JOIN LATERAL (
        SELECT tokens, estimated_spend_usd, bucket_date
        FROM ${this.t("usage_snapshots")} us
        WHERE us.model_id = m.model_id AND us.provider = ''
        ORDER BY bucket_date DESC LIMIT 1
      ) u ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT provider) AS provider_count
        FROM ${this.t("price_points")} pp2
        WHERE pp2.model_id = m.model_id AND pp2.provider <> ''
      ) pc ON TRUE
      ${where}
      ORDER BY COALESCE(u.estimated_spend_usd, 0) DESC, COALESCE(u.tokens, 0) DESC NULLS LAST, m.name ASC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapModelWithLatest);
  }

  async getModel(modelId: string): Promise<StoredModel | null> {
    const result = await this.pool.query(
      `SELECT model_id, canonical_slug, permaslug, promotion_text, name, author, variant, description, context_length,
              modality, input_modalities, output_modalities, tokenizer, hugging_face_id,
              supported_parameters, is_moderated, created_or, knowledge_cutoff,
              first_seen_at, last_seen_at, is_active
       FROM ${this.t("models")} WHERE model_id = $1`,
      [modelId],
    );
    const row = result.rows[0];
    return row ? mapStoredModel(row) : null;
  }

  // -------------------------------------------------------------------------
  // Prices
  // -------------------------------------------------------------------------

  /** Latest price state for every (model_id, provider) pair, keyed for change detection. */
  async getLatestPrices(): Promise<Map<string, LatestPriceState>> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (model_id, provider)
              model_id, provider, prompt_usd, completion_usd, request_usd, image_usd,
              web_search_usd, internal_reasoning_usd, cache_read_usd, cache_write_usd,
              context_length, quantization
       FROM ${this.t("price_points")}
       ORDER BY model_id, provider, observed_at DESC`,
    );
    const map = new Map<string, LatestPriceState>();
    for (const row of result.rows) {
      map.set(priceStateKey(row.model_id, row.provider), {
        pricing: {
          promptUsd: num(row.prompt_usd),
          completionUsd: num(row.completion_usd),
          requestUsd: num(row.request_usd),
          imageUsd: num(row.image_usd),
          webSearchUsd: num(row.web_search_usd),
          internalReasoningUsd: num(row.internal_reasoning_usd),
          cacheReadUsd: num(row.cache_read_usd),
          cacheWriteUsd: num(row.cache_write_usd),
        },
        contextLength: num(row.context_length),
        quantization: row.quantization ?? null,
      });
    }
    return map;
  }

  /** Append one sweep's effective-price rows: '' = usage-weighted across providers. */
  async insertEffectivePriceSnapshots(
    modelId: string,
    rows: { provider: string; effInputPerMtok: number | null; effOutputPerMtok: number | null; totalTokens: number | null }[],
    capturedAt?: Date,
  ): Promise<void> {
    if (rows.length === 0) return;
    const at = capturedAt ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows) {
        await client.query(
          `INSERT INTO ${this.t("effective_price_snapshots")}
             (model_id, provider, captured_at, eff_input_usd_per_mtok, eff_output_usd_per_mtok, total_tokens)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [modelId, r.provider, at, r.effInputPerMtok, r.effOutputPerMtok, r.totalTokens],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Latest usage-weighted effective rate per model ($/token), from the daily sweep. */
  async getLatestEffectiveRates(): Promise<Map<string, { inputPerTok: number; outputPerTok: number }>> {
    const res = await this.pool.query(
      `SELECT DISTINCT ON (model_id) model_id, eff_input_usd_per_mtok, eff_output_usd_per_mtok
       FROM ${this.t("effective_price_snapshots")}
       WHERE provider = ''
       ORDER BY model_id, captured_at DESC`,
    );
    const map = new Map<string, { inputPerTok: number; outputPerTok: number }>();
    for (const row of res.rows) {
      const inp = num(row.eff_input_usd_per_mtok);
      const outp = num(row.eff_output_usd_per_mtok);
      if (inp === null || outp === null || inp <= 0) continue;
      map.set(row.model_id, { inputPerTok: inp / 1_000_000, outputPerTok: outp / 1_000_000 });
    }
    return map;
  }

  /**
   * Re-price a model's model-level usage history at effective $/token rates
   * (real paid rates embed cache discounts; list prices overstate spend on
   * cache-heavy models). Rows without a prompt/completion split blend 90/10.
   */
  /** Observed prompt-token share for a model (from rows with a known split), or null. */
  async getObservedPromptShare(modelId: string): Promise<number | null> {
    const mix = await this.pool.query(
      `SELECT SUM(prompt_tokens)::float8 / NULLIF(SUM(prompt_tokens + completion_tokens), 0)::float8 AS share
       FROM ${this.t("usage_snapshots")}
       WHERE model_id = $1 AND provider = '' AND prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL`,
      [modelId],
    );
    const share = num(mix.rows[0]?.share);
    return share !== null && share > 0 && share <= 1 ? share : null;
  }

  async repriceUsageSpend(modelId: string, inputPerTok: number, outputPerTok: number): Promise<number> {
    // Split-less rows blend at the model's own observed prompt share (falling
    // back to the market-typical 0.9) — a flat 90/10 overweights output for
    // agentic models whose real mix is ~98/2.
    const promptShare = (await this.getObservedPromptShare(modelId)) ?? 0.9;
    const res = await this.pool.query(
      `UPDATE ${this.t("usage_snapshots")}
       SET estimated_spend_usd = CASE
         WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL
           THEN prompt_tokens * $2 + completion_tokens * $3
         WHEN tokens IS NOT NULL
           THEN tokens * ($2 * $4 + $3 * (1 - $4))
         ELSE estimated_spend_usd
       END
       WHERE model_id = $1 AND provider = ''`,
      [modelId, inputPerTok, outputPerTok, promptShare],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Estimated daily revenue per provider: each provider's daily tokens (from
   * provider-token-chart) priced at its own effective rates. Head of the
   * market only — the sweep covers the top ~40 models.
   */
  async getProviderRevenueSeries(filter: { since?: string } = {}): Promise<
    { provider: string; bucketDate: string; spendUsd: number | null; tokens: number | null; models: number }[]
  > {
    const params: unknown[] = [];
    let where = "provider <> ''";
    if (filter.since) {
      params.push(filter.since);
      where += ` AND bucket_date >= $${params.length}`;
    }
    const res = await this.pool.query(
      `SELECT provider, bucket_date, SUM(estimated_spend_usd) AS spend, SUM(tokens) AS tokens,
              COUNT(DISTINCT model_id) AS models
       FROM ${this.t("usage_snapshots")}
       WHERE ${where}
       GROUP BY provider, bucket_date
       ORDER BY bucket_date ASC, provider ASC`,
      params,
    );
    return res.rows.map((row) => ({
      provider: row.provider,
      bucketDate: toDateString(row.bucket_date),
      spendUsd: num(row.spend),
      tokens: num(row.tokens),
      models: Number(row.models ?? 0),
    }));
  }

  /** Per-provider per-model totals over a window — which models a provider lives off. */
  async getProviderModelTotals(filter: { since?: string } = {}): Promise<
    { provider: string; modelId: string; name: string; spendUsd: number | null; tokens: number | null }[]
  > {
    const params: unknown[] = [];
    let where = "us.provider <> ''";
    if (filter.since) {
      params.push(filter.since);
      where += ` AND us.bucket_date >= $${params.length}`;
    }
    const res = await this.pool.query(
      `SELECT us.provider, us.model_id, COALESCE(m.name, us.model_id) AS name,
              SUM(us.estimated_spend_usd) AS spend, SUM(us.tokens) AS tokens
       FROM ${this.t("usage_snapshots")} us
       LEFT JOIN ${this.t("models")} m ON m.model_id = us.model_id
       WHERE ${where}
       GROUP BY 1, 2, 3
       ORDER BY SUM(us.estimated_spend_usd) DESC NULLS LAST`,
      params,
    );
    return res.rows.map((row) => ({
      provider: row.provider,
      modelId: row.model_id,
      name: row.name,
      spendUsd: num(row.spend),
      tokens: num(row.tokens),
    }));
  }

  /** Effective-price history for one model, oldest → newest. */
  async getEffectivePriceHistory(
    modelId: string,
    opts: { since?: string } = {},
  ): Promise<{ provider: string; capturedAt: string; effInputPerMtok: number | null; effOutputPerMtok: number | null; totalTokens: number | null }[]> {
    const params: unknown[] = [modelId];
    let where = `model_id = $1`;
    if (opts.since) {
      params.push(opts.since);
      where += ` AND captured_at >= $2`;
    }
    const res = await this.pool.query(
      `SELECT provider, captured_at, eff_input_usd_per_mtok, eff_output_usd_per_mtok, total_tokens
       FROM ${this.t("effective_price_snapshots")}
       WHERE ${where}
       ORDER BY captured_at ASC, provider ASC`,
      params,
    );
    return res.rows.map((row) => ({
      provider: row.provider,
      capturedAt: toIso(row.captured_at) ?? "",
      effInputPerMtok: num(row.eff_input_usd_per_mtok),
      effOutputPerMtok: num(row.eff_output_usd_per_mtok),
      totalTokens: num(row.total_tokens),
    }));
  }

  /** Append one sweep's per-provider volume rows for a model (history is append-only). */
  async insertProviderVolumeSnapshots(
    modelId: string,
    rows: { provider: string; requestCount: number; windowMinutes: number | null; p50Throughput: number | null; p50Latency: number | null }[],
    capturedAt?: Date,
  ): Promise<void> {
    if (rows.length === 0) return;
    const at = capturedAt ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows) {
        await client.query(
          `INSERT INTO ${this.t("provider_volume_snapshots")}
             (model_id, provider, captured_at, window_minutes, request_count, p50_throughput, p50_latency)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [modelId, r.provider, at, r.windowMinutes, r.requestCount, r.p50Throughput, r.p50Latency],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Per-provider volume history for one model, oldest → newest. */
  async getProviderVolumeHistory(
    modelId: string,
    opts: { since?: string } = {},
  ): Promise<{ provider: string; capturedAt: string; requestCount: number | null; windowMinutes: number | null; p50Throughput: number | null; p50Latency: number | null }[]> {
    const params: unknown[] = [modelId];
    let where = `model_id = $1`;
    if (opts.since) {
      params.push(opts.since);
      where += ` AND captured_at >= $2`;
    }
    const res = await this.pool.query(
      `SELECT provider, captured_at, window_minutes, request_count, p50_throughput, p50_latency
       FROM ${this.t("provider_volume_snapshots")}
       WHERE ${where}
       ORDER BY captured_at ASC, provider ASC`,
      params,
    );
    return res.rows.map((row) => ({
      provider: row.provider,
      capturedAt: toIso(row.captured_at) ?? "",
      windowMinutes: row.window_minutes === null ? null : Number(row.window_minutes),
      requestCount: num(row.request_count),
      p50Throughput: num(row.p50_throughput),
      p50Latency: num(row.p50_latency),
    }));
  }

  async insertPricePoint(point: PricePointInsert): Promise<void> {
    const p = point.pricing;
    await this.pool.query(
      `INSERT INTO ${this.t("price_points")} (
        model_id, provider, observed_at, prompt_usd, completion_usd, request_usd, image_usd,
        web_search_usd, internal_reasoning_usd, cache_read_usd, cache_write_usd,
        context_length, quantization, is_free, raw
      ) VALUES ($1,$2,COALESCE($3, NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        point.modelId,
        point.provider,
        point.observedAt ?? null,
        p.promptUsd,
        p.completionUsd,
        p.requestUsd,
        p.imageUsd,
        p.webSearchUsd,
        p.internalReasoningUsd,
        p.cacheReadUsd,
        p.cacheWriteUsd,
        point.contextLength,
        point.quantization,
        point.isFree,
        jsonbOrNull(point.raw),
      ],
    );
  }

  async insertPricePoints(points: PricePointInsert[]): Promise<void> {
    if (points.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const point of points) {
        const p = point.pricing;
        await client.query(
          `INSERT INTO ${this.t("price_points")} (
            model_id, provider, observed_at, prompt_usd, completion_usd, request_usd, image_usd,
            web_search_usd, internal_reasoning_usd, cache_read_usd, cache_write_usd,
            context_length, quantization, is_free, raw
          ) VALUES ($1,$2,COALESCE($3, NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            point.modelId,
            point.provider,
            point.observedAt ?? null,
            p.promptUsd,
            p.completionUsd,
            p.requestUsd,
            p.imageUsd,
            p.webSearchUsd,
            p.internalReasoningUsd,
            p.cacheReadUsd,
            p.cacheWriteUsd,
            point.contextLength,
            point.quantization,
            point.isFree,
            jsonbOrNull(point.raw),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getPriceHistory(
    modelId: string,
    filter: { provider?: string; since?: string; limit?: number } = {},
  ): Promise<PriceHistoryRow[]> {
    const clauses = ["model_id = $1"];
    const params: unknown[] = [modelId];
    if (filter.provider !== undefined) {
      params.push(filter.provider);
      clauses.push(`provider = $${params.length}`);
    }
    if (filter.since) {
      params.push(filter.since);
      clauses.push(`observed_at >= $${params.length}`);
    }
    params.push(resolveLimit(filter.limit));
    const result = await this.pool.query(
      `SELECT provider, observed_at, prompt_usd, completion_usd, request_usd, image_usd,
              web_search_usd, internal_reasoning_usd, cache_read_usd, cache_write_usd,
              context_length, quantization, is_free
       FROM ${this.t("price_points")}
       WHERE ${clauses.join(" AND ")}
       ORDER BY observed_at ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapPriceHistory);
  }

  /** Latest price per provider for a model (for the providers table on a model page). */
  async getLatestProviderPrices(modelId: string): Promise<PriceHistoryRow[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (provider) provider, observed_at, prompt_usd, completion_usd,
              request_usd, image_usd, web_search_usd, internal_reasoning_usd,
              cache_read_usd, cache_write_usd, context_length, quantization, is_free
       FROM ${this.t("price_points")}
       WHERE model_id = $1 AND provider <> ''
       ORDER BY provider, observed_at DESC`,
      [modelId],
    );
    return result.rows.map(mapPriceHistory);
  }

  /**
   * Full per-provider price history for a model (every provider that serves it,
   * excluding the model-level '' default). This is the raw material for the price
   * explorer: the client reconstructs the min-across-providers envelope and each
   * provider's own step series from these change-log rows.
   */
  async getProviderPriceHistory(
    modelId: string,
    filter: { since?: string; limit?: number } = {},
  ): Promise<PriceHistoryRow[]> {
    const clauses = ["model_id = $1", "provider <> ''"];
    const params: unknown[] = [modelId];
    if (filter.since) {
      params.push(filter.since);
      clauses.push(`observed_at >= $${params.length}`);
    }
    params.push(resolveLimit(filter.limit));
    const result = await this.pool.query(
      `SELECT provider, observed_at, prompt_usd, completion_usd, request_usd, image_usd,
              web_search_usd, internal_reasoning_usd, cache_read_usd, cache_write_usd,
              context_length, quantization, is_free
       FROM ${this.t("price_points")}
       WHERE ${clauses.join(" AND ")}
       ORDER BY observed_at ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapPriceHistory);
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  async upsertUsage(point: UsageUpsert, opts: { onConflict?: "update" | "ignore" } = {}): Promise<void> {
    await this.pool.query(usageInsertSql(this.t("usage_snapshots"), opts.onConflict ?? "update"), usageParams(point));
  }

  /**
   * Upsert many usage points in one transaction.
   * `onConflict: "ignore"` makes this a gap-filler that never overwrites rows an
   * authoritative source already wrote (used by the historical backfill).
   */
  async upsertUsageBatch(points: UsageUpsert[], opts: { onConflict?: "update" | "ignore" } = {}): Promise<number> {
    if (points.length === 0) return 0;
    const sql = usageInsertSql(this.t("usage_snapshots"), opts.onConflict ?? "update");
    const client = await this.pool.connect();
    let count = 0;
    try {
      await client.query("BEGIN");
      for (const point of points) {
        await client.query(sql, usageParams(point));
        count += 1;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return count;
  }

  async getUsageHistory(modelId: string, filter: { since?: string; provider?: string } = {}): Promise<UsageRow[]> {
    const clauses = ["model_id = $1"];
    const params: unknown[] = [modelId];
    params.push(filter.provider ?? "");
    clauses.push(`provider = $${params.length}`);
    if (filter.since) {
      params.push(filter.since);
      clauses.push(`bucket_date >= $${params.length}`);
    }
    const result = await this.pool.query(
      `SELECT model_id, provider, bucket_date, tokens, prompt_tokens, completion_tokens,
              requests, estimated_spend_usd, reasoning_tokens
       FROM ${this.t("usage_snapshots")}
       WHERE ${clauses.join(" AND ")}
       ORDER BY bucket_date ASC`,
      params,
    );
    return result.rows.map(mapUsage);
  }

  /** Market-wide daily totals (tokens + estimated spend) across all models. */
  async getMarketUsageSeries(filter: { since?: string } = {}): Promise<
    { bucketDate: string; totalTokens: number | null; totalSpendUsd: number | null; modelCount: number }[]
  > {
    const params: unknown[] = [];
    let where = "provider = ''";
    if (filter.since) {
      params.push(filter.since);
      where += ` AND bucket_date >= $${params.length}`;
    }
    const result = await this.pool.query(
      `SELECT bucket_date,
              SUM(tokens) AS total_tokens,
              SUM(estimated_spend_usd) AS total_spend,
              COUNT(*) FILTER (WHERE tokens > 0) AS model_count
       FROM ${this.t("usage_snapshots")}
       WHERE ${where}
       GROUP BY bucket_date
       ORDER BY bucket_date ASC`,
      params,
    );
    return result.rows.map((row) => ({
      bucketDate: toDateString(row.bucket_date),
      totalTokens: num(row.total_tokens),
      totalSpendUsd: num(row.total_spend),
      modelCount: Number(row.model_count ?? 0),
    }));
  }

  /**
   * Weekly per-model spend/tokens from our own daily snapshots — the honest
   * "model race" source. OpenRouter's weekly rankings chart names only each
   * week's top-10 by tokens and folds the rest into "Others", which silently
   * drops expensive lower-volume models. Only full ISO weeks are returned
   * (the in-progress week would read as a crash), limited to the union of the
   * window's top `topN` models by spend and by tokens.
   */
  async getWeeklyModelRace(filter: { since: string; topN?: number }): Promise<
    { date: string; spendByModel: Record<string, number>; tokensByModel: Record<string, number> }[]
  > {
    const topN = Math.min(Math.max(1, filter.topN ?? 14), 40);
    const result = await this.pool.query(
      `SELECT date_trunc('week', bucket_date)::date AS week,
              model_id,
              SUM(tokens) AS tokens,
              SUM(estimated_spend_usd) AS spend,
              COUNT(*) AS days
       FROM ${this.t("usage_snapshots")}
       WHERE provider = '' AND bucket_date >= $1
       GROUP BY 1, 2
       ORDER BY 1 ASC`,
      [filter.since],
    );

    const totalSpend = new Map<string, number>();
    const totalTokens = new Map<string, number>();
    const daysPerWeek = new Map<string, number>();
    for (const row of result.rows) {
      const week = toDateString(row.week);
      const days = Number(row.days ?? 0);
      daysPerWeek.set(week, Math.max(daysPerWeek.get(week) ?? 0, days));
      totalSpend.set(row.model_id, (totalSpend.get(row.model_id) ?? 0) + (num(row.spend) ?? 0));
      totalTokens.set(row.model_id, (totalTokens.get(row.model_id) ?? 0) + (num(row.tokens) ?? 0));
    }
    const rank = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k);
    const keep = new Set([...rank(totalSpend), ...rank(totalTokens)]);

    const byWeek = new Map<string, { spendByModel: Record<string, number>; tokensByModel: Record<string, number> }>();
    for (const row of result.rows) {
      const week = toDateString(row.week);
      if ((daysPerWeek.get(week) ?? 0) < 7) continue; // partial week
      if (!keep.has(row.model_id)) continue;
      let bucket = byWeek.get(week);
      if (!bucket) {
        bucket = { spendByModel: {}, tokensByModel: {} };
        byWeek.set(week, bucket);
      }
      bucket.spendByModel[row.model_id] = num(row.spend) ?? 0;
      bucket.tokensByModel[row.model_id] = num(row.tokens) ?? 0;
    }
    return [...byWeek.entries()].map(([date, maps]) => ({ date, ...maps }));
  }

  /** Top models by estimated spend on the most recent day, with names + prices. */
  async getTopModelsByUsage(limit = 20): Promise<
    { modelId: string; name: string; author: string; tokens: number | null; spendUsd: number | null; bucketDate: string }[]
  > {
    const result = await this.pool.query(
      `WITH latest AS (
         SELECT MAX(bucket_date) AS d FROM ${this.t("usage_snapshots")} WHERE provider = ''
       )
       SELECT us.model_id, COALESCE(m.name, us.model_id) AS name, COALESCE(m.author, '') AS author,
              us.tokens, us.estimated_spend_usd, us.bucket_date
       FROM ${this.t("usage_snapshots")} us
       LEFT JOIN ${this.t("models")} m ON m.model_id = us.model_id
       WHERE us.provider = '' AND us.bucket_date = (SELECT d FROM latest)
       ORDER BY us.estimated_spend_usd DESC NULLS LAST, us.tokens DESC NULLS LAST
       LIMIT $1`,
      [Math.min(Math.max(1, limit), 200)],
    );
    return result.rows.map((row) => ({
      modelId: row.model_id,
      name: row.name,
      author: row.author,
      tokens: num(row.tokens),
      spendUsd: num(row.estimated_spend_usd),
      bucketDate: toDateString(row.bucket_date),
    }));
  }

  /** Per-provider rollup from the latest price of each (model, provider) pair. */
  async getProviderStats(): Promise<
    { provider: string; modelCount: number; cheapestUsdPerMtok: number | null; avgUsdPerMtok: number | null }[]
  > {
    const result = await this.pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (model_id, provider) model_id, provider, prompt_usd, completion_usd
         FROM ${this.t("price_points")}
         WHERE provider <> ''
         ORDER BY model_id, provider, observed_at DESC
       ), blended AS (
         SELECT provider,
                (COALESCE(prompt_usd, completion_usd, 0) * 0.5 + COALESCE(completion_usd, prompt_usd, 0) * 0.5) * 1000000 AS per_mtok,
                (COALESCE(prompt_usd,0) > 0 OR COALESCE(completion_usd,0) > 0) AS priced
         FROM latest
       )
       SELECT provider,
              COUNT(*) AS model_count,
              MIN(per_mtok) FILTER (WHERE priced) AS cheapest,
              AVG(per_mtok) FILTER (WHERE priced) AS avg_price
       FROM blended
       GROUP BY provider
       ORDER BY model_count DESC, provider ASC`,
    );
    return result.rows.map((row) => ({
      provider: row.provider,
      modelCount: Number(row.model_count ?? 0),
      cheapestUsdPerMtok: num(row.cheapest),
      avgUsdPerMtok: num(row.avg_price),
    }));
  }

  // -------------------------------------------------------------------------
  // Market snapshots
  // -------------------------------------------------------------------------

  async insertMarketSnapshot(snap: MarketSnapshotInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("market_snapshots")} (
        captured_at, total_models, active_models, free_models, total_daily_tokens,
        total_estimated_daily_spend_usd, avg_prompt_usd_per_mtok, median_prompt_usd_per_mtok,
        usage_weighted_prompt_usd_per_mtok, cheapest_frontier_usd_per_mtok, raw
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (captured_at) DO UPDATE SET
        total_models = EXCLUDED.total_models,
        active_models = EXCLUDED.active_models,
        free_models = EXCLUDED.free_models,
        total_daily_tokens = EXCLUDED.total_daily_tokens,
        total_estimated_daily_spend_usd = EXCLUDED.total_estimated_daily_spend_usd,
        avg_prompt_usd_per_mtok = EXCLUDED.avg_prompt_usd_per_mtok,
        median_prompt_usd_per_mtok = EXCLUDED.median_prompt_usd_per_mtok,
        usage_weighted_prompt_usd_per_mtok = EXCLUDED.usage_weighted_prompt_usd_per_mtok,
        cheapest_frontier_usd_per_mtok = EXCLUDED.cheapest_frontier_usd_per_mtok,
        raw = EXCLUDED.raw`,
      [
        snap.capturedAt.toISOString(),
        snap.totalModels,
        snap.activeModels,
        snap.freeModels,
        snap.totalDailyTokens,
        snap.totalEstimatedDailySpendUsd,
        snap.avgPromptUsdPerMtok,
        snap.medianPromptUsdPerMtok,
        snap.usageWeightedPromptUsdPerMtok,
        snap.cheapestFrontierUsdPerMtok,
        jsonbOrNull(snap.raw),
      ],
    );
  }

  async getMarketSnapshots(filter: { since?: string; limit?: number } = {}): Promise<MarketRow[]> {
    const params: unknown[] = [];
    let where = "";
    if (filter.since) {
      params.push(filter.since);
      where = `WHERE captured_at >= $${params.length}`;
    }
    params.push(resolveLimit(filter.limit));
    const result = await this.pool.query(
      `SELECT captured_at, total_models, active_models, free_models, total_daily_tokens,
              total_estimated_daily_spend_usd, avg_prompt_usd_per_mtok, median_prompt_usd_per_mtok,
              usage_weighted_prompt_usd_per_mtok, cheapest_frontier_usd_per_mtok
       FROM ${this.t("market_snapshots")}
       ${where}
       ORDER BY captured_at ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapMarket);
  }

  // -------------------------------------------------------------------------
  // GPU rental prices (vast.ai)
  // -------------------------------------------------------------------------

  /** Write one hour's price bands for many GPUs in a single statement. */
  async insertGpuPriceSnapshots(
    capturedAt: Date,
    snapshots: GpuPriceSnapshotInsert[],
    source = "bundles",
  ): Promise<number> {
    if (snapshots.length === 0) return 0;

    const params: unknown[] = [];
    const tuples = snapshots.map((snap) => {
      const base = params.length;
      params.push(
        snap.gpuName,
        capturedAt.toISOString(),
        snap.offers,
        snap.gpusAvailable,
        snap.excludedOffers,
        snap.minUsd,
        snap.p25Usd,
        snap.medianUsd,
        snap.p75Usd,
        snap.maxUsd,
        snap.meanUsd,
        snap.supplyWeightedUsd,
        snap.minBidUsd,
        snap.verifiedOffers,
        snap.verifiedGpusAvailable,
        snap.verifiedMinUsd,
        snap.verifiedMedianUsd,
        source,
      );
      const slots = Array.from({ length: 18 }, (_, i) => `$${base + i + 1}`);
      return `(${slots.join(",")})`;
    });

    await this.pool.query(
      `INSERT INTO ${this.t("gpu_price_snapshots")} (
        gpu_name, captured_at, offers, gpus_available, excluded_offers, min_usd, p25_usd, median_usd,
        p75_usd, max_usd, mean_usd, supply_weighted_usd, min_bid_usd,
        verified_offers, verified_gpus_available, verified_min_usd, verified_median_usd, source
      ) VALUES ${tuples.join(",")}
      ON CONFLICT (gpu_name, captured_at) DO UPDATE SET
        offers = EXCLUDED.offers,
        gpus_available = EXCLUDED.gpus_available,
        excluded_offers = EXCLUDED.excluded_offers,
        min_usd = EXCLUDED.min_usd,
        p25_usd = EXCLUDED.p25_usd,
        median_usd = EXCLUDED.median_usd,
        p75_usd = EXCLUDED.p75_usd,
        max_usd = EXCLUDED.max_usd,
        mean_usd = EXCLUDED.mean_usd,
        supply_weighted_usd = EXCLUDED.supply_weighted_usd,
        min_bid_usd = EXCLUDED.min_bid_usd,
        verified_offers = EXCLUDED.verified_offers,
        verified_gpus_available = EXCLUDED.verified_gpus_available,
        verified_min_usd = EXCLUDED.verified_min_usd,
        verified_median_usd = EXCLUDED.verified_median_usd,
        source = EXCLUDED.source`,
      params,
    );
    return snapshots.length;
  }

  /** Time series of price bands, optionally for one GPU. Ascending by time. */
  async getGpuSeries(
    filter: { gpuName?: string; since?: string; limit?: number } = {},
  ): Promise<GpuPriceRow[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (filter.gpuName) {
      params.push(filter.gpuName);
      clauses.push(`gpu_name = $${params.length}`);
    }
    if (filter.since) {
      params.push(filter.since);
      clauses.push(`captured_at >= $${params.length}`);
    }
    params.push(resolveLimit(filter.limit));

    const result = await this.pool.query(
      `SELECT * FROM ${this.t("gpu_price_snapshots")}
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY captured_at ASC, gpu_name ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapGpuPrice);
  }

  /**
   * One row per (GPU, UTC day), aggregated in SQL so the sub-hourly sweep
   * cadence never has to ship every snapshot to the browser. Semantics match
   * what the frontend used to compute client-side: the day's min is the best
   * price reachable at any sweep; median/p25/p75 are medians of the sweeps'
   * values, so a sweep with a deep book cannot outvote a thin one; depth is
   * the day's peak.
   */
  async getGpuDaily(
    filter: { gpuName?: string; since?: string; limit?: number } = {},
  ): Promise<GpuDailyRow[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (filter.gpuName) {
      params.push(filter.gpuName);
      clauses.push(`gpu_name = $${params.length}`);
    }
    if (filter.since) {
      params.push(filter.since);
      clauses.push(`captured_at >= $${params.length}`);
    }
    params.push(resolveLimit(filter.limit));

    const result = await this.pool.query(
      `SELECT gpu_name,
              -- TEXT, not ::date: a DATE here would depend on the pg type
              -- parser of whichever pool runs the query (scripts that build
              -- their own pool would get a JS Date and a timezone shift).
              TO_CHAR(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              MIN(min_usd) AS min_usd,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY median_usd::float8) AS median_usd,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p25_usd::float8) AS p25_usd,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p75_usd::float8) AS p75_usd,
              MAX(gpus_available) AS gpus_available,
              COUNT(*) AS samples
       FROM ${this.t("gpu_price_snapshots")}
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       GROUP BY gpu_name, day
       ORDER BY day ASC, gpu_name ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row: any) => ({
      gpuName: String(row.gpu_name),
      date: String(row.day),
      minUsd: num(row.min_usd),
      medianUsd: num(row.median_usd),
      p25Usd: num(row.p25_usd),
      p75Usd: num(row.p75_usd),
      gpusAvailable: Number(row.gpus_available ?? 0),
      samples: Number(row.samples ?? 0),
    }));
  }

  /** The most recent snapshot for every GPU that has ever been captured. */
  async getGpuLatest(): Promise<GpuPriceRow[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (gpu_name) *
       FROM ${this.t("gpu_price_snapshots")}
       ORDER BY gpu_name ASC, captured_at DESC`,
    );
    return result.rows.map(mapGpuPrice);
  }

  /**
   * Daily price index over the full usage history. For each day: the
   * usage-weighted and median input $/Mtok across paid models that routed
   * tokens that day, priced from the change-log (last price observed on or
   * before the day; the earliest known price carries back before tracking
   * began — a quote holds until it changes). Days therefore differ by traffic
   * mix immediately, and by real repricing as the change-log accumulates.
   */
  async getDailyPriceIndex(filter: { since?: string }): Promise<
    { date: string; weightedUsdPerMtok: number | null; medianUsdPerMtok: number | null }[]
  > {
    const result = await this.pool.query(
      `WITH priced AS (
         SELECT us.bucket_date, us.tokens,
                COALESCE(
                  (SELECT pp.prompt_usd FROM ${this.t("price_points")} pp
                   WHERE pp.model_id = us.model_id AND pp.provider = ''
                     AND pp.observed_at < us.bucket_date + INTERVAL '1 day'
                   ORDER BY pp.observed_at DESC LIMIT 1),
                  (SELECT pp.prompt_usd FROM ${this.t("price_points")} pp
                   WHERE pp.model_id = us.model_id AND pp.provider = ''
                   ORDER BY pp.observed_at ASC LIMIT 1)
                ) AS prompt_usd
         FROM ${this.t("usage_snapshots")} us
         WHERE us.provider = '' AND us.tokens > 0 AND us.bucket_date >= $1
       )
       SELECT bucket_date,
              SUM(prompt_usd * tokens) FILTER (WHERE prompt_usd > 0)
                / NULLIF(SUM(tokens) FILTER (WHERE prompt_usd > 0), 0) * 1e6 AS weighted,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY prompt_usd * 1e6)
                FILTER (WHERE prompt_usd > 0) AS median
       FROM priced
       GROUP BY bucket_date
       ORDER BY bucket_date ASC`,
      [filter.since ?? "1970-01-01"],
    );
    return result.rows.map((row) => ({
      date: toDateString(row.bucket_date),
      weightedUsdPerMtok: num(row.weighted),
      medianUsdPerMtok: num(row.median),
    }));
  }

  async getLatestMarketSnapshot(): Promise<MarketRow | null> {
    const result = await this.pool.query(
      `SELECT captured_at, total_models, active_models, free_models, total_daily_tokens,
              total_estimated_daily_spend_usd, avg_prompt_usd_per_mtok, median_prompt_usd_per_mtok,
              usage_weighted_prompt_usd_per_mtok, cheapest_frontier_usd_per_mtok
       FROM ${this.t("market_snapshots")}
       ORDER BY captured_at DESC LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? mapMarket(row) : null;
  }

  // -------------------------------------------------------------------------
  // Ingest runs + KV
  // -------------------------------------------------------------------------

  async startIngestRun(): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO ${this.t("ingest_runs")} (status) VALUES ('running') RETURNING id`,
    );
    return result.rows[0]!.id;
  }

  async finishIngestRun(
    id: string,
    fields: { status: string; modelsSeen?: number; priceChanges?: number; usageRows?: number; durationMs?: number; error?: string | null; notes?: unknown },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("ingest_runs")} SET
        finished_at = NOW(),
        status = $2,
        models_seen = $3,
        price_changes = $4,
        usage_rows = $5,
        duration_ms = $6,
        error = $7,
        notes = $8
       WHERE id = $1`,
      [
        id,
        fields.status,
        fields.modelsSeen ?? null,
        fields.priceChanges ?? null,
        fields.usageRows ?? null,
        fields.durationMs ?? null,
        fields.error ?? null,
        jsonbOrNull(fields.notes),
      ],
    );
  }

  async getIngestRuns(limit = 20): Promise<IngestRunRow[]> {
    const result = await this.pool.query(
      `SELECT id, started_at, finished_at, status, models_seen, price_changes, usage_rows, duration_ms, error
       FROM ${this.t("ingest_runs")}
       ORDER BY started_at DESC LIMIT $1`,
      [Math.min(Math.max(1, limit), 200)],
    );
    return result.rows.map(mapIngestRun);
  }

  async getLastIngestRun(): Promise<IngestRunRow | null> {
    const [row] = await this.getIngestRuns(1);
    return row ?? null;
  }

  async getState(key: string): Promise<string | null> {
    const result = await this.pool.query<{ value: string }>(
      `SELECT value FROM ${this.t("kv_state")} WHERE key = $1`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("kv_state")} (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }

  /** High-level data coverage for the health endpoint. */
  async getCoverage(): Promise<{
    usageDateMin: string | null;
    usageDateMax: string | null;
    usageDays: number;
    pricePoints: number;
    marketSnapshots: number;
    lastUsageCapturedAt: string | null;
  }> {
    const result = await this.pool.query<{
      usage_min: string | null;
      usage_max: string | null;
      usage_days: string;
      price_points: string;
      market_snapshots: string;
      last_captured: string | null;
    }>(
      `SELECT
         (SELECT MIN(bucket_date)::text FROM ${this.t("usage_snapshots")}) AS usage_min,
         (SELECT MAX(bucket_date)::text FROM ${this.t("usage_snapshots")}) AS usage_max,
         (SELECT COUNT(DISTINCT bucket_date)::text FROM ${this.t("usage_snapshots")}) AS usage_days,
         (SELECT COUNT(*)::text FROM ${this.t("price_points")}) AS price_points,
         (SELECT COUNT(*)::text FROM ${this.t("market_snapshots")}) AS market_snapshots,
         (SELECT to_char(MAX(captured_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM ${this.t("usage_snapshots")}) AS last_captured`,
    );
    const row = result.rows[0];
    return {
      usageDateMin: row?.usage_min ?? null,
      usageDateMax: row?.usage_max ?? null,
      usageDays: Number(row?.usage_days ?? 0),
      pricePoints: Number(row?.price_points ?? 0),
      marketSnapshots: Number(row?.market_snapshots ?? 0),
      lastUsageCapturedAt: row?.last_captured ?? null,
    };
  }

  async getDatabaseStats(): Promise<{ totalSizeBytes: string; tables: DatabaseTableStats[] }> {
    const tableNames = ["models", "price_points", "usage_snapshots", "market_snapshots", "ingest_runs", "kv_state"];
    const [dbSize, ...tableStats] = await Promise.all([
      this.pool.query<{ size: string }>(`SELECT pg_database_size(current_database())::text AS size`),
      ...tableNames.map(async (name) => {
        const result = await this.pool.query<{ row_count: string; total: string }>(
          `SELECT COUNT(*)::text AS row_count, pg_total_relation_size($1::regclass)::text AS total FROM ${this.t(name)}`,
          [`${quoteIdent(this.schema)}.${quoteIdent(name)}`],
        );
        const row = result.rows[0];
        return { tableName: name, rowCount: row?.row_count ?? "0", totalSizeBytes: row?.total ?? "0" };
      }),
    ]);
    return { totalSizeBytes: dbSize.rows[0]?.size ?? "0", tables: tableStats };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Row mappers + helpers
// ---------------------------------------------------------------------------

/** Stable key for a (model, provider) price pair. "" provider = model-level price. */
export function priceStateKey(modelId: string, provider: string): string {
  return `${modelId}\u0000${provider}`;
}

function usageInsertSql(table: string, onConflict: "update" | "ignore"): string {
  const conflict =
    onConflict === "ignore"
      ? "ON CONFLICT (model_id, provider, bucket_date) DO NOTHING"
      : `ON CONFLICT (model_id, provider, bucket_date) DO UPDATE SET
          tokens = EXCLUDED.tokens,
          prompt_tokens = EXCLUDED.prompt_tokens,
          completion_tokens = EXCLUDED.completion_tokens,
          requests = EXCLUDED.requests,
          estimated_spend_usd = EXCLUDED.estimated_spend_usd,
          reasoning_tokens = COALESCE(EXCLUDED.reasoning_tokens, ${table}.reasoning_tokens),
          source = EXCLUDED.source,
          captured_at = NOW()`;
  return `INSERT INTO ${table} (
      model_id, provider, bucket_date, tokens, prompt_tokens, completion_tokens,
      requests, estimated_spend_usd, reasoning_tokens, source, captured_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    ${conflict}`;
}

function usageParams(point: UsageUpsert): unknown[] {
  return [
    point.modelId,
    point.provider,
    point.bucketDate,
    point.tokens,
    point.promptTokens,
    point.completionTokens,
    point.requests,
    point.estimatedSpendUsd,
    point.reasoningTokens ?? null,
    point.source,
  ];
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function jsonbOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function mapStoredModel(row: any): StoredModel {
  return {
    modelId: row.model_id,
    canonicalSlug: row.canonical_slug ?? null,
    permaslug: row.permaslug ?? null,
    promotionText: row.promotion_text ?? null,
    name: row.name,
    author: row.author,
    variant: row.variant ?? null,
    description: row.description ?? null,
    contextLength: num(row.context_length),
    modality: row.modality ?? null,
    inputModalities: row.input_modalities ?? null,
    outputModalities: row.output_modalities ?? null,
    tokenizer: row.tokenizer ?? null,
    huggingFaceId: row.hugging_face_id ?? null,
    supportedParameters: row.supported_parameters ?? null,
    isModerated: row.is_moderated ?? null,
    createdOr: toIso(row.created_or),
    knowledgeCutoff: row.knowledge_cutoff ?? null,
    firstSeenAt: toIso(row.first_seen_at) ?? "",
    lastSeenAt: toIso(row.last_seen_at) ?? "",
    isActive: Boolean(row.is_active),
  };
}

function mapModelWithLatest(row: any): ModelWithLatest {
  return {
    ...mapStoredModel(row),
    promptUsd: num(row.prompt_usd),
    completionUsd: num(row.completion_usd),
    requestUsd: num(row.request_usd),
    imageUsd: num(row.image_usd),
    isFree: Boolean(row.is_free),
    priceObservedAt: toIso(row.price_observed_at),
    latestTokens: num(row.latest_tokens),
    latestSpendUsd: num(row.latest_spend),
    latestUsageDate: row.latest_usage_date ? toDateString(row.latest_usage_date) : null,
    providerCount: Number(row.provider_count ?? 0),
  };
}

function mapPriceHistory(row: any): PriceHistoryRow {
  return {
    provider: row.provider,
    observedAt: toIso(row.observed_at) ?? "",
    promptUsd: num(row.prompt_usd),
    completionUsd: num(row.completion_usd),
    requestUsd: num(row.request_usd),
    imageUsd: num(row.image_usd),
    webSearchUsd: num(row.web_search_usd),
    internalReasoningUsd: num(row.internal_reasoning_usd),
    cacheReadUsd: num(row.cache_read_usd),
    cacheWriteUsd: num(row.cache_write_usd),
    contextLength: num(row.context_length),
    quantization: row.quantization ?? null,
    isFree: Boolean(row.is_free),
  };
}

function mapUsage(row: any): UsageRow {
  return {
    modelId: row.model_id,
    provider: row.provider,
    bucketDate: toDateString(row.bucket_date),
    tokens: num(row.tokens),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    requests: num(row.requests),
    estimatedSpendUsd: num(row.estimated_spend_usd),
    reasoningTokens: num(row.reasoning_tokens),
  };
}

function mapGpuPrice(row: any): GpuPriceRow {
  return {
    gpuName: String(row.gpu_name),
    capturedAt: toIso(row.captured_at) ?? "",
    offers: Number(row.offers ?? 0),
    gpusAvailable: Number(row.gpus_available ?? 0),
    excludedOffers: Number(row.excluded_offers ?? 0),
    minUsd: num(row.min_usd),
    p25Usd: num(row.p25_usd),
    medianUsd: num(row.median_usd),
    p75Usd: num(row.p75_usd),
    maxUsd: num(row.max_usd),
    meanUsd: num(row.mean_usd),
    supplyWeightedUsd: num(row.supply_weighted_usd),
    minBidUsd: num(row.min_bid_usd),
    verifiedOffers: Number(row.verified_offers ?? 0),
    verifiedGpusAvailable: Number(row.verified_gpus_available ?? 0),
    verifiedMinUsd: num(row.verified_min_usd),
    verifiedMedianUsd: num(row.verified_median_usd),
  };
}

function mapMarket(row: any): MarketRow {
  return {
    capturedAt: toIso(row.captured_at) ?? "",
    totalModels: Number(row.total_models ?? 0),
    activeModels: Number(row.active_models ?? 0),
    freeModels: Number(row.free_models ?? 0),
    totalDailyTokens: num(row.total_daily_tokens),
    totalEstimatedDailySpendUsd: num(row.total_estimated_daily_spend_usd),
    avgPromptUsdPerMtok: num(row.avg_prompt_usd_per_mtok),
    medianPromptUsdPerMtok: num(row.median_prompt_usd_per_mtok),
    usageWeightedPromptUsdPerMtok: num(row.usage_weighted_prompt_usd_per_mtok),
    cheapestFrontierUsdPerMtok: num(row.cheapest_frontier_usd_per_mtok),
  };
}

function mapIngestRun(row: any): IngestRunRow {
  return {
    id: String(row.id),
    startedAt: toIso(row.started_at) ?? "",
    finishedAt: toIso(row.finished_at),
    status: row.status,
    modelsSeen: num(row.models_seen),
    priceChanges: num(row.price_changes),
    usageRows: num(row.usage_rows),
    durationMs: num(row.duration_ms),
    error: row.error ?? null,
  };
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function resolveLimit(requested: number | undefined, hardMax = MAX_ROWS): number {
  if (requested === undefined) return hardMax;
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), hardMax);
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return `"${name}"`;
}
