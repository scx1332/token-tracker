-- One-off repair of the price change-log (2026-08-19).
--
-- Until the endpoint split, price_points was keyed by (model_id, provider).
-- A provider selling one model from several endpoints — OpenAI as `openai`,
-- `openai/flex`, `openai/priority`; Azure per region — therefore had all of
-- its tiers sharing one "last known price" slot, so every sweep found each
-- tier different from whichever tier wrote last and logged a change that never
-- happened. 34,257 rows recorded 2,017 real events; the rest is churn.
--
-- This script is idempotent: it re-derives the endpoint key, then keeps only
-- the rows where something actually changed. Run it AFTER deploying the code
-- that adds and backfills endpoint_tag.
--
--   docker exec -i token-tracker-postgres-1 psql -U tokens -d tokens \
--     < scripts/prune-phantom-prices.sql
--
-- Take a backup first (scripts/backup-db.sh) — deletions are not reversible.

BEGIN;

-- 1. OpenRouter publishes same-tag duplicates: two `google-vertex/us-south1`
--    endpoints for qwen3-235b, two `together` endpoints for gemma-4-31b, alike
--    in every field but the price. Ingest now splits those by price rank.
--    History has to be reconstructed differently, because the old code only
--    ever wrote whichever twin disagreed with the shared slot — leaving one
--    row per sweep alternating between the two prices, which reads as an
--    hourly flap that never happened.
--
--    (a) The first sweep, which wrote both twins at the same instant.
WITH dupes AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY model_id, endpoint_tag, observed_at
           ORDER BY prompt_usd NULLS LAST, completion_usd NULLS LAST, context_length NULLS LAST, id
         ) AS rank
  FROM price_points
  WHERE provider <> '' AND endpoint_tag NOT LIKE '%#%'
)
UPDATE price_points p
SET endpoint_tag = p.endpoint_tag || '#' || d.rank
FROM dupes d
WHERE p.id = d.id AND d.rank > 1;

--    (b) Every sweep after it. A series that bounces between exactly two price
--        sets three times or more is two endpoints interleaved, not one
--        endpoint repricing — a real reprice crosses over once and stays. Each
--        price goes back to its own endpoint. (A single endpoint that genuinely
--        toggled between two prices for a week would be split the same way;
--        none has, and the live endpoint list says these are twins.)
WITH seq AS (
  SELECT id, model_id, endpoint_tag, prompt_usd, completion_usd,
         LAG(prompt_usd) OVER w AS p_prompt,
         LAG(completion_usd) OVER w AS p_completion
  FROM price_points
  WHERE provider <> '' AND endpoint_tag NOT LIKE '%#%'
  WINDOW w AS (PARTITION BY model_id, endpoint_tag ORDER BY observed_at, id)
), flapping AS (
  SELECT model_id, endpoint_tag
  FROM seq
  GROUP BY model_id, endpoint_tag
  HAVING COUNT(DISTINCT (prompt_usd, completion_usd)) = 2
     AND COUNT(*) FILTER (
           WHERE p_prompt IS NOT NULL
             AND (p_prompt IS DISTINCT FROM prompt_usd OR p_completion IS DISTINCT FROM completion_usd)
         ) >= 3
), ranked AS (
  SELECT p.id,
         DENSE_RANK() OVER (
           PARTITION BY p.model_id, p.endpoint_tag
           ORDER BY p.prompt_usd NULLS LAST, p.completion_usd NULLS LAST
         ) AS rank
  FROM price_points p
  JOIN flapping f ON f.model_id = p.model_id AND f.endpoint_tag = p.endpoint_tag
)
UPDATE price_points p
SET endpoint_tag = p.endpoint_tag || '#' || r.rank
FROM ranked r
WHERE p.id = r.id AND r.rank > 1;

-- 2. Drop every row that quoted exactly what the same endpoint already quoted.
--    A row survives only if it is that endpoint's first observation or differs
--    from the one before it in some field a price consumer can read.
WITH ordered AS (
  SELECT id,
         prompt_usd, completion_usd, request_usd, image_usd, web_search_usd,
         internal_reasoning_usd, cache_read_usd, cache_write_usd,
         context_length, quantization, is_free,
         LAG(prompt_usd) OVER w AS p_prompt,
         LAG(completion_usd) OVER w AS p_completion,
         LAG(request_usd) OVER w AS p_request,
         LAG(image_usd) OVER w AS p_image,
         LAG(web_search_usd) OVER w AS p_web,
         LAG(internal_reasoning_usd) OVER w AS p_reasoning,
         LAG(cache_read_usd) OVER w AS p_cache_read,
         LAG(cache_write_usd) OVER w AS p_cache_write,
         LAG(context_length) OVER w AS p_context,
         LAG(quantization) OVER w AS p_quant,
         LAG(is_free) OVER w AS p_free,
         ROW_NUMBER() OVER w AS seq
  FROM price_points
  WINDOW w AS (PARTITION BY model_id, endpoint_tag ORDER BY observed_at, id)
)
DELETE FROM price_points
WHERE id IN (
  SELECT id FROM ordered
  WHERE seq > 1
    AND prompt_usd IS NOT DISTINCT FROM p_prompt
    AND completion_usd IS NOT DISTINCT FROM p_completion
    AND request_usd IS NOT DISTINCT FROM p_request
    AND image_usd IS NOT DISTINCT FROM p_image
    AND web_search_usd IS NOT DISTINCT FROM p_web
    AND internal_reasoning_usd IS NOT DISTINCT FROM p_reasoning
    AND cache_read_usd IS NOT DISTINCT FROM p_cache_read
    AND cache_write_usd IS NOT DISTINCT FROM p_cache_write
    AND context_length IS NOT DISTINCT FROM p_context
    AND quantization IS NOT DISTINCT FROM p_quant
    AND is_free IS NOT DISTINCT FROM p_free
);

SELECT COUNT(*) AS rows_left,
       COUNT(DISTINCT (model_id, endpoint_tag)) AS endpoints
FROM price_points;

COMMIT;
