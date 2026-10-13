-- A query tree kept in a search — `params.ast` and a ranking's `params.selection` — takes cli-base 0.26's keys:
-- `lower_inclusive`, `upper_inclusive` and the occur `must_not`. A text replace keeps every key in place, so
-- `params` stays the canonical text that history matches on; inside a JSON string these quotes are escaped, so a
-- message's words never match.
UPDATE searches SET params = json_set(params, '$.ast', json(
  replace(replace(replace(json_extract(params, '$.ast'),
    '"lowerInclusive":', '"lower_inclusive":'),
    '"upperInclusive":', '"upper_inclusive":'),
    '"occur":"mustNot"', '"occur":"must_not"')))
WHERE json_type(params, '$.ast') = 'object';--> statement-breakpoint
UPDATE searches SET params = json_set(params, '$.selection', json(
  replace(replace(replace(json_extract(params, '$.selection'),
    '"lowerInclusive":', '"lower_inclusive":'),
    '"upperInclusive":', '"upper_inclusive":'),
    '"occur":"mustNot"', '"occur":"must_not"')))
WHERE json_type(params, '$.selection') = 'object';
