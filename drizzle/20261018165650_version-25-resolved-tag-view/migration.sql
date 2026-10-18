CREATE VIEW resolved_tags AS
SELECT original.id,canonical.name,canonical.kind,canonical.id AS canonical_id,original.created_at,original.updated_at
FROM canonical_tags original
LEFT JOIN tag_redirects r ON r.source_id=original.id
JOIN canonical_tags canonical ON canonical.id=coalesce(r.survivor_id,original.id);
