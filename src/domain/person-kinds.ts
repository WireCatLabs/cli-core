/** What a person in the store is, for a list that shows the useful ones and keeps the noise apart. */
export const PERSON_KINDS = ["person", "organization", "automated", "unsorted"] as const
export type PersonKind = (typeof PERSON_KINDS)[number]

/** What decided a kind, besides the ties that make someone a `person`. */
export type KindSignal =
  | "bot"
  | "no-reply"
  | "bulk-mail"
  | "bulk-never-replied"
  | "automated-name"
  | "organization"
  | "role-address"
  | "company-name"
  | "no-tie"
  | "no-name"

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
