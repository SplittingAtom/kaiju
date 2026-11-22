-- KOBE-741 (review STO-10): the model usage ledger is append-only (KOBE-43), except for the
-- nightly retention sweep (services/server/src/retention/table-sweeps.ts), which deletes rows
-- older than the configured period (13 months by default) after setting `kobe.run_usage_retention`
-- for its own transaction only (`set_config(..., true)`). The trigger still refuses any update,
-- and any delete of a row younger than 90 days whatever is set, so a session cannot touch the
-- spend that budgets, the context gauge or a month's usage view still read; the daily rollups
-- (`model_spend_daily`) are kept by the insert trigger and are never decremented. Cascades from a
-- deleted team still pass (trigger depth).
CREATE OR REPLACE FUNCTION "kobe_run_usage_append_only"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  -- Moving a row to another team is refused by the team policy's WITH CHECK (the RLS error).
  IF TG_OP = 'UPDATE' AND NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() < 2 THEN
    IF TG_OP = 'DELETE'
       AND current_setting('kobe.run_usage_retention', true) = 'on'
       AND OLD.at < now() - interval '90 days' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'run_usage is append-only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
