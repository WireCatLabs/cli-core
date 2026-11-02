-- A suggestion's references (chat:, msg:) need the store's own encoding, which SQL cannot write, so the next writable
-- open moves the unconfirmed agent and rule links into `proposed_actions` and deletes this key (moveSuggestedLinks).
INSERT OR REPLACE INTO store_settings (key, value, at) VALUES ('suggested_links_to_move', '1', unixepoch() * 1000);
