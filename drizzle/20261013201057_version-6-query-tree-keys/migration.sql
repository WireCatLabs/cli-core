-- A query tree kept in a search's `params.ast` takes the keys MCP now accepts: `lower_inclusive`,
-- `upper_inclusive` and the occur `must_not`. Only `ast` is touched: a ranking `selection` keeps the parser's own
-- tree. A text replace keeps every key in place, so `params` stays the canonical text that history matches on;
-- inside a JSON string these quotes are escaped, so a message's words never match.
UPDATE searches SET params = json_set(params, '$.ast', json(
  replace(replace(replace(json_extract(params, '$.ast'),
    '"lowerInclusive":', '"lower_inclusive":'),
    '"upperInclusive":', '"upper_inclusive":'),
    '"occur":"mustNot"', '"occur":"must_not"')))
WHERE json_type(params, '$.ast') = 'object';
