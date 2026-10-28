import { groupKey, probeMail } from "./probe.js"
import type { MailFacts, MailRule } from "./rules.js"
import type { DomainAge } from "./score.js"
import type { Listed } from "./source.js"

/**
 * What a rule can know of each listed email. A score and "the owner wrote to this sender" come from the sender's
 * whole group in this listing, so they are worked out only when a rule needs them; a run that lists only new mail
 * judges them from that mail.
 */
export const factsOf = (
  listed: Listed[],
  rules: readonly MailRule[],
  ages: ReadonlyMap<string, DomainAge> = new Map(),
): ((item: Listed) => MailFacts) => {
  const grouped = rules.some(({ match }) => match.score_at_least !== undefined || match.preset !== undefined)
  if (!grouped) return (item) => item
  const groups = new Map(
    probeMail(listed, Number.POSITIVE_INFINITY, ages).items.map((group) => [
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
