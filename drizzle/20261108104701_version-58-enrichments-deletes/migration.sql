CREATE TRIGGER enrichments_document_gone AFTER DELETE ON documents BEGIN
  DELETE FROM enrichments WHERE subject_type = 'document' AND subject_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER enrichments_note_gone AFTER DELETE ON notes BEGIN
  DELETE FROM enrichments WHERE subject_type = 'note' AND subject_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER enrichments_email_gone AFTER DELETE ON emails BEGIN
  DELETE FROM enrichments WHERE subject_type = 'email' AND subject_id = OLD.id;
  DELETE FROM chunks WHERE chunkable_type = 'email_enrichment' AND chunkable_id = OLD.id;
END;
