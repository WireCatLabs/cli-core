import type { MessageStore, Subscription, SubscriptionPrice } from "../../../store/index.js"
import type { ProposalKind, ProposalRow } from "../types.js"
import { proposerOfAuthor, reviewedKind, reviewedRow } from "./shared.js"

/** An agent's or an import's subscription, by its own ref (`subscription:12`); only the owner decides it. */
export const subscriptionKind = (store: Pick<MessageStore, "subscriptions">): ProposalKind =>
  reviewedKind<Subscription>({
    kind: "subscription",
    prefix: "subscription",
    list: (options) => store.subscriptions.list(options),
    get: (id) => store.subscriptions.get(id),
    row: (subscription) =>
      reviewedRow(
        "subscription",
        subscription,
        (subscription.direction === "receivable" ? subscription.customer : subscription.supplier).ref,
      ),
    decide: async (id, confirm, { by, reason }) =>
      (confirm ? await store.subscriptions.confirm(id, by, reason) : await store.subscriptions.reject(id, by, reason))
        .ref,
  })

const priceRow = (price: SubscriptionPrice): ProposalRow => ({
  id: price.id,
  kind: "subscription_price",
  status: price.review,
  project: null,
  subject: price.subscription,
  object: null,
  summary: `Price of ${price.subscription}: ${price.amount} ${price.currency} from ${price.effectiveFrom}`,
  proposedBy: proposerOfAuthor(price.author),
  reason: price.reason,
  evidence: [],
  score: null,
  signals: null,
  parts: null,
  createdAt: price.createdAt,
})

/**
 * A new price of a subscription (`subscription_price:7`): a proposal of its own, so a confirmed subscription stays
 * confirmed while its next price waits.
 */
export const subscriptionPriceKind = (store: Pick<MessageStore, "subscriptions">): ProposalKind =>
  reviewedKind<SubscriptionPrice>({
    kind: "subscription_price",
    prefix: "subscription_price",
    list: ({ review, proposedBy, limit }) => store.subscriptions.prices({ review, proposedBy, limit }),
    get: (id) => store.subscriptions.price(id),
    row: priceRow,
    decide: async (id, confirm, { by, reason }) => {
      await (confirm ? store.subscriptions.confirm(id, by, reason) : store.subscriptions.reject(id, by, reason))
      return id
    },
  })
