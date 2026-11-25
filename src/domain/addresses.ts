/** One reading of an email address everywhere a person is matched by one: a local part, an `@` and a dotted domain. */
export const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/** Whether a lower-cased, trimmed value is an email address. */
export const isEmailAddress = (value: string): boolean => EMAIL_ADDRESS.test(value)

/** Local parts that name a mailbox, not a person; the no-reply family names no one at all. @experimental */
export const ROLE_ADDRESS_WORDS = {
  noReply: ["noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "bounce", "bounces"],
  shared: [
    "info",
    "hello",
    "hi",
    "contact",
    "contacts",
    "support",
    "help",
    "helpdesk",
    "service",
    "sales",
    "office",
    "admin",
    "team",
    "billing",
    "accounts",
    "accounting",
    "invoices",
    "finance",
    "hr",
    "jobs",
    "careers",
    "press",
    "media",
    "marketing",
    "partners",
    "legal",
    "privacy",
    "security",
    "abuse",
    "postmaster",
    "webmaster",
    "mail",
    "inbox",
    "enquiries",
    "inquiries",
    "booking",
    "reservations",
    "orders",
    "feedback",
    "newsletter",
    "notifications",
    "alerts",
  ],
} as const

const bare = (word: string): string => word.replace(/[.\-_]/gu, "")

const NO_REPLY = new Set(ROLE_ADDRESS_WORDS.noReply.map(bare))
const ROLE = new Set([...ROLE_ADDRESS_WORDS.shared, ...ROLE_ADDRESS_WORDS.noReply].map(bare))
/** Words people's names start with too (`bouncer.joe@`), so they count only as a whole part of the address. */
const PART_ONLY = new Set(["bounce", "bounces"])
const NOTIFY = new Set(["notify", "notification", "notifications", "alert", "alerts"])

const localPart = (address: string): string => {
  const local = address.trim().toLowerCase().split("@")[0] ?? ""
  return local.split("+")[0] ?? ""
}

const localWord = (address: string): string => bare(localPart(address))

const SEPARATORS = /[.\-_]/u
const partsOf = (address: string): string[] => localPart(address).split(SEPARATORS)
const NO_REPLY_PARTS = ROLE_ADDRESS_WORDS.noReply.map((word) => `.${word.split(SEPARATORS).join(".")}.`)

/**
 * Whether the address is a no-reply one, which belongs to no person: `noreply-12345@`, `service.no-reply@`.
 * @experimental
 */
export const isNoReplyAddress = (address: string): boolean => {
  const word = localWord(address)
  const parts = `.${partsOf(address).join(".")}.`
  if (NO_REPLY_PARTS.some((one) => parts.includes(one))) return true
  return [...NO_REPLY].some((one) => !PART_ONLY.has(one) && (word.startsWith(one) || word.endsWith(one)))
}

/**
 * Whether the whole local part, `+tag` and `.`/`-`/`_` aside, is a role word (`info@`, `Hello+news@`, `no_reply@`),
 * or the address is a no-reply one.
 * @experimental
 */
export const isRoleAddress = (address: string): boolean => ROLE.has(localWord(address)) || isNoReplyAddress(address)

/**
 * Role words that one person often reads alone: a small company's `hr@` is its HR manager. Still a role address, so it
 * joins no one, but weaker evidence of a company's mailbox than `info@`, and it never makes a contact a company.
 */
const PERSON_LIKE = new Set(["hr"])

/** Whether the address is a role address that one person often reads alone, such as `hr@`. */
export const isPersonLikeRoleAddress = (address: string): boolean => PERSON_LIKE.has(localWord(address))

/** Whether a program sends from the address: `notify@`, `alerts@`, `bank-notifications@`. @experimental */
export const isNotificationAddress = (address: string): boolean => partsOf(address).some((part) => NOTIFY.has(part))
