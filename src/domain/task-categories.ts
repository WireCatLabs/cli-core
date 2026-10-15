import { CliError, singleLine } from "@wirecat/cli-base"

export interface TaskCategory {
  name: string
  meaning: string
  /** Words that point at the category, per language; a rule matches their stems against the source message. */
  triggers: Readonly<Record<"en" | "ru" | "es", readonly string[]>>
}

/**
 * The fixed list a task's category comes from. One list, so "finance", "payments" and "деньги" never coexist;
 * `other` is what a rule picks when no trigger word matches.
 */
export const DEFAULT_TASK_CATEGORIES: readonly TaskCategory[] = [
  {
    name: "money",
    meaning: "pay, invoice, refund, a price or a debt",
    triggers: {
      en: ["pay", "payment", "invoice", "bill", "refund", "price", "money", "transfer", "debt", "salary", "cost"],
      ru: [
        "оплата",
        "оплатить",
        "платёж",
        "счёт",
        "деньги",
        "перевод",
        "перевести",
        "долг",
        "цена",
        "стоимость",
        "возврат",
      ],
      es: ["pagar", "pago", "factura", "dinero", "transferencia", "deuda", "precio", "reembolso", "cobrar"],
    },
  },
  {
    name: "documents",
    meaning: "a file, contract, scan, form or signature to send or receive",
    triggers: {
      en: ["document", "contract", "file", "scan", "sign", "signature", "form", "passport", "certificate", "pdf"],
      ru: ["документ", "договор", "файл", "скан", "подписать", "подпись", "паспорт", "справка", "анкета", "акт"],
      es: ["documento", "contrato", "archivo", "escaneo", "firmar", "firma", "formulario", "pasaporte", "certificado"],
    },
  },
  {
    name: "meeting",
    meaning: "a call, meeting or appointment to arrange or attend",
    triggers: {
      en: ["meeting", "meet", "call", "appointment", "schedule", "zoom", "reschedule", "agenda"],
      ru: ["встреча", "встретиться", "созвон", "созвониться", "звонок", "приём", "запись", "перенести"],
      es: ["reunión", "reunirse", "llamada", "cita", "quedar", "agenda", "videollamada"],
    },
  },
  {
    name: "delivery",
    meaning: "a parcel, order or shipment to send, track or collect",
    triggers: {
      en: ["delivery", "deliver", "parcel", "package", "shipment", "ship", "order", "courier", "tracking", "pickup"],
      ru: ["доставка", "доставить", "посылка", "заказ", "курьер", "отправить", "отправка", "трек", "забрать"],
      es: ["entrega", "entregar", "paquete", "envío", "enviar", "pedido", "mensajero", "recoger"],
    },
  },
  {
    name: "access",
    meaning: "a login, password, key, invite or permission to give or get",
    triggers: {
      en: ["access", "password", "login", "account", "key", "token", "invite", "permission", "credentials"],
      ru: ["доступ", "пароль", "логин", "аккаунт", "ключ", "токен", "приглашение", "права"],
      es: ["acceso", "contraseña", "usuario", "cuenta", "clave", "invitación", "permiso"],
    },
  },
  {
    name: "personal",
    meaning: "family, friends, health, a gift or a favour",
    triggers: {
      en: ["birthday", "gift", "family", "mum", "mom", "dad", "doctor", "health", "favour", "favor", "party"],
      ru: ["день рождения", "подарок", "семья", "мама", "папа", "врач", "здоровье", "просьба", "праздник"],
      es: ["cumpleaños", "regalo", "familia", "mamá", "papá", "médico", "salud", "favor", "fiesta"],
    },
  },
  { name: "other", meaning: "none of the above", triggers: { en: [], ru: [], es: [] } },
]

export const FALLBACK_CATEGORY = "other"

const LANGUAGES = ["en", "ru", "es"] as const
const NAME = /^[a-z][a-z0-9-]{0,29}$/

/**
 * One category as `config set task_categories.<name>` takes it: `<meaning> | <words>`. A word may say its language
 * (`es:vuelo`); one that does not is Russian when written in Cyrillic, English otherwise — the rule stems every word
 * by its script, so the language only labels it.
 */
export const parseTaskCategory = (name: string, value: string): TaskCategory => {
  const named = name.trim().toLowerCase()
  if (!NAME.test(named))
    throw new CliError(
      "validation_error",
      `a category name is a lower-case word of letters, digits and -, up to 30 — not "${singleLine(name)}"`,
    )
  const [meaning = "", words = ""] = value.split("|", 2).map((part) => part.trim())
  if (!meaning || meaning.length > 200)
    throw new CliError(
      "validation_error",
      'a category takes "<meaning> | <trigger words, comma-separated>", the meaning up to 200 characters',
    )
  const triggers: Record<(typeof LANGUAGES)[number], string[]> = { en: [], ru: [], es: [] }
  for (const typed of words
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean)) {
    const tagged = /^(en|ru|es):\s*(.+)$/i.exec(typed)
    const word = (tagged?.[2] ?? typed).toLowerCase()
    const language = (tagged?.[1]?.toLowerCase() ?? (/\p{Script=Cyrillic}/u.test(word) ? "ru" : "en")) as
      | "en"
      | "ru"
      | "es"
    if (!triggers[language].includes(word)) triggers[language].push(word.slice(0, 60))
  }
  if (Object.values(triggers).flat().length > 100)
    throw new CliError("validation_error", "a category takes up to 100 trigger words")
  return { name: named, meaning, triggers }
}

/** The list with one category set (replaced in place, or added before `other`) or, with no value, removed. */
export const withTaskCategory = (
  list: readonly TaskCategory[],
  name: string,
  value: string | undefined,
): TaskCategory[] => {
  const named = name.trim().toLowerCase()
  if (value === undefined) {
    if (named === FALLBACK_CATEGORY)
      throw new CliError("validation_error", `${FALLBACK_CATEGORY} stays: a rule picks it when no trigger word matches`)
    if (!list.some((one) => one.name === named))
      throw new CliError("not_found", `no task category ${singleLine(named)} — tasks categories lists them`)
    return list.filter((one) => one.name !== named)
  }
  const category = parseTaskCategory(named, value)
  if (list.some((one) => one.name === named)) return list.map((one) => (one.name === named ? category : one))
  if (list.length >= 30) throw new CliError("validation_error", "the category list takes up to 30 categories")
  const fallback = list.findIndex((one) => one.name === FALLBACK_CATEGORY)
  return fallback < 0 ? [...list, category] : [...list.slice(0, fallback), category, ...list.slice(fallback)]
}

/** A category back as `config set` takes it, for `config show`. */
export const taskCategoryValue = ({ meaning, triggers }: TaskCategory): string => {
  const words = LANGUAGES.flatMap((language) => triggers[language].map((word) => `${language}:${word}`))
  return words.length === 0 ? meaning : `${meaning} | ${words.join(", ")}`
}

const wordsOf = (words: unknown): string[] => (Array.isArray(words) ? words.map(String) : [])

/** What the store holds, if it still reads as a list: a newer build's shape falls back to the default. */
export const storedTaskCategories = (json: string): TaskCategory[] | undefined => {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return undefined
    const list = parsed.map((one) => {
      const { name, meaning, triggers } = one as TaskCategory
      if (typeof name !== "string" || typeof meaning !== "string" || typeof triggers !== "object") throw new Error()
      return {
        name,
        meaning,
        triggers: {
          en: wordsOf(triggers.en),
          ru: wordsOf(triggers.ru),
          es: wordsOf(triggers.es),
        },
      }
    })
    return list.some((one) => one.name === FALLBACK_CATEGORY) ? list : undefined
  } catch {
    return undefined
  }
}
