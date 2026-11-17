-- A stored readiness row stays only while nothing it counts has changed; any such write drops it, and the next
-- search counts that chat again.
CREATE TRIGGER conversation_readiness_message_ai AFTER INSERT ON messages BEGIN
  DELETE FROM conversation_readiness WHERE chat_id = NEW.chat_id;
END;
--> statement-breakpoint
CREATE TRIGGER conversation_readiness_message_au AFTER UPDATE OF chat_id, deleted_at ON messages
WHEN OLD.chat_id IS NOT NEW.chat_id OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN
  DELETE FROM conversation_readiness WHERE chat_id IN (OLD.chat_id, NEW.chat_id);
END;
--> statement-breakpoint
CREATE TRIGGER conversation_readiness_message_ad AFTER DELETE ON messages BEGIN
  DELETE FROM conversation_readiness WHERE chat_id = OLD.chat_id;
END;
--> statement-breakpoint
CREATE TRIGGER conversation_readiness_revision_ai AFTER INSERT ON message_revisions BEGIN
  DELETE FROM conversation_readiness WHERE chat_id = (SELECT chat_id FROM messages WHERE id = NEW.message_id);
END;
--> statement-breakpoint
CREATE TRIGGER conversation_readiness_state_ai AFTER INSERT ON conversation_state BEGIN
  DELETE FROM conversation_readiness WHERE chat_id = NEW.chat_id;
END;
--> statement-breakpoint
CREATE TRIGGER conversation_readiness_state_au AFTER UPDATE ON conversation_state BEGIN
  DELETE FROM conversation_readiness WHERE chat_id IN (OLD.chat_id, NEW.chat_id);
END;
--> statement-breakpoint
-- A chat whose every chunk text already has a vector cannot gain from a new one: (model, content_hash) is unique.
CREATE TRIGGER conversation_readiness_embedding_ai AFTER INSERT ON embeddings BEGIN
  DELETE FROM conversation_readiness WHERE model = NEW.model AND embedded_count < chunks;
END;
--> statement-breakpoint
CREATE TRIGGER conversation_readiness_embedding_ad AFTER DELETE ON embeddings BEGIN
  DELETE FROM conversation_readiness WHERE model = OLD.model AND embedded_count > 0;
END;
