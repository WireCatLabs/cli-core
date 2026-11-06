-- The store's code checks these first and says why; the triggers keep a stray write from another build or a hand
-- edit from storing a deal with an unknown status, or an amount without its currency.
CREATE TRIGGER opportunities_valid_bi BEFORE INSERT ON opportunities
  WHEN new.kind NOT IN ('deal', 'lead')
    OR new.status NOT IN ('open', 'won', 'lost')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR (new.amount IS NULL) <> (new.currency IS NULL) OR new.amount < 0 BEGIN
  SELECT RAISE(ABORT, 'opportunities: a known kind, status and review, an amount with its currency');
END;
--> statement-breakpoint
CREATE TRIGGER opportunities_valid_bu BEFORE UPDATE ON opportunities
  WHEN new.kind NOT IN ('deal', 'lead')
    OR new.status NOT IN ('open', 'won', 'lost')
    OR new.review NOT IN ('proposed', 'confirmed', 'rejected')
    OR (new.amount IS NULL) <> (new.currency IS NULL) OR new.amount < 0 BEGIN
  SELECT RAISE(ABORT, 'opportunities: a known kind, status and review, an amount with its currency');
END;
--> statement-breakpoint
-- A deal moves between the stages of its own pipeline only.
CREATE TRIGGER opportunities_same_pipeline_bu BEFORE UPDATE OF stage_id ON opportunities
  WHEN (SELECT pipeline_id FROM pipeline_stages WHERE id = new.stage_id)
    <> (SELECT pipeline_id FROM pipeline_stages WHERE id = old.stage_id) BEGIN
  SELECT RAISE(ABORT, 'opportunities: a deal moves within its own pipeline');
END;
--> statement-breakpoint
-- A deal stands in a deal pipeline and a lead in a lead pipeline.
CREATE TRIGGER opportunities_kind_bi BEFORE INSERT ON opportunities
  WHEN new.kind IS NOT (SELECT p.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.id = new.stage_id) BEGIN
  SELECT RAISE(ABORT, 'opportunities: its kind is its pipeline''s');
END;
--> statement-breakpoint
CREATE TRIGGER opportunities_kind_bu BEFORE UPDATE OF kind, stage_id ON opportunities
  WHEN new.kind IS NOT (SELECT p.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.id = new.stage_id) BEGIN
  SELECT RAISE(ABORT, 'opportunities: its kind is its pipeline''s');
END;
--> statement-breakpoint
CREATE TRIGGER pipelines_valid_bi BEFORE INSERT ON pipelines WHEN new.kind NOT IN ('deal', 'lead') BEGIN
  SELECT RAISE(ABORT, 'pipelines: kind is deal or lead');
END;
--> statement-breakpoint
CREATE TRIGGER pipelines_valid_bu BEFORE UPDATE ON pipelines WHEN new.kind NOT IN ('deal', 'lead') BEGIN
  SELECT RAISE(ABORT, 'pipelines: kind is deal or lead');
END;
--> statement-breakpoint
CREATE TRIGGER pipelines_kind_bu BEFORE UPDATE OF kind ON pipelines
  WHEN new.kind <> old.kind AND EXISTS (SELECT 1 FROM opportunities d JOIN pipeline_stages s ON s.id = d.stage_id
    WHERE s.pipeline_id = new.id) BEGIN
  SELECT RAISE(ABORT, 'pipelines: the kind of a pipeline that holds deals or leads stays');
END;
--> statement-breakpoint
CREATE TRIGGER pipeline_stages_valid_bi BEFORE INSERT ON pipeline_stages
  WHEN new.outcome NOT IN ('open', 'won', 'lost') BEGIN
  SELECT RAISE(ABORT, 'pipeline_stages: outcome is open, won or lost');
END;
--> statement-breakpoint
CREATE TRIGGER pipeline_stages_valid_bu BEFORE UPDATE ON pipeline_stages
  WHEN new.outcome NOT IN ('open', 'won', 'lost') BEGIN
  SELECT RAISE(ABORT, 'pipeline_stages: outcome is open, won or lost');
END;
