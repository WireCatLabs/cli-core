import type { MessageStore, Subscription, SubscriptionPrice } from "../../../store/index.js"
import type { ProposalKind } from "../types.js"
import { reviewedKind, reviewedRow } from "./shared.js"

/** An agent's or an import's subscription, by its own ref (`subscription:12`); only the owner decides it. */
export const subscriptionKind = (store: Pick<MessageStore, "subscriptions">): ProposalKind =>
  reviewedKind<Subscription>({
    type: "subscription",
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

/**
 * A new price of a subscription (`subscription_price:7`): a proposal of its own, so a confirmed subscription stays
 * confirmed while its next price waits.
 */
export const subscriptionPriceKind = (store: Pick<MessageStore, "subscriptions">): ProposalKind =>
  reviewedKind<SubscriptionPrice>({
    type: "subscription_price",
    list: ({ review, proposedBy, limit }) => store.subscriptions.prices({ review, proposedBy, limit }),
    get: (id) => store.subscriptions.price(id),
    row: (price) => reviewedRow("subscription_price", price, price.subscription),
    decide: async (id, confirm, { by, reason }) => {
      await (confirm ? store.subscriptions.confirm(id, by, reason) : store.subscriptions.reject(id, by, reason))
      return id
    },
  })
