import type { JsonValue } from "../../meetings/index.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { write } from "./transaction.js"

type Row = Record<string, unknown>
type JsonObject = { [key: string]: JsonValue }

/** A rule to save. The store keeps `conditions` and `actions` as they are given; the caller decides their shape. */
export interface MailRuleInput {
  /** All must match. Two rules with the same conditions, in any key order, are the same rule. */
  conditions: JsonObject
  /** What to do with a match: `store` (`full`, `envelope`, `skip`), `tags`. */
  actions: JsonObject
  /** No cleanup may cut, archive or trash what a protected rule matches. */
  protected?: boolean
  /** `owner`, `preset:<name>`, `probe`, `gmail-filter`. */
  source: string
  reason?: string | null
  decidedAt: number
}

export interface MailRule {
  id: number
  accountId: number
  conditions: JsonObject
  actions: JsonObject
  protected: boolean
  source: string
  reason: string | null
  decidedAt: number
  createdAt: number
  updatedAt: number
}

/** The live emails one rule decided, and their size at the source. */
export interface MailRuleCount {
  ruleId: number
  emails: number
  bytes: number
}

export interface MailRulesStore {
  /** Oldest first. */
  list(accountId: number): Promise<MailRule[]>
  /** A rule with the same conditions is replaced, and keeps its id and the emails it decided. */
  upsert(accountId: number, rule: MailRuleInput, now: number): Promise<MailRule>
  /** Clears the rule from the emails it decided. Answers false when no rule has these conditions. */
  remove(accountId: number, conditions: JsonObject): Promise<boolean>
  /** Every rule's live emails and bytes in one query; a rule that decided none is left out. */
  counts(accountId: number): Promise<MailRuleCount[]>
  /** Records which rule decided these emails, by Message-ID; `null` clears it. Answers how many changed. */
  assign(accountId: number, ruleId: number | null, externalIds: string[], now: number): Promise<number>
}

const sorted = (value: JsonValue): JsonValue =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key] as JsonValue)]),
        )
      : value

/** The conditions as stored: keys sorted, so the unique key does not depend on the order they were written in. */
export const conditionsKey = (conditions: JsonObject): string => JSON.stringify(sorted(conditions))

const ruleOf = (row: Row): MailRule => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  conditions: JSON.parse(String(row.conditions)),
  actions: JSON.parse(String(row.actions)),
  protected: Number(row.protected) === 1,
  source: String(row.source),
  reason: row.reason === null ? null : String(row.reason),
  decidedAt: Number(row.decided_at),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

// SQLite allows 32766 parameters; two are taken by the account and the rule.
const CHUNK = 30_000

export const mailRulesOver = (database: CacheDatabase): MailRulesStore => ({
  async list(accountId) {
    return database.prepare("SELECT * FROM mail_rules WHERE account_id = ? ORDER BY id").all(accountId).map(ruleOf)
  },
  async upsert(accountId, rule, now) {
    const row = database
      .prepare(
        `INSERT INTO mail_rules
           (account_id, conditions, actions, protected, source, reason, decided_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, conditions) DO UPDATE SET actions = excluded.actions,
             protected = excluded.protected, source = excluded.source, reason = excluded.reason,
             decided_at = excluded.decided_at, updated_at = excluded.updated_at
           RETURNING *`,
      )
      .get(
        accountId,
        conditionsKey(rule.conditions),
        JSON.stringify(sorted(rule.actions)),
        rule.protected ? 1 : 0,
        rule.source,
        rule.reason ?? null,
        rule.decidedAt,
        now,
        now,
      )
    return ruleOf(row as Row)
  },
  async remove(accountId, conditions) {
    return write(database, () => {
      const found = database
        .prepare("SELECT id FROM mail_rules WHERE account_id = ? AND conditions = ?")
        .get(accountId, conditionsKey(conditions))
      if (!found) return false
      database.prepare("UPDATE emails SET mail_rule_id = NULL WHERE mail_rule_id = ?").run(Number(found.id))
      database.prepare("DELETE FROM mail_rules WHERE id = ?").run(Number(found.id))
      return true
    })
  },
  async counts(accountId) {
    return database
      .prepare(
        `SELECT e.mail_rule_id AS rule, count(*) AS emails, coalesce(sum(e.size), 0) AS bytes
           FROM emails e JOIN mail_rules r ON r.id = e.mail_rule_id
           WHERE r.account_id = ? AND e.mail_rule_id IS NOT NULL AND e.deleted_at IS NULL
           GROUP BY e.mail_rule_id ORDER BY e.mail_rule_id`,
      )
      .all(accountId)
      .map((row) => ({ ruleId: Number(row.rule), emails: Number(row.emails), bytes: Number(row.bytes) }))
  },
  async assign(accountId, ruleId, externalIds, now) {
    return write(database, () => {
      if (
        ruleId !== null &&
        !database.prepare("SELECT 1 FROM mail_rules WHERE id = ? AND account_id = ?").get(ruleId, accountId)
      )
        throw new Error(`Mail rule ${ruleId} is not a rule of account ${accountId}`)
      let changed = 0
      for (let start = 0; start < externalIds.length; start += CHUNK) {
        const ids = externalIds.slice(start, start + CHUNK)
        const params: SqlValue[] = [ruleId, now, accountId, ...ids]
        changed += database
          .prepare(
            `UPDATE emails SET mail_rule_id = ?, updated_at = ?
               WHERE account_id = ? AND external_id IN (${ids.map(() => "?").join(", ")})`,
          )
          .run(...params).changes
      }
      return changed
    })
  },
})
