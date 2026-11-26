import { CliError } from "@wirecat/cli-base"
import type { MailType } from "../../mail/mail-types.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { typeWhere } from "./email-types.js"

/**
 * What a bot sends, as the Bots tab filters it: the mail types that put a bot under each name. `messenger` is a bot
 * with an account in a messenger, whatever it sends. @experimental
 */
export const BOT_SENDS = {
  alerts: ["security", "system_alert", "account_notice"],
  receipts: ["order", "bill", "shipping"],
  newsletters: ["newsletter"],
  marketing: ["promotion"],
  messenger: null,
} as const satisfies Record<string, readonly MailType[] | null>
/** @experimental */
export type BotSends = keyof typeof BOT_SENDS

/** Which bots send any of these, over `b`: by the type of their mail, or a messenger account. */
export const sendsWhere = (
  database: CacheDatabase,
  sends: readonly BotSends[],
): { sql: string; params: SqlValue[] } => {
  const unknown = sends.filter((name) => !Object.hasOwn(BOT_SENDS, name))
  if (unknown.length > 0 || sends.length === 0)
    throw new CliError(
      "validation_error",
      `a bot sends one of ${Object.keys(BOT_SENDS).join(", ")}, got "${unknown.join(", ")}"`,
      { reason: "sender-bot.unknown-sends" },
    )
  const types = [...new Set(sends.flatMap((name) => BOT_SENDS[name] ?? []))]
  const typed = types.length === 0 ? undefined : typeWhere(database, { types })
  const any = [
    ...(typed === undefined
      ? []
      : [
          "EXISTS (SELECT 1 FROM sender_bot_identities s JOIN emails e ON e.from_identity_id = s.identity_id " +
            `WHERE s.bot_id = b.id AND e.deleted_at IS NULL AND e.outgoing IS NOT 1 AND ${typed.sql.join(" AND ")})`,
        ]),
    ...(sends.includes("messenger")
      ? [
          "EXISTS (SELECT 1 FROM sender_bot_identities s JOIN identities i ON i.id = s.identity_id " +
            "WHERE s.bot_id = b.id AND i.provider <> 'email')",
        ]
      : []),
  ]
  return { sql: `(${any.join(" OR ")})`, params: typed?.params ?? [] }
}
