-- Restate estimated spend at the rate that was in force on each day, for every
-- model that has effective-price history (2026-08-20).
--
-- The daily sweep does this for the ~30 models it visits (repriceUsageSpendAsOf,
-- src/storage.ts). This is the same arithmetic applied to every model that has
-- ever had an effective-price snapshot, including ones that have since dropped
-- out of the sweep and would otherwise keep the flat rate the old code stamped
-- across their whole history.
--
-- Idempotent: it recomputes spend from tokens and snapshots, so running it
-- twice changes nothing.
--
--   docker exec -i token-tracker-postgres-1 psql -U tokens -d tokens \
--     < scripts/reprice-usage-asof.sql

BEGIN;

WITH share AS (
  -- The model's own observed input/output mix; split-less rows blend at it.
  SELECT model_id,
         COALESCE(
           SUM(prompt_tokens)::float8 / NULLIF(SUM(prompt_tokens + completion_tokens), 0)::float8,
           0.9
         ) AS prompt_share
  FROM usage_snapshots
  WHERE provider = '' AND prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL
  GROUP BY model_id
), first_rate AS (
  -- Earliest known rate per (model, provider): what days before the first
  -- snapshot fall back to. No rate history exists before 2026-08-12.
  SELECT DISTINCT ON (model_id, provider) model_id, provider,
         eff_input_usd_per_mtok AS in_mtok, eff_output_usd_per_mtok AS out_mtok
  FROM effective_price_snapshots
  WHERE eff_input_usd_per_mtok > 0 AND eff_output_usd_per_mtok IS NOT NULL
  ORDER BY model_id, provider, captured_at ASC
), target AS (
  SELECT us.model_id, us.provider, us.bucket_date,
         COALESCE(asof.in_mtok, f.in_mtok) / 1000000 AS in_per_tok,
         COALESCE(asof.out_mtok, f.out_mtok) / 1000000 AS out_per_tok,
         COALESCE(s.prompt_share, 0.9) AS prompt_share
  FROM usage_snapshots us
  JOIN first_rate f ON f.model_id = us.model_id AND f.provider = us.provider
  LEFT JOIN share s ON s.model_id = us.model_id
  LEFT JOIN LATERAL (
    SELECT e.eff_input_usd_per_mtok AS in_mtok, e.eff_output_usd_per_mtok AS out_mtok
    FROM effective_price_snapshots e
    WHERE e.model_id = us.model_id AND e.provider = us.provider
      AND e.captured_at < us.bucket_date + INTERVAL '1 day'
      AND e.eff_input_usd_per_mtok > 0 AND e.eff_output_usd_per_mtok IS NOT NULL
    ORDER BY e.captured_at DESC
    LIMIT 1
  ) asof ON TRUE
)
UPDATE usage_snapshots us
SET estimated_spend_usd = CASE
  WHEN us.prompt_tokens IS NOT NULL AND us.completion_tokens IS NOT NULL
    THEN us.prompt_tokens * t.in_per_tok + us.completion_tokens * t.out_per_tok
  WHEN us.tokens IS NOT NULL
    THEN us.tokens * (t.in_per_tok * t.prompt_share + t.out_per_tok * (1 - t.prompt_share))
  ELSE us.estimated_spend_usd
END
FROM target t
WHERE us.model_id = t.model_id AND us.provider = t.provider AND us.bucket_date = t.bucket_date;

COMMIT;
