import { documentAccountProvidersSql } from "../../domain/providers.js"
import { PREFERRED_FILE } from "./files.js"

// Rendered per query: a documents provider joins the registry when its CLI opens the store, after this module loads.
// A document's preferred file holds its link and edit time; rows without one keep them in front matter.
const remote = () =>
  `CASE WHEN json_valid(n.front_matter) THEN json_extract(n.front_matter,'$.source') IN (${documentAccountProvidersSql()}) ELSE 0 END`
const field = (name: "modifiedAt" | "sourceUrl") => `CASE WHEN (${remote()}) THEN
  CASE WHEN json_type(n.front_matter,'$.${name}')='text' THEN json_extract(n.front_matter,'$.${name}') END END`
const preferred = (column: "url" | "external_updated_at") =>
  `(SELECT f.${column} FROM files f JOIN documents d ON d.id = f.document_id WHERE f.document_id = n.id
    ORDER BY ${PREFERRED_FILE} LIMIT 1)`
const modified = () => `round(unixepoch(${field("modifiedAt")},'subsec')*1000)`
const remoteTime = () => `coalesce(${preferred("external_updated_at")},n.external_updated_at,${modified()})`
export const contextDocumentTime = () => `coalesce(${remoteTime()},n.updated_at)`
export const contextDocumentTimeKind = () => `CASE WHEN (${remoteTime()}) IS NOT NULL
  THEN 'source-modified' ELSE 'stored-update' END`
export const contextDocumentUrl = () => `coalesce(${preferred("url")},n.url,${field("sourceUrl")})`
