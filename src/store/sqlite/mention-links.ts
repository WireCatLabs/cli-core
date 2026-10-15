import { normalizedValue, trackedOrigin } from "../../domain/mentions.js"
import type { SqlValue } from "../driver.js"

interface Sql {
  sql: string
  params: SqlValue[]
}

const LIVE = "mn.kind = 'url' AND mn.status <> 'dismissed'"
const MAIL_ROWS = `SELECT mn.source_id FROM mentions mn WHERE mn.source_type = 'email' AND ${LIVE}`

/**
 * `url:` (the whole link) and `link:` (a part of one) in a search; `mentioned` turns a condition on `mn` into the
 * items it names. Mail keeps a tracking link only as its site's origin, so there a letter with a row of that origin
 * is also matched by its body, which holds the link as it was sent. The body is read only for those letters.
 */
export const linkMatch = (
  field: "url" | "link",
  typed: string,
  mail: boolean,
  mentioned: (where: string, params: SqlValue[]) => Sql,
): Sql => {
  if (field === "url") {
    const value = normalizedValue(typed)
    const origin = mail ? trackedOrigin(value) : undefined
    if (origin === undefined) return mentioned(`${LIVE} AND mn.value = ?`, [value])
    return {
      sql:
        `m.id IN (${MAIL_ROWS} AND mn.value = ? UNION SELECT e.id FROM emails e WHERE e.id IN ` +
        `(${MAIL_ROWS} AND mn.value = ?) AND (instr(e.body_text, ?) > 0 OR instr(e.body_text, ?) > 0))`,
      params: [value, origin, typed.trim(), value],
    }
  }
  // LIKE ignores ASCII case without copying the body, as lower() would.
  const part = `%${typed.trim().replace(/[\\%_]/g, "\\$&")}%`
  const contains = "LIKE ? ESCAPE '\\'"
  if (!mail) return mentioned(`${LIVE} AND mn.value ${contains}`, [part])
  return {
    sql:
      `m.id IN (${MAIL_ROWS} AND mn.value ${contains} UNION SELECT e.id FROM emails e WHERE e.id IN ` +
      `(${MAIL_ROWS} AND mn.value NOT LIKE '%://%/%') AND e.body_text ${contains})`,
    params: [part, part],
  }
}
