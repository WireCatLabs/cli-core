-- The store's code checks these first and says why; the triggers keep a stray write from another build or a hand
-- edit from storing a deal with an unknown status, or an amount without its currency.
CREATE TRIGGER opportunities_valid_bi BEFORE INSERT ON opportunities
  WHEN new.status NOT IN ('open', 'won', 'lost')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR (new.amount IS NULL) <> (new.currency IS NULL) OR new.amount < 0 BEGIN
  SELECT RAISE(ABORT, 'opportunities: a known status and review, an amount with its currency');
END;
--> statement-breakpoint
CREATE TRIGGER opportunities_valid_bu BEFORE UPDATE ON opportunities
  WHEN new.status NOT IN ('open', 'won', 'lost')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR (new.amount IS NULL) <> (new.currency IS NULL) OR new.amount < 0 BEGIN
  SELECT RAISE(ABORT, 'opportunities: a known status and review, an amount with its currency');
END;
--> statement-breakpoint
-- A deal moves between the stages of its own pipeline only.
CREATE TRIGGER opportunities_same_pipeline_bu BEFORE UPDATE OF stage_id ON opportunities
  WHEN (SELECT pipeline_id FROM pipeline_stages WHERE id = new.stage_id)
    <> (SELECT pipeline_id FROM pipeline_stages WHERE id = old.stage_id) BEGIN
  SELECT RAISE(ABORT, 'opportunities: a deal moves within its own pipeline');
END;
