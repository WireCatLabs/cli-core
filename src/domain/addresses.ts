/** One reading of an email address everywhere a person is matched by one: a local part, an `@` and a dotted domain. */
export const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/** Whether a lower-cased, trimmed value is an email address. */
export const isEmailAddress = (value: string): boolean => EMAIL_ADDRESS.test(value)

/** Local parts that name a mailbox, not a person; the no-reply family names no one at all. */
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

const localWord = (address: string): string => {
  const local = address.trim().toLowerCase().split("@")[0] ?? ""
  return bare(local.split("+")[0] ?? "")
}

/** Whether the whole local part, `+tag` and `.`/`-`/`_` aside, is a role word: `info@`, `Hello+news@`, `no_reply@`. */
export const isRoleAddress = (address: string): boolean => ROLE.has(localWord(address))

/** Whether the address is a no-reply one, which belongs to no person. */
export const isNoReplyAddress = (address: string): boolean => NO_REPLY.has(localWord(address))
