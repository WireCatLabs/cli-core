-- The store's code checks these first and says why; the triggers keep a stray write from another build, a sync or a
-- hand edit from storing a row the store's code would refuse.
CREATE TRIGGER pipelines_valid_bi BEFORE INSERT ON pipelines WHEN new.kind NOT IN ('deal', 'lead') BEGIN
  SELECT RAISE(ABORT, 'pipelines: kind is deal or lead');
END;
--> statement-breakpoint
CREATE TRIGGER pipelines_valid_bu BEFORE UPDATE ON pipelines WHEN new.kind NOT IN ('deal', 'lead') BEGIN
  SELECT RAISE(ABORT, 'pipelines: kind is deal or lead');
END;
--> statement-breakpoint
CREATE TRIGGER pipelines_kind_bu BEFORE UPDATE OF kind ON pipelines
  WHEN new.kind <> old.kind AND EXISTS (SELECT 1 FROM pipeline_stages s WHERE s.pipeline_id = new.id
    AND (EXISTS (SELECT 1 FROM deals d WHERE d.stage_id = s.id) OR EXISTS (SELECT 1 FROM leads l WHERE l.stage_id = s.id))) BEGIN
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
--> statement-breakpoint
CREATE TRIGGER deals_valid_bi BEFORE INSERT ON deals
  WHEN new.status NOT IN ('open', 'won', 'lost')
    OR (new.amount IS NULL) <> (new.currency IS NULL) OR new.amount < 0
    OR (SELECT p.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = new.stage_id) IS NOT 'deal' BEGIN
  SELECT RAISE(ABORT, 'deals: a known status, an amount with its currency, and a stage of a deal pipeline');
END;
--> statement-breakpoint
CREATE TRIGGER deals_valid_bu BEFORE UPDATE ON deals
  WHEN new.status NOT IN ('open', 'won', 'lost')
    OR (new.amount IS NULL) <> (new.currency IS NULL) OR new.amount < 0
    OR (SELECT p.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = new.stage_id) IS NOT 'deal' BEGIN
  SELECT RAISE(ABORT, 'deals: a known status, an amount with its currency, and a stage of a deal pipeline');
END;
--> statement-breakpoint
-- Every stage a row enters, with the time its writer gave, is what conversion between stages is counted from.
CREATE TRIGGER deals_stage_ai AFTER INSERT ON deals BEGIN
  INSERT INTO pipeline_stage_changes (item_type, item_id, pipeline_id, from_stage_id, to_stage_id, changed_at)
  SELECT 'deal', new.id, s.pipeline_id, NULL, new.stage_id, new.created_at FROM pipeline_stages s WHERE s.id = new.stage_id;
END;
--> statement-breakpoint
CREATE TRIGGER deals_stage_au AFTER UPDATE OF stage_id ON deals WHEN new.stage_id IS NOT old.stage_id BEGIN
  INSERT INTO pipeline_stage_changes (item_type, item_id, pipeline_id, from_stage_id, to_stage_id, changed_at)
  SELECT 'deal', new.id, s.pipeline_id, old.stage_id, new.stage_id, new.updated_at FROM pipeline_stages s WHERE s.id = new.stage_id;
END;
--> statement-breakpoint
CREATE TRIGGER leads_valid_bi BEFORE INSERT ON leads
  WHEN new.status NOT IN ('open', 'won', 'lost')
    OR (new.amount IS NULL) <> (new.currency IS NULL) OR new.amount < 0
    OR (SELECT p.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = new.stage_id) IS NOT 'lead' BEGIN
  SELECT RAISE(ABORT, 'leads: a known status, an amount with its currency, and a stage of a lead pipeline');
END;
--> statement-breakpoint
CREATE TRIGGER leads_valid_bu BEFORE UPDATE ON leads
  WHEN new.status NOT IN ('open', 'won', 'lost')
    OR (new.amount IS NULL) <> (new.currency IS NULL) OR new.amount < 0
    OR (SELECT p.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = new.stage_id) IS NOT 'lead' BEGIN
  SELECT RAISE(ABORT, 'leads: a known status, an amount with its currency, and a stage of a lead pipeline');
END;
--> statement-breakpoint
CREATE TRIGGER leads_stage_ai AFTER INSERT ON leads BEGIN
  INSERT INTO pipeline_stage_changes (item_type, item_id, pipeline_id, from_stage_id, to_stage_id, changed_at)
  SELECT 'lead', new.id, s.pipeline_id, NULL, new.stage_id, new.created_at FROM pipeline_stages s WHERE s.id = new.stage_id;
END;
--> statement-breakpoint
CREATE TRIGGER leads_stage_au AFTER UPDATE OF stage_id ON leads WHEN new.stage_id IS NOT old.stage_id BEGIN
  INSERT INTO pipeline_stage_changes (item_type, item_id, pipeline_id, from_stage_id, to_stage_id, changed_at)
  SELECT 'lead', new.id, s.pipeline_id, old.stage_id, new.stage_id, new.updated_at FROM pipeline_stages s WHERE s.id = new.stage_id;
END;
--> statement-breakpoint
-- The default lead pipeline, so a lead can be recorded before the owner or an agent makes one.
INSERT INTO pipelines (kind, name, name_folded, created_at, updated_at)
  VALUES ('lead', 'Leads', 'leads', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--> statement-breakpoint
INSERT INTO pipeline_stages (pipeline_id, name, name_folded, position, outcome, created_at, updated_at)
  SELECT p.id, v.name, v.name, v.position, v.outcome, p.created_at, p.created_at FROM pipelines p,
    (SELECT 'new' AS name, 1 AS position, 'open' AS outcome UNION ALL SELECT 'contacted', 2, 'open'
      UNION ALL SELECT 'qualified', 3, 'open' UNION ALL SELECT 'won', 4, 'won' UNION ALL SELECT 'lost', 5, 'lost') v
  WHERE p.kind = 'lead' AND p.name_folded = 'leads' AND p.account_id IS NULL;
