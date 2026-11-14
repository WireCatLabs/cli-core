import { groupKey, probeMail } from "./probe.js"
import type { MailFacts, MailRule } from "./rules.js"
import type { DomainAge } from "./score.js"
import type { Listed } from "./source.js"

/** Of these addresses, the ones the owner wrote to in mail the store holds: `store.mail.writtenTo`. */
export type WrittenTo = (addresses: readonly string[]) => Promise<ReadonlySet<string>>

/**
 * What a rule can know of each listed email. A score and "the owner wrote to this sender" come from the sender's
 * whole group in this listing, so they are worked out only when a rule needs them; a run that lists only new mail
 * judges the score from that mail. "Wrote to" also reads the stored outgoing mail, so a resumed run or an account
 * synced without Sent still knows a correspondent.
 */
export const factsOf = async (
  listed: Listed[],
  rules: readonly MailRule[],
  writtenTo: WrittenTo,
  ages: ReadonlyMap<string, DomainAge> = new Map(),
): Promise<(item: Listed) => MailFacts> => {
  const grouped = rules.some(({ match }) => match.score_at_least !== undefined || match.preset !== undefined)
  if (!grouped) return (item) => item
  const senders = [...new Set(listed.flatMap((item) => item.headers?.from ?? []))]
  const written = await writtenTo(senders)
  const groups = new Map(
    probeMail(listed, Number.POSITIVE_INFINITY, ages, written).items.map((group) => [
      groupKey({
        ...(group.from === null ? {} : { from: group.from }),
        ...(group.listId === null ? {} : { listId: group.listId }),
      }),
      group,
    ]),
  )
  return (item) => {
    const group = item.headers === undefined ? undefined : groups.get(groupKey(item.headers))
    return group === undefined ? item : { ...item, score: group.score, replied: group.replied }
  }
}
