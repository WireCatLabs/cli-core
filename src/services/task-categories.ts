import { CliError, singleLine } from "@wirecat/cli-base"
import { createStemmer, type Stemmer } from "../search/stem.js"

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

const names = (categories: readonly TaskCategory[]) => categories.map(({ name }) => name).join(", ")

/** A category the list holds, or a refusal that names the list. */
export const taskCategoryOf =
  (categories: readonly TaskCategory[] = DEFAULT_TASK_CATEGORIES, flag = "--category") =>
  (typed: string): string => {
    const name = typed.trim().toLowerCase()
    if (categories.some((one) => one.name === name)) return name
    throw new CliError(
      "validation_error",
      `${flag} takes ${names(categories)} — not "${singleLine(typed)}"; tasks categories says what each means`,
      { reason: "task.category-unknown" },
    )
  }

let stemmer: Stemmer | undefined
const stemsByList = new WeakMap<readonly TaskCategory[], { name: string; stems: Set<string> }[]>()

const triggerStems = (categories: readonly TaskCategory[], stem: Stemmer) => {
  const known = stemsByList.get(categories)
  if (known) return known
  const built = categories.map(({ name, triggers }) => ({
    name,
    stems: new Set(Object.values(triggers).flatMap((words) => words.flatMap((word) => stem.stemTokens(word)))),
  }))
  stemsByList.set(categories, built)
  return built
}

/** The category whose trigger stems the text shares most; none shared is `other`. A tie goes to the earlier one. */
export const categorize = (text: string, categories: readonly TaskCategory[] = DEFAULT_TASK_CATEGORIES): string => {
  stemmer ??= createStemmer()
  const words = new Set(stemmer.stemTokens(text))
  let best = { name: FALLBACK_CATEGORY, hits: 0 }
  for (const { name, stems } of triggerStems(categories, stemmer)) {
    let hits = 0
    for (const stem of stems) if (words.has(stem)) hits += 1
    if (hits > best.hits) best = { name, hits }
  }
  return best.name
}
