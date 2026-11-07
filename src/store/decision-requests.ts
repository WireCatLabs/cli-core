export const DECISION_ACTIONS = ["confirm", "reject", "ask-confirm", "ask-reject", "back", "later"] as const
export type DecisionAction = (typeof DECISION_ACTIONS)[number]

/** Seventy-two hours: a press after that finds nothing to take. */
export const DECISION_TTL_MS = 72 * 60 * 60 * 1000

export const CALLBACK_PREFIX = "wcr1:"

// 16 random bytes in base64url are 22 characters, and the last one carries 2 data bits: only these four can end a token.
const TOKEN = /^[A-Za-z0-9_-]{21}[AQgw]$/
const CALLBACK = /^wcr1:([A-Za-z0-9_-]{21}[AQgw])$/

export const isDecisionToken = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value)

/** The 27 bytes a button carries: Telegram allows 64. */
export const callbackDataOf = (token: string): string => {
  if (!isDecisionToken(token)) throw new TypeError("not a decision token")
  return `${CALLBACK_PREFIX}${token}`
}

/** The token in a button's data, or `undefined` for anything else; the data is only ever looked up, never read further. */
export const parseCallbackData = (data: unknown): string | undefined =>
  typeof data === "string" ? CALLBACK.exec(data)?.[1] : undefined
