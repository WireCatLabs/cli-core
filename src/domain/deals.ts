import { moneyLabel } from "./money.js"

/** A pipeline holds deals or leads, never both; a deal and a lead are rows of their own tables. */
export const DEAL_KINDS = ["deal", "lead"] as const
/** Whether a deal or a lead ended, kept apart from the stage it stands in. */
export const DEAL_STATUSES = ["open", "won", "lost"] as const
/** What reaching a stage means, as a CRM marks it: still open, or won or lost. */
export const STAGE_OUTCOMES = DEAL_STATUSES
/**
 * The part a person plays on a deal: the owner's side runs it (`owner`, the CRM's "responsible"), the client's side
 * talks, decides or sways the decision.
 */
export const DEAL_ROLES = ["owner", "contact", "decision-maker", "influencer"] as const

export type DealKind = (typeof DEAL_KINDS)[number]
export type DealStatus = (typeof DEAL_STATUSES)[number]
export type StageOutcome = DealStatus
export type DealRole = (typeof DEAL_ROLES)[number]

export interface DealTitleFields {
  id: number
  title: string
  stage: string
  amount: number | null
  currency: string | null
  status: DealStatus
}

/** "Site redesign · Proposal, 500 000.00 RUB (won)": a ref summary's title, which `refLabel` prefixes. */
export const dealLine = (deal: DealTitleFields): string => {
  const money = deal.amount === null || deal.currency === null ? "" : `, ${moneyLabel(deal.amount, deal.currency)}`
  return `${deal.title} · ${deal.stage}${money}${deal.status === "open" ? "" : ` (${deal.status})`}`
}
