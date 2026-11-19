-- Words of a post's title and text, rowid = content_posts.id.
CREATE VIRTUAL TABLE content_post_words USING fts5(
  normalized_text,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE content_post_words_vocab USING fts5vocab(content_post_words, 'col');--> statement-breakpoint
CREATE TRIGGER content_post_words_ai AFTER INSERT ON content_posts WHEN new.normalized_text <> '' BEGIN
  INSERT INTO content_post_words (rowid, normalized_text) VALUES (new.id, new.normalized_text);
END;--> statement-breakpoint
CREATE TRIGGER content_post_words_au AFTER UPDATE OF normalized_text ON content_posts
  WHEN old.normalized_text IS NOT new.normalized_text BEGIN
  DELETE FROM content_post_words WHERE rowid = old.id;
  INSERT INTO content_post_words (rowid, normalized_text)
    SELECT new.id, new.normalized_text WHERE new.normalized_text <> '';
END;--> statement-breakpoint
-- Taggings are polymorphic, with no foreign key: a post row that goes takes its tags along.
CREATE TRIGGER content_post_words_ad AFTER DELETE ON content_posts BEGIN
  DELETE FROM content_post_words WHERE rowid = old.id;
  DELETE FROM taggings WHERE taggable_type = 'post' AND taggable_id = old.id;
END;
