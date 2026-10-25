-- Every change that can add, drop or move a chunk's vector passes the chunk's id through vector_index_redo, where
-- each model's own trigger (made with its vec0 table, `vector-index.ts`) re-derives that row. Writes in TypeScript
-- and the schema's own delete triggers (document_bd, note_bd, …) all reach the index this way.
-- A chunk usually comes before its vector; the vector's own trigger indexes it then.
-- CROSS JOIN: led by the vectors, SQLite read every one of them per chunk (7 ms each at 100k).
CREATE TRIGGER vector_index_chunk_ai AFTER INSERT ON chunks WHEN EXISTS (SELECT 1 FROM vector_indexes i
    CROSS JOIN embeddings v ON v.model = i.model AND v.content_hash = new.content_hash) BEGIN
  INSERT INTO vector_index_redo (chunk_id) VALUES (new.id);
  DELETE FROM vector_index_redo;
END;
--> statement-breakpoint
CREATE TRIGGER vector_index_chunk_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO vector_index_redo (chunk_id) VALUES (old.id);
  DELETE FROM vector_index_redo;
END;
--> statement-breakpoint
CREATE TRIGGER vector_index_chunk_au AFTER UPDATE OF content_hash, chunkable_type, chunkable_id, account_id, occurred_at
  ON chunks WHEN old.content_hash IS NOT new.content_hash OR old.chunkable_type IS NOT new.chunkable_type
    OR old.chunkable_id IS NOT new.chunkable_id OR old.account_id IS NOT new.account_id
    OR old.occurred_at IS NOT new.occurred_at BEGIN
  INSERT INTO vector_index_redo (chunk_id) VALUES (new.id);
  DELETE FROM vector_index_redo;
END;
--> statement-breakpoint
CREATE TRIGGER vector_index_embedding_ai AFTER INSERT ON embeddings
  WHEN EXISTS (SELECT 1 FROM vector_indexes WHERE model = new.model) BEGIN
  INSERT INTO vector_index_redo (chunk_id) SELECT id FROM chunks WHERE content_hash = new.content_hash;
  DELETE FROM vector_index_redo;
END;
--> statement-breakpoint
CREATE TRIGGER vector_index_embedding_ad AFTER DELETE ON embeddings
  WHEN EXISTS (SELECT 1 FROM vector_indexes WHERE model = old.model) BEGIN
  INSERT INTO vector_index_redo (chunk_id) SELECT id FROM chunks WHERE content_hash = old.content_hash;
  DELETE FROM vector_index_redo;
END;
--> statement-breakpoint
CREATE TRIGGER vector_index_embedding_au AFTER UPDATE OF model, content_hash, vector ON embeddings BEGIN
  INSERT INTO vector_index_redo (chunk_id)
    SELECT id FROM chunks WHERE content_hash = old.content_hash OR content_hash = new.content_hash;
  DELETE FROM vector_index_redo;
END;
--> statement-breakpoint
-- A message's chunk and its images' chunks are indexed under its chat and send time; a chat merge moves messages.
CREATE TRIGGER vector_index_message_au AFTER UPDATE OF chat_id, sent_at ON messages
  WHEN old.chat_id IS NOT new.chat_id OR old.sent_at IS NOT new.sent_at BEGIN
  INSERT INTO vector_index_redo (chunk_id)
    SELECT id FROM chunks WHERE chunkable_type = 'message' AND chunkable_id = new.id
    UNION ALL SELECT k.id FROM attachments a JOIN chunks k ON k.chunkable_type = 'image' AND k.chunkable_id = a.id
      WHERE a.attachable_type = 'message' AND a.attachable_id = new.id;
  DELETE FROM vector_index_redo;
END;
