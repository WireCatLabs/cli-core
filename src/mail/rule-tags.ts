import type { AccountKey, MessageStore } from "../store/index.js"
import { ruleInput } from "./rule-input.js"
import type { MailRule } from "./rules.js"

type MessageRef = { type: "message"; chatId: string; messageId: string }

export interface TagOutcome {
  /** A rule's tag the store refused as too close to an existing label, put on mail as that label instead. */
  reused: { tag: string; as: string }[]
  /** A rule's tag the store refused with nothing to reuse: the mail is stored, untagged. */
  skipped: { tag: string; reason: string; emails: number }[]
}

interface Refusal {
  details?: { reason?: string; candidates?: { name: string }[] }
  message?: string
}

const reuseOf = (error: unknown): string | undefined => {
  const { details } = error as Refusal
  return details?.reason === "tag-review.required" ? details.candidates?.[0]?.name : undefined
}

/**
 * Tags mail for confirmed rules. A label the store refuses never fails the import: the label it points to is
 * reused, and a tag with nothing to reuse is skipped and counted.
 */
export const ruleTagger = (store: MessageStore, key: AccountKey) => {
  const resolved = new Map<string, string | null>()
  const reasons = new Map<string, string>()
  const skippedEmails = new Map<string, number>()

  const add = async (ref: MessageRef, tag: string): Promise<void> => {
    const known = resolved.get(tag)
    if (known === null) {
      skippedEmails.set(tag, (skippedEmails.get(tag) ?? 0) + 1)
      return
    }
    const name = known ?? tag
    try {
      await store.tags.addTags(key, ref, [name])
      if (known === undefined) resolved.set(tag, name)
    } catch (error) {
      const reuse = known === undefined ? reuseOf(error) : undefined
      if (reuse !== undefined) {
        resolved.set(tag, reuse)
        return add(ref, tag)
      }
      resolved.set(tag, null)
      reasons.set(tag, (error as Refusal).message ?? String(error))
      skippedEmails.set(tag, (skippedEmails.get(tag) ?? 0) + 1)
    }
  }

  return {
    tag: async (ref: MessageRef, tags: readonly string[]) => {
      for (const tag of tags) await add(ref, tag)
    },
    outcome: (): TagOutcome => ({
      reused: [...resolved].flatMap(([tag, as]) => (as !== null && as !== tag ? [{ tag, as }] : [])),
      skipped: [...reasons].map(([tag, reason]) => ({ tag, reason, emails: skippedEmails.get(tag) ?? 0 })),
    }),
  }
}

/** Writes what a run learned back into the rules, so the next run tags with the reused label and skips the rest. */
export const settleRuleTags = async (
  store: MessageStore,
  accountId: number,
  rules: readonly MailRule[],
  outcome: TagOutcome,
): Promise<void> => {
  if (outcome.reused.length === 0 && outcome.skipped.length === 0) return
  const as = new Map(outcome.reused.map(({ tag, as }) => [tag, as]))
  const skipped = new Map(outcome.skipped.map(({ tag, reason }) => [tag, reason]))
  for (const rule of rules) {
    if (rule.id === undefined || !rule.tags?.some((tag) => as.has(tag) || skipped.has(tag))) continue
    const tags = [...new Set(rule.tags.filter((tag) => !skipped.has(tag)).map((tag) => as.get(tag) ?? tag))]
    const tagsSkipped: Record<string, string> = { ...rule.tags_skipped }
    for (const tag of rule.tags) {
      const why = skipped.get(tag)
      if (why !== undefined) tagsSkipped[tag] = why
    }
    await store.mail.rules.upsert(accountId, ruleInput({ ...rule, tags, tags_skipped: tagsSkipped }), Date.now())
  }
}

/** Proposed tags matched to labels that already exist, before any is created: `reuse` exact, `similar` closest. */
export const mapProposedTags = async (
  store: MessageStore,
  rules: readonly MailRule[],
): Promise<{ rules: MailRule[]; mapping: { tag: string; as: string; why: "reuse" | "similar" }[] }> => {
  const mapping: { tag: string; as: string; why: "reuse" | "similar" }[] = []
  for (const tag of new Set(rules.flatMap(({ tags }) => tags ?? []))) {
    const plan = await store.knowledge.tagPreflight(tag).catch(() => undefined)
    const as =
      plan?.disposition === "reuse"
        ? plan.existing?.name
        : plan?.disposition === "review"
          ? plan.suggestions[0]?.entry.name
          : undefined
    if (as !== undefined && as !== tag)
      mapping.push({ tag, as, why: plan?.disposition === "reuse" ? "reuse" : "similar" })
  }
  if (mapping.length === 0) return { rules: [...rules], mapping }
  const as = new Map(mapping.map(({ tag, as }) => [tag, as]))
  return {
    rules: rules.map((rule) =>
      rule.tags?.length ? { ...rule, tags: [...new Set(rule.tags.map((tag) => as.get(tag) ?? tag))] } : rule,
    ),
    mapping,
  }
}
