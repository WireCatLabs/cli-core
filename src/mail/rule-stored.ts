import { CliError } from "@wirecat/cli-base"
import type { QueryAst } from "@wirecat/cli-base/query"
import type { MessageStore, MailRule as StoredRule } from "../store/index.js"
import { PRESET_NAMES, type PresetName } from "./presets.js"
import type { MailAction, MailRule, MailRuleMatch } from "./rules.js"

const ACTION_OF: Record<string, MailAction> = { full: "keep", envelope: "envelope", skip: "skip" }

const KINDS: Record<keyof MailRuleMatch, "string" | "number" | "boolean"> = {
  from: "string",
  from_contains: "string",
  domain: "string",
  to: "string",
  list_id: "string",
  subject: "string",
  older_than_days: "number",
  larger_than_bytes: "number",
  has_attachments: "boolean",
  label: "string",
  unread: "boolean",
  bulk: "boolean",
  score_at_least: "number",
  preset: "string",
}

/** A stored rule as the sync reads it; `undefined` for one this build cannot read, so it is left to the build that can. */
export const storedMailRule = (stored: StoredRule): MailRule | undefined => {
  const action = ACTION_OF[String(stored.actions.store)]
  const entries = Object.entries(stored.conditions as Record<string, unknown>)
  const known = entries.every(
    ([key, value]) =>
      key in KINDS &&
      typeof value === KINDS[key as keyof MailRuleMatch] &&
      !(key === "preset" && !PRESET_NAMES.includes(value as PresetName)),
  )
  if (action === undefined || !known || entries.length === 0) return undefined
  const tags = Array.isArray(stored.actions.tags) ? stored.actions.tags.filter((tag) => typeof tag === "string") : []
  const skipped = stored.actions.tags_skipped
  const tagsSkipped =
    skipped !== null && typeof skipped === "object" && !Array.isArray(skipped)
      ? Object.fromEntries(Object.entries(skipped).filter(([, why]) => typeof why === "string"))
      : {}
  return {
    id: stored.id,
    match: Object.fromEntries(entries) as MailRuleMatch,
    action,
    ...(tags.length ? { tags: tags as string[] } : {}),
    ...(Object.keys(tagsSkipped).length ? { tags_skipped: tagsSkipped as Record<string, string> } : {}),
    ...(stored.reason === null ? {} : { reason: stored.reason }),
    ...(stored.protected ? { protected: true } : {}),
    ...(stored.source === "owner" ? {} : { source: stored.source }),
    decided_at: new Date(stored.decidedAt).toISOString(),
  }
}

/** One account's rules from the store, for `account.rules` of the sync; none when the store has not seen the account. */
export const storedMailRules = async (
  store: MessageStore,
  account: { address: string },
  query?: QueryAst,
): Promise<MailRule[]> => {
  try {
    const { id } = await store.accounts.storedAccount({ provider: "email", account: account.address.toLowerCase() })
    return (await store.mail.rules.list(id, query)).flatMap((stored) => storedMailRule(stored) ?? [])
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") return []
    throw error
  }
}
