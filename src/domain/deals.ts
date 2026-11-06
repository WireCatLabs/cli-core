import type { FinanceReview } from "./finance.js"
import { moneyLabel } from "./money.js"

/** Whether a deal ended, kept apart from the stage it stands in. */
export const DEAL_STATUSES = ["open", "won", "lost"] as const
/** The part a person plays on a deal: the owner's side runs it, the client's side talks or decides. */
export const DEAL_ROLES = ["owner", "contact", "decision-maker"] as const

export type DealStatus = (typeof DEAL_STATUSES)[number]
export type DealRole = (typeof DEAL_ROLES)[number]

export interface DealTitleFields {
  id: number
  title: string
  stage: string
  amount: number | null
  currency: string | null
  status: DealStatus
  review: FinanceReview
}

/** "Site redesign · Proposal, 500 000.00 RUB": a ref summary's title, which `refLabel` prefixes. */
export const dealLine = (deal: DealTitleFields): string => {
  const money = deal.amount === null || deal.currency === null ? "" : `, ${moneyLabel(deal.amount, deal.currency)}`
  const notes = [deal.status === "open" ? null : deal.status, deal.review === "confirmed" ? null : deal.review]
    .filter(Boolean)
    .join(", ")
  return `${deal.title} · ${deal.stage}${money}${notes ? ` (${notes})` : ""}`
}

/** "Deal Site redesign · Proposal, 500 000.00 RUB (won)". */
export const dealTitle = (deal: DealTitleFields): string => `Deal ${dealLine(deal)}`
