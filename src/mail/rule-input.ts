import { momentOf } from "../services/moment.js"
import type { MailAction, MailRule, MailRuleMatch } from "./rules.js"
import { conditionKeys } from "./rules.js"

export const STORE_ACTION: Record<MailAction, string> = { keep: "full", envelope: "envelope", skip: "skip" }

const LOWER: readonly (keyof MailRuleMatch)[] = ["from", "domain", "list_id", "subject"]

const conditionsOf = (match: MailRuleMatch): Record<string, string | number | boolean> =>
  Object.fromEntries(
    conditionKeys(match).map((key) => {
      const value = match[key]
      return [
        key,
        LOWER.includes(key) && typeof value === "string" ? value.toLowerCase() : (value as string | number | boolean),
      ]
    }),
  )

/** When the owner decided: a time without a zone is read in the computer's; an unreadable one is when it is saved. */
const decidedAtOf = (value: string): number => {
  try {
    return momentOf(value, "decided_at")
  } catch {
    return Date.now()
  }
}

export const ruleInput = (rule: MailRule, source = rule.source ?? "owner") => ({
  conditions: conditionsOf(rule.match),
  actions: {
    store: STORE_ACTION[rule.action],
    ...(rule.tags?.length ? { tags: rule.tags } : {}),
    ...(rule.tags_skipped && Object.keys(rule.tags_skipped).length ? { tags_skipped: rule.tags_skipped } : {}),
  },
  protected: rule.protected === true,
  source,
  reason: rule.reason ?? null,
  decidedAt: decidedAtOf(rule.decided_at),
})
