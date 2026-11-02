import type { CacheDatabase } from "../driver.js"
import { botNamed } from "./actors.js"
import { linkOf } from "./notes.js"
import { write } from "./transaction.js"

/** Set by store version 44 and deleted once the move ran. */
export const SUGGESTED_LINKS_TO_MOVE = "suggested_links_to_move"

/**
 * An agent's `agent:<bot>` or a rule's `rule:<id>` suggestion. A rule becomes the seeded bot `rule`, since the text
 * does not say which tool ran it; anything else (Drive's editor links) is a record, not a proposal, and stays.
 */
const proposerOf = (provenance: string | null): { name: string; kind: "agent" | "rule" } | undefined => {
  if (provenance?.startsWith("rule:")) return { name: "rule", kind: "rule" }
  if (!provenance?.startsWith("agent:")) return undefined
  const name = provenance.slice("agent:".length).split(/[\s;]/, 1)[0] ?? ""
  return { name: name && name.length <= 100 ? name : "agent", kind: "agent" }
}

/**
 * Moves the unconfirmed agent and rule links into `proposed_actions` as `relationship` and `key_document`
 * proposals, with their bot, reason and time, so `links` holds what the owner confirmed. The moved row keeps the
 * link's provenance under `suggestedLink`, which marks its proposer unverified: only the owner decides it. A
 * suggestion an older build writes later stays a link, and the proposal kinds still list it.
 */
export const moveSuggestedLinks = (database: CacheDatabase, now: () => number): number => {
  if (!database.prepare("SELECT 1 AS found FROM store_settings WHERE key = ?").get(SUGGESTED_LINKS_TO_MOVE)) return 0
  return write(database, () => {
    const rows = database
      .prepare(
        "SELECT * FROM links WHERE confirmed = 0 AND to_id IS NOT NULL AND kind IN ('member-of', 'related-to') ORDER BY id",
      )
      .all()
    const at = now()
    let moved = 0
    for (const row of rows) {
      const link = linkOf(database, row)
      const proposer = proposerOf(link.provenance)
      const key = link.role === "key"
      if (!proposer || !link.from || !link.to || (key && !link.to.startsWith("project:"))) continue
      const kind = key ? "key_document" : "relationship"
      const held = database
        .prepare(
          "SELECT id FROM proposed_actions WHERE kind = ? AND status = 'proposed' AND target_type = ? AND target_id = ? " +
            "AND json_extract(payload, ?) = ?",
        )
        .get(kind, row.from_type as string, row.from_id as number, key ? "$.project" : "$.to", link.to)
      if (!held) {
        const bot = botNamed(database, proposer.name, at, proposer.kind)
        const suggestedLink = { id: link.id, provenance: link.provenance }
        const payload = key
          ? { ref: link.from, project: link.to, suggestedLink }
          : {
              from: link.from,
              to: link.to,
              kind: link.kind,
              ...(link.role === null ? {} : { role: link.role }),
              evidence: [],
              suggestedLink,
            }
        database
          .prepare(
            "INSERT INTO proposed_actions (kind, target_type, target_id, payload, reason, status, proposed_by_type, " +
              "proposed_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)",
          )
          .run(
            kind,
            row.from_type as string,
            row.from_id as number,
            JSON.stringify(payload),
            link.evidence,
            bot.type,
            bot.id,
            row.created_at as number,
            at,
          )
      }
      database.prepare("DELETE FROM links WHERE id = ?").run(Number(row.id))
      moved += 1
    }
    database.prepare("DELETE FROM store_settings WHERE key = ?").run(SUGGESTED_LINKS_TO_MOVE)
    return moved
  })
}
