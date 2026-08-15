-- Assertions a restored backup has to pass before it counts as a backup.
--
-- Run against a database that has just had an archive restored into it:
--
--   docker compose exec -T postgres psql -U tokens -d tokens -v ON_ERROR_STOP=1 \
--     -f - < scripts/verify-restore.sql
--
-- What is fatal here is "this archive is not a usable copy of the database":
-- a table that did not come back, a table that came back empty, history that
-- lost its floor, impossible numbers. Staleness of the *source* is deliberately
-- only a warning — a backup of a database whose ingest stalled last week is
-- still a perfectly good backup, and refusing to store it would throw away the
-- copy without fixing the stall.

\set ON_ERROR_STOP on

-- Every table the application expects, present and populated.
DO $$
DECLARE
  t text;
  n bigint;
  missing text[] := '{}';
  empty text[] := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'models', 'price_points', 'usage_snapshots', 'provider_volume_snapshots',
    'effective_price_snapshots', 'gpu_price_snapshots', 'market_snapshots',
    'ingest_runs', 'kv_state'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      missing := missing || t;
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n = 0 THEN empty := empty || t; END IF;
    RAISE NOTICE '  % — % rows', rpad(t, 26), n;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'tables absent from the restore: %', array_to_string(missing, ', ');
  END IF;
  IF array_length(empty, 1) > 0 THEN
    RAISE EXCEPTION 'tables restored empty: %', array_to_string(empty, ', ');
  END IF;
END $$;

-- The usage history is the part that cannot be re-fetched, so it gets the
-- closest look: the floor we trimmed to, a plausible span, no impossible
-- values, and actual money in the recent window.
DO $$
DECLARE
  lo date;
  hi date;
  span int;
  bad bigint;
  spend numeric;
BEGIN
  SELECT min(bucket_date), max(bucket_date) INTO lo, hi FROM usage_snapshots;
  span := hi - lo;
  RAISE NOTICE '  usage history — % .. % (% days)', lo, hi, span;

  -- knowledge.md §1: everything before this was trimmed on 2026-08-15, and the
  -- source window can no longer reach it. Anything earlier means a restore that
  -- silently mixed in some other database.
  IF lo < DATE '2026-05-18' THEN
    RAISE EXCEPTION 'usage history starts %, before the 2026-05-18 floor', lo;
  END IF;
  IF span < 60 THEN
    RAISE EXCEPTION 'usage history spans only % days', span;
  END IF;

  SELECT count(*) INTO bad FROM usage_snapshots WHERE tokens < 0 OR estimated_spend_usd < 0;
  IF bad > 0 THEN
    RAISE EXCEPTION '% usage rows carry negative tokens or spend', bad;
  END IF;

  -- Unpriced rows are a live condition, not a restore fault: embedding models
  -- and :free variants come through the rankings feed with tokens but no rate
  -- to value them at. Counted, not enforced — this file judges the copy, not
  -- the data it copies.
  SELECT count(*) INTO bad FROM usage_snapshots WHERE tokens > 0 AND estimated_spend_usd IS NULL;
  RAISE NOTICE '  unpriced rows (tokens, no rate) — %', bad;

  -- provider = '' is the model-level series the whole market view is built on.
  SELECT sum(estimated_spend_usd) INTO spend FROM usage_snapshots
   WHERE provider = '' AND bucket_date > hi - 7;
  IF coalesce(spend, 0) <= 0 THEN
    RAISE EXCEPTION 'no market spend across the last 7 covered days';
  END IF;
  RAISE NOTICE '  market spend, last 7 covered days — $%', to_char(round(spend), 'FM999,999,999');

  IF hi < current_date - 5 THEN
    RAISE WARNING 'source data is stale: newest bucket is %, today is % — storing anyway', hi, current_date;
  END IF;
END $$;

-- The catalog and the price change-log, which the price index and explorer read.
DO $$
DECLARE
  active bigint;
  priced bigint;
BEGIN
  SELECT count(*) INTO active FROM models WHERE is_active;
  SELECT count(DISTINCT model_id) INTO priced FROM price_points;
  RAISE NOTICE '  catalog — % active models, % with price history', active, priced;

  IF active < 100 THEN
    RAISE EXCEPTION 'only % active models in the catalog', active;
  END IF;
  IF priced < 100 THEN
    RAISE EXCEPTION 'only % models carry price history', priced;
  END IF;
END $$;
