/**
 * What a person in the store is, for a list that shows the useful ones and keeps the noise apart. `test` is what a
 * test run left, which `all` leaves out too.
 * @experimental
 */
export const PERSON_KINDS = ["person", "organization", "automated", "stranger", "unsorted", "test"] as const
/** @experimental */
export type PersonKind = (typeof PERSON_KINDS)[number]

/** What decided a kind, besides the ties that make someone a `person`. @experimental */
export type KindSignal =
  | "test-data"
  | "bot"
  | "no-reply"
  | "notification-address"
  | "auto-submitted"
  | "null-return-path"
  | "bulk-mail"
  | "bulk-never-replied"
  | "newsletter-only"
  | "automated-name"
  | "organization"
  | "role-address"
  | "company-name"
  | "no-tie"
  | "no-name"

/**
 * A sender bot's reference, `bot:<id>`: a program that writes to the owner, an entity apart from people. The agents of
 * the `bots` table are `agent:<id>` since store version 78. @experimental
 */
export const SENDER_BOT_PREFIX = "bot:"

/** A sender bot's reference before store version 78, still read. @experimental */
export const OLD_SENDER_BOT_PREFIX = "sender-bot:"

/** `sender-bot:<id>` as `bot:<id>`; any other text as it is. @experimental */
export const senderBotRef = (ref: string): string =>
  ref.startsWith(OLD_SENDER_BOT_PREFIX) ? `${SENDER_BOT_PREFIX}${ref.slice(OLD_SENDER_BOT_PREFIX.length)}` : ref

const AUTOMATED_WORDS = new Set([
  "noreply",
  "notification",
  "notifications",
  "newsletter",
  "newsletters",
  "digest",
  "alerts",
  "mailer",
  "robot",
])
const AUTOMATED_STEMS = ["уведомлени", "рассылк", "оповещени", "noreply", "donotreply", "робот"]

const LEGAL_FORMS = new Set(["ооо", "оао", "зао", "пао", "ао", "ип", "llc", "ltd", "limited", "inc", "corp", "gmbh"])
const COMPANY_WORDS = new Set([
  "airlines",
  "airways",
  "bank",
  "банк",
  "hotel",
  "hotels",
  "отель",
  "гостиница",
  "hostel",
  "хостел",
  "апартаменты",
  "team",
  "support",
  "поддержка",
  "service",
  "services",
  "сервис",
  "служба",
  "shop",
  "store",
  "магазин",
  "company",
  "компания",
  "agency",
  "агентство",
  "restaurant",
  "ресторан",
  "clinic",
  "клиника",
  "delivery",
  "доставка",
])

const wordsOf = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((word) => word !== "")

/** A sender that is a program: «Notifications», «Рассылка», «no-reply». */
export const isAutomatedName = (name: string | null): boolean => {
  if (name === null) return false
  return wordsOf(name).some((word) => {
    const bare = word.includes("-") ? word.replaceAll("-", "") : word
    return AUTOMATED_WORDS.has(bare) || AUTOMATED_STEMS.some((stem) => bare.startsWith(stem))
  })
}

/** A legal form or a word only a business calls itself: «ООО Ромашка», «CZECH AIRLINES», «OpenWeather Team». */
export const isCompanyName = (name: string | null): boolean => {
  if (name === null) return false
  return wordsOf(name.replaceAll(".", "")).some((word) => LEGAL_FORMS.has(word) || COMPANY_WORDS.has(word))
}
