// Existing Drive file-note imports keep this provenance in front matter; never hydrate the whole blob.
const drive =
  "CASE WHEN json_valid(n.front_matter) THEN json_extract(n.front_matter,'$.source')='google-drive' ELSE 0 END"
const field = (name: "modifiedAt" | "sourceUrl") => `CASE WHEN (${drive}) THEN
  CASE WHEN json_type(n.front_matter,'$.${name}')='text' THEN json_extract(n.front_matter,'$.${name}') END END`
const modified = `round(unixepoch(${field("modifiedAt")},'subsec')*1000)`
export const contextDocumentTime = `coalesce(n.external_updated_at,${modified},n.updated_at)`
export const contextDocumentTimeKind = `CASE WHEN n.external_updated_at IS NOT NULL OR (${modified}) IS NOT NULL
  THEN 'source-modified' ELSE 'stored-update' END`
export const contextDocumentUrl = `coalesce(n.url,${field("sourceUrl")})`
