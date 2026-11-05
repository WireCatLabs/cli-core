/**
 * Mail sent to many is often an order, an invoice or a site's lead form that carries List-Unsubscribe. This tells a
 * newsletter from it by words in the subject and the first lines, so a holder can leave out only what is surely a
 * newsletter and give the rest to its agent as an excerpt. No model: it runs on every read past a mark.
 */

/** Words that say "advertising"; each matches at the start of a word, any case. */
export const NEWSLETTER_WORDS = [
  "скидк",
  "акци",
  "распродаж",
  "вебинар",
  "рассылк",
  "промокод",
  "спецпредложени",
  "дайджест",
  "новинк",
  "подборк",
  "кешбэк",
  "кэшбэк",
  "только сегодня",
  "успейте",
  "чёрная пятница",
  "черная пятница",
  "выгодн",
  "newsletter",
  "unsubscribe",
  "% off",
  "sale",
  "discount",
  "webinar",
  "digest",
  "weekly",
  "promo",
  "deal",
  "limited time",
  "free shipping",
  "new arrivals",
  "black friday",
  "cyber monday",
  "coupon",
  "save up to",
  "last chance",
  "don't miss",
  "descuento",
  "oferta",
  "rebaja",
  "boletín",
  "seminario web",
  "novedades",
  "promoción",
  "no te pierdas",
  "últimos días",
] as const

/** Parts of a sender's address that say "a newsletter": `news@…`, `newsletter.example.com`, `….substack.com`. */
export const NEWSLETTER_SENDERS = [
  "news",
  "newsletter",
  "newsletters",
  "digest",
  "weekly",
  "promo",
  "marketing",
  "offers",
  "deals",
  "sale",
  "substack.com",
] as const

/** Words that say "this is about something of yours"; one of them keeps the email for the agent. */
export const ORDER_WORDS = [
  "заказ",
  "счёт",
  "счет на",
  "счета",
  "оплат",
  "квитанци",
  "кассовый чек",
  "электронный чек",
  "заявк",
  "форма",
  "доставк",
  "трек",
  "договор",
  "подтвержд",
  "код подтверждения",
  "код для входа",
  "пароль",
  "order",
  "invoice",
  "receipt",
  "payment",
  "shipped",
  "delivery",
  "tracking",
  "booking",
  "reservation",
  "confirm",
  "your account",
  "verification",
  "password",
  "refund",
  "statement",
  "pedido",
  "factura",
  "recibo",
  "pago",
  "envío",
  "reserva",
  "confirmación",
  "contraseña",
] as const

/** A number an order, an invoice or a request is known by, after the word that names it. */
const REFERENCE_NUMBER =
  /(?<![\p{L}])(?:заказ|заявк|сч[её]т|квитанци|order|invoice|ticket|pedido|factura)\p{L}*\s*(?:№|#|n[o°]\.?)?\s?\d{3,}/iu

/** The top of a newsletter: a link to read it in a browser, or to leave the list. */
const NEWSLETTER_TOP =
  /в браузере|веб-верси|view (?:it |this email )?(?:in|on) (?:your |a )?browser|unsubscribe|отписаться|darse de baja|ver en (?:el )?navegador/iu

const PICTOGRAPH = /\p{Extended_Pictographic}/u

/** A reply or a forward is a conversation, whatever it says. */
const REPLY = /^\s*(?:re|fw|fwd|aw|wg|ответ|отв|rv|res)\s*(?:\[\d+\])?\s*:/iu

export interface NewsletterCues {
  newsletterWords: readonly string[]
  newsletterSenders: readonly string[]
  orderWords: readonly string[]
  /** The score from which an email is surely a newsletter and left out. */
  threshold: number
  /** How much of the email's own text is read, and shown as the excerpt. */
  excerptChars: number
}

export const NEWSLETTER_DEFAULTS: NewsletterCues = {
  newsletterWords: NEWSLETTER_WORDS,
  newsletterSenders: NEWSLETTER_SENDERS,
  orderWords: ORDER_WORDS,
  threshold: 2,
  excerptChars: 400,
}

export interface BulkSorted {
  /** `newsletter` is left out; `excerpt` goes to the agent as the subject and the first lines. */
  verdict: "newsletter" | "excerpt"
  score: number
  /** What decided it: the newsletter signs, or what kept the email. */
  cues: string[]
  excerpt: string
}

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const matcherOf = (words: readonly string[]) => {
  const list = words.map((word) => word.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return () => []
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(escaped).join("|")})`, "giu")
  return (text: string) => [...new Set([...text.toLowerCase().matchAll(pattern)].map(([found]) => found))]
}

/** The first lines of an email's own text, at most `chars`, cut at a word. */
export const excerptOf = (text: string, chars: number): string => {
  const flat = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
  if (flat.length <= chars) return flat
  const cut = flat.slice(0, chars)
  const space = cut.search(/\s\S*$/)
  return `${space > chars / 2 ? cut.slice(0, space) : cut}…`
}

/**
 * Built once per read, so the word lists compile once. A reply, an order word in the subject or an order's number
 * keeps the email. Otherwise a newsletter word counts 2 in the subject and 1 in the first lines, a newsletter's
 * address 2, an emoji in the subject and a browser or unsubscribe link at the top 1 each, and each order word in
 * the first lines takes 2 off. Measured 2026-11-05 on 30 days of the owner's bulk mail: 99 of 100 sampled
 * newsletter verdicts were newsletters, and about half of the newsletters were found.
 */
export const newsletterSorter = (cues: NewsletterCues = NEWSLETTER_DEFAULTS) => {
  const advertising = matcherOf(cues.newsletterWords)
  const ordered = matcherOf(cues.orderWords)
  const senders = cues.newsletterSenders.map((part) => part.trim().toLowerCase()).filter(Boolean)
  const fromNewsletter = (address: string) => {
    const domain = address.split("@")[1] ?? ""
    const parts = new Set(address.split(/[.@_+-]/))
    return senders.some((one) => (one.includes(".") ? domain === one || domain.endsWith(`.${one}`) : parts.has(one)))
  }
  return ({ subject, text, from }: { subject: string | null; text: string; from: string | null }): BulkSorted => {
    const excerpt = excerptOf(text, cues.excerptChars)
    const title = subject ?? ""
    const number = REFERENCE_NUMBER.exec(`${title}\n${excerpt}`)
    const kept = [...(REPLY.test(title) ? ["a reply"] : []), ...ordered(title), ...(number ? [number[0]] : [])]
    if (kept.length > 0) return { verdict: "excerpt", score: 0, cues: kept, excerpt }
    const inTitle = advertising(title)
    const signs: [string, number][] = [
      ...inTitle.map((word) => [word, 2] as [string, number]),
      ...advertising(excerpt)
        .filter((word) => !inTitle.includes(word))
        .map((word) => [word, 1] as [string, number]),
      ...(PICTOGRAPH.test(title) ? [["an emoji in the subject", 1] as [string, number]] : []),
      ...(NEWSLETTER_TOP.test(excerpt) ? [["a browser or unsubscribe link", 1] as [string, number]] : []),
      ...(fromNewsletter((from ?? "").toLowerCase()) ? [["a newsletter's address", 2] as [string, number]] : []),
      ...ordered(excerpt).map((word) => [`-${word}`, -2] as [string, number]),
    ]
    const score = signs.reduce((sum, [, weight]) => sum + weight, 0)
    return {
      verdict: score >= cues.threshold ? "newsletter" : "excerpt",
      score,
      cues: signs.map(([cue]) => cue),
      excerpt,
    }
  }
}

/** How a holder's read treats bulk mail. */
export interface BulkTriage {
  /** `false` leaves every bulk email out, newsletter or not. */
  excerpts: boolean
  /** At most this many excerpts in one read; the read ends before the next one, which comes with the next read. */
  perRead: number
  cues: NewsletterCues
}

export const BULK_TRIAGE_DEFAULTS: BulkTriage = { excerpts: true, perRead: 30, cues: NEWSLETTER_DEFAULTS }
