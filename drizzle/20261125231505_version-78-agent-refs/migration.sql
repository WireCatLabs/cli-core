-- Until version 78 `bot` named the agents of the `bots` table, in every pointer pair and ref. Sender bots take
-- `bot:` now, so the agents' values move to `agent` first, and `sender-bot:` refs become `bot:` after. Whole values
-- only: a text replace would turn `sender-bot:5` and `telegram-bot:` into something else.
UPDATE agent_actions SET actor_type = 'agent' WHERE actor_type = 'bot';
--> statement-breakpoint
UPDATE agent_actions SET target_type = 'agent' WHERE target_type = 'bot';
--> statement-breakpoint
UPDATE aliases SET aliasable_type = 'agent' WHERE aliasable_type = 'bot';
--> statement-breakpoint
UPDATE attachments SET attachable_type = 'agent' WHERE attachable_type = 'bot';
--> statement-breakpoint
UPDATE catalog_items SET supplier_type = 'agent' WHERE supplier_type = 'bot';
--> statement-breakpoint
UPDATE catalog_items SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE contracts SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE contracts SET confirmed_by_type = 'agent' WHERE confirmed_by_type = 'bot';
--> statement-breakpoint
UPDATE deals SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE decisions SET confirmed_by_type = 'agent' WHERE confirmed_by_type = 'bot';
--> statement-breakpoint
UPDATE enrichments SET subject_type = 'agent' WHERE subject_type = 'bot';
--> statement-breakpoint
UPDATE entity_link_events SET linkable_type = 'agent' WHERE linkable_type = 'bot';
--> statement-breakpoint
UPDATE facts SET subject_type = 'agent' WHERE subject_type = 'bot';
--> statement-breakpoint
UPDATE facts SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE facts SET confirmed_by_type = 'agent' WHERE confirmed_by_type = 'bot';
--> statement-breakpoint
UPDATE financial_accounts SET holder_type = 'agent' WHERE holder_type = 'bot';
--> statement-breakpoint
UPDATE financial_accounts SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE financial_transactions SET counterparty_type = 'agent' WHERE counterparty_type = 'bot';
--> statement-breakpoint
UPDATE financial_transactions SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE financial_transactions SET confirmed_by_type = 'agent' WHERE confirmed_by_type = 'bot';
--> statement-breakpoint
UPDATE invoices SET issuer_type = 'agent' WHERE issuer_type = 'bot';
--> statement-breakpoint
UPDATE invoices SET counterparty_type = 'agent' WHERE counterparty_type = 'bot';
--> statement-breakpoint
UPDATE invoices SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE invoices SET confirmed_by_type = 'agent' WHERE confirmed_by_type = 'bot';
--> statement-breakpoint
UPDATE involvements SET subject_type = 'agent' WHERE subject_type = 'bot';
--> statement-breakpoint
UPDATE leads SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE link_reviews SET linkable_type = 'agent' WHERE linkable_type = 'bot';
--> statement-breakpoint
UPDATE links SET from_type = 'agent' WHERE from_type = 'bot';
--> statement-breakpoint
UPDATE links SET to_type = 'agent' WHERE to_type = 'bot';
--> statement-breakpoint
UPDATE memories SET subject_type = 'agent' WHERE subject_type = 'bot';
--> statement-breakpoint
UPDATE memories SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE mentions SET source_type = 'agent' WHERE source_type = 'bot';
--> statement-breakpoint
UPDATE mentions SET target_type = 'agent' WHERE target_type = 'bot';
--> statement-breakpoint
UPDATE notes SET notable_type = 'agent' WHERE notable_type = 'bot';
--> statement-breakpoint
UPDATE notes SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE orders SET customer_type = 'agent' WHERE customer_type = 'bot';
--> statement-breakpoint
UPDATE orders SET supplier_type = 'agent' WHERE supplier_type = 'bot';
--> statement-breakpoint
UPDATE orders SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE orders SET confirmed_by_type = 'agent' WHERE confirmed_by_type = 'bot';
--> statement-breakpoint
UPDATE payment_allocations SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE payments SET payer_type = 'agent' WHERE payer_type = 'bot';
--> statement-breakpoint
UPDATE payments SET payee_type = 'agent' WHERE payee_type = 'bot';
--> statement-breakpoint
UPDATE payments SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE payments SET confirmed_by_type = 'agent' WHERE confirmed_by_type = 'bot';
--> statement-breakpoint
UPDATE pipeline_stage_changes SET item_type = 'agent' WHERE item_type = 'bot';
--> statement-breakpoint
UPDATE projects SET owner_type = 'agent' WHERE owner_type = 'bot';
--> statement-breakpoint
UPDATE proposed_actions SET target_type = 'agent' WHERE target_type = 'bot';
--> statement-breakpoint
UPDATE proposed_actions SET proposed_by_type = 'agent' WHERE proposed_by_type = 'bot';
--> statement-breakpoint
UPDATE proposed_actions SET decided_by_type = 'agent' WHERE decided_by_type = 'bot';
--> statement-breakpoint
UPDATE record_relations SET target_type = 'agent' WHERE target_type = 'bot';
--> statement-breakpoint
UPDATE records SET entity_type = 'agent' WHERE entity_type = 'bot';
--> statement-breakpoint
UPDATE subscription_prices SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE subscription_prices SET confirmed_by_type = 'agent' WHERE confirmed_by_type = 'bot';
--> statement-breakpoint
UPDATE subscriptions SET supplier_type = 'agent' WHERE supplier_type = 'bot';
--> statement-breakpoint
UPDATE subscriptions SET customer_type = 'agent' WHERE customer_type = 'bot';
--> statement-breakpoint
UPDATE subscriptions SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE subscriptions SET confirmed_by_type = 'agent' WHERE confirmed_by_type = 'bot';
--> statement-breakpoint
UPDATE tag_consolidations SET actor_type = 'agent' WHERE actor_type = 'bot';
--> statement-breakpoint
UPDATE taggings SET taggable_type = 'agent' WHERE taggable_type = 'bot';
--> statement-breakpoint
UPDATE taggings SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE task_assignments SET assignee_type = 'agent' WHERE assignee_type = 'bot';
--> statement-breakpoint
UPDATE task_events SET actor_type = 'agent' WHERE actor_type = 'bot';
--> statement-breakpoint
UPDATE task_pairs SET decided_by_type = 'agent' WHERE decided_by_type = 'bot';
--> statement-breakpoint
UPDATE tasks SET closed_by_type = 'agent' WHERE closed_by_type = 'bot';
--> statement-breakpoint
UPDATE tasks SET author_type = 'agent' WHERE author_type = 'bot';
--> statement-breakpoint
UPDATE tasks SET close_suggested_by_type = 'agent' WHERE close_suggested_by_type = 'bot';
--> statement-breakpoint
UPDATE links SET target_text = 'agent:' || substr(target_text, 5) WHERE target_text LIKE 'bot:%';
--> statement-breakpoint
UPDATE links SET metadata = json_set(metadata, '$.gone', 'agent') WHERE json_valid(metadata) AND json_extract(metadata, '$.gone') = 'bot';
--> statement-breakpoint
UPDATE record_relations SET target_external_id = 'agent:' || substr(target_external_id, 5) WHERE target_type = 'ref' AND target_external_id LIKE 'bot:%';
--> statement-breakpoint
UPDATE proposed_actions SET payload = json_set(payload, '$.from', 'agent:' || substr(json_extract(payload, '$.from'), 5)) WHERE json_valid(payload) AND json_type(payload, '$.from') = 'text' AND json_extract(payload, '$.from') LIKE 'bot:%';
--> statement-breakpoint
UPDATE proposed_actions SET payload = json_set(payload, '$.to', 'agent:' || substr(json_extract(payload, '$.to'), 5)) WHERE json_valid(payload) AND json_type(payload, '$.to') = 'text' AND json_extract(payload, '$.to') LIKE 'bot:%';
--> statement-breakpoint
UPDATE proposed_actions SET payload = json_set(payload, '$.ref', 'agent:' || substr(json_extract(payload, '$.ref'), 5)) WHERE json_valid(payload) AND json_type(payload, '$.ref') = 'text' AND json_extract(payload, '$.ref') LIKE 'bot:%';
--> statement-breakpoint
UPDATE document_annotation_transfers SET reference_map = (SELECT json_group_object(key, CASE WHEN type = 'text' AND value LIKE 'bot:%' THEN 'agent:' || substr(value, 5) ELSE value END) FROM json_each(document_annotation_transfers.reference_map)) WHERE json_valid(reference_map) AND reference_map LIKE '%"bot:%'
  AND NOT EXISTS (SELECT 1 FROM json_each(document_annotation_transfers.reference_map) WHERE type NOT IN ('text', 'null'));
--> statement-breakpoint
UPDATE mail_sort_effects SET "before" = 'bot:' || substr("before", 12) WHERE "before" LIKE 'sender-bot:%';
--> statement-breakpoint
UPDATE mail_sort_effects SET "after" = 'bot:' || substr("after", 12) WHERE "after" LIKE 'sender-bot:%';
