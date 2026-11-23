-- No foreign key on the change log, so an older build that purges an account still can; this drops its rows with it.
CREATE TRIGGER document_changes_account_bd BEFORE DELETE ON accounts BEGIN
  DELETE FROM document_changes WHERE account_id = old.id;
END;
