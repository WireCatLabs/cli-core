/**
 * Word patterns for project status, ru/en/es, matched on the text as written (case folded here). A stem cannot tell
 * `оплатил` from `оплати`, so the past forms a money stem shares with a request are listed whole: a message with one
 * of them reads as "done", whatever stems it also hits.
 */
const words = (forms: readonly string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.join("|")})(?![\\p{L}\\p{N}])`, "iu")

export const MONEY_DONE_FORMS = words([
  "оплатил[аи]?",
  "заплатил[аи]?",
  "перевел[аи]?",
  "перевёл",
  "отправил[аи]?",
  "оплачено",
  "переведено",
  "paid",
  "transferred",
  "pagué",
  "pagado",
  "transferí",
])

/** First person future: "I'll send", "сделаю", "lo envío". Labelled a guess wherever it is shown. */
export const PROMISE_FORMS = words([
  "сделаю",
  "пришлю",
  "отправлю",
  "подготовлю",
  "проверю",
  "напишу",
  "позвоню",
  "скину",
  "вышлю",
  "оплачу",
  "будет готов[аоы]?",
  "i'?ll (?:send|do|check|call|write|pay|prepare|share|fix)",
  "i will (?:send|do|check|call|write|pay|prepare|share|fix)",
  "will be ready",
  "lo envío",
  "te envío",
  "enviaré",
  "haré",
  "mandaré",
  "te llamo",
  "estará listo",
])
