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
 *
 * Order matters: a rule takes the category with the most trigger hits and gives a tie to the earlier one, so narrow
 * categories come first, the generic actions (money, documents, meeting) after them, and work and personal last.
 * A trigger of several words counts each word on its own, so every trigger here is one word, and none stems to a
 * common word (`billing` → bill, `staging` → stage, `друг` → другой).
 */
export const DEFAULT_TASK_CATEGORIES: readonly TaskCategory[] = [
  {
    name: "taxes",
    meaning: "tax returns, the accountant, the tax office",
    triggers: {
      en: ["tax", "taxes", "accountant", "vat", "hmrc"],
      ru: ["налог", "налоговая", "декларация", "бухгалтер", "ндфл", "ифнс", "вычет"],
      es: ["impuesto", "impuestos", "hacienda", "iva", "irpf", "gestor", "gestoría"],
    },
  },
  {
    name: "bills",
    meaning: "a recurring bill: utilities, phone, internet, a subscription",
    triggers: {
      en: ["utility", "utilities", "electricity", "subscription", "renewal", "heating"],
      ru: ["коммуналка", "коммунальные", "электричество", "газ", "квитанция", "показания", "подписка", "абонентская"],
      es: ["recibo", "recibos", "suministro", "suministros", "suscripción", "electricidad"],
    },
  },
  {
    name: "insurance",
    meaning: "an insurance policy or claim",
    triggers: {
      en: ["insurance", "insurer", "insured", "coverage"],
      ru: ["страховка", "страховая", "страхование", "полис", "осаго", "каско", "дмс"],
      es: ["aseguradora", "póliza", "siniestro", "mutua"],
    },
  },
  {
    name: "bank",
    meaning: "cards, bank accounts, wire transfers, a bank's request",
    triggers: {
      en: ["bank", "banking", "card", "iban", "swift", "wire", "overdraft"],
      ru: ["банк", "карта", "карту", "реквизиты", "выписка", "iban", "swift"],
      es: ["banco", "tarjeta", "iban", "swift"],
    },
  },
  {
    name: "government",
    meaning: "a visa, residence, a permit, an appointment at a public office",
    triggers: {
      en: ["visa", "residence", "permit", "embassy", "consulate", "passport", "citizenship", "nie"],
      ru: [
        "виза",
        "внж",
        "гражданство",
        "посольство",
        "консульство",
        "госуслуги",
        "мфц",
        "паспорт",
        "загранпаспорт",
        "прописка",
      ],
      es: [
        "visado",
        "residencia",
        "extranjería",
        "empadronamiento",
        "padrón",
        "ayuntamiento",
        "consulado",
        "embajada",
        "pasaporte",
        "nie",
      ],
    },
  },
  {
    name: "legal",
    meaning: "a lawyer, a notary, a court or a dispute",
    triggers: {
      en: ["lawyer", "attorney", "notary", "court", "lawsuit", "dispute", "legal"],
      ru: ["юрист", "адвокат", "нотариус", "иск", "претензия", "доверенность", "судебный"],
      es: ["abogado", "notario", "juzgado", "demanda", "tribunal", "litigio"],
    },
  },
  {
    name: "hiring",
    meaning: "candidates, interviews, job offers",
    triggers: {
      en: ["candidate", "candidates", "interview", "hire", "hiring", "recruiter", "vacancy", "resume", "cv"],
      ru: ["кандидат", "собеседование", "вакансия", "резюме", "оффер", "найм", "рекрутер"],
      es: ["candidato", "entrevista", "vacante", "currículum", "contratación"],
    },
  },
  {
    name: "sales",
    meaning: "leads, deals, quotes",
    triggers: {
      en: ["quote", "pipeline", "prospect", "crm", "sales"],
      ru: ["лид", "лиды", "сделка", "продажи", "коммерческое"],
      es: ["venta", "ventas", "presupuesto"],
    },
  },
  {
    name: "partners",
    meaning: "a partnership or an integration with another company",
    triggers: {
      en: ["partner", "partners", "partnership", "integration", "affiliate", "reseller"],
      ru: ["партнёр", "партнёры", "партнёрство", "интеграция"],
      es: ["socio", "alianza", "integración", "colaboración"],
    },
  },
  {
    name: "support",
    meaning: "a user's or customer's problem to solve",
    triggers: {
      en: ["support", "complaint", "helpdesk", "outage"],
      ru: ["поддержка", "жалоба", "обращение", "тикет"],
      es: ["soporte", "incidencia", "queja", "reclamación"],
    },
  },
  {
    name: "access",
    meaning: "a login, password, key, invite or permission to give or get",
    triggers: {
      en: ["access", "password", "credentials", "invite", "permission", "key", "keys", "token", "vpn"],
      ru: ["доступ", "пароль", "логин", "ключ", "ключи", "приглашение", "аккаунт"],
      es: ["acceso", "contraseña", "llave", "llaves", "clave", "invitación", "permiso"],
    },
  },
  {
    name: "tech",
    meaning: "code, servers, bugs, builds, deploys",
    triggers: {
      en: [
        "bug",
        "deploy",
        "deployment",
        "server",
        "build",
        "code",
        "merge",
        "crash",
        "flaky",
        "database",
        "api",
        "release",
        "prod",
      ],
      ru: ["баг", "деплой", "сервер", "сборка", "код", "пулреквест", "прод", "релиз"],
      es: ["fallo", "servidor", "despliegue", "código"],
    },
  },
  {
    name: "content",
    meaning: "posts, articles, videos, designs to make or review",
    triggers: {
      en: ["article", "blog", "video", "newsletter", "draft", "mockup", "mockups", "design", "brand", "logo"],
      ru: ["пост", "блог", "видео", "ролик", "макет", "макеты", "черновик"],
      es: ["artículo", "publicación", "vídeo", "video", "borrador", "diseño"],
    },
  },
  {
    name: "car",
    meaning: "the car: repairs, parking, fines, inspection",
    triggers: {
      en: ["car", "parking", "mechanic", "garage", "tyres", "tires", "mot"],
      ru: ["машина", "авто", "парковка", "штраф", "гибдд", "шиномонтаж", "техосмотр"],
      es: ["coche", "aparcamiento", "multa", "taller", "itv", "neumáticos"],
    },
  },
  {
    name: "travel",
    meaning: "flights, trains, hotels, trips",
    triggers: {
      en: ["flight", "flights", "hotel", "airport", "trip", "train", "airbnb", "boarding"],
      ru: ["рейс", "перелёт", "самолёт", "гостиница", "отель", "аэропорт", "поезд", "поездка", "командировка"],
      es: ["vuelo", "vuelos", "hotel", "aeropuerto", "viaje", "tren"],
    },
  },
  {
    name: "health",
    meaning: "doctors, prescriptions, medicines, sport",
    triggers: {
      en: [
        "doctor",
        "dentist",
        "clinic",
        "hospital",
        "prescription",
        "pharmacy",
        "medicine",
        "medicines",
        "gym",
        "workout",
        "vitamins",
      ],
      ru: [
        "врач",
        "стоматолог",
        "окулист",
        "кардиолог",
        "больница",
        "поликлиника",
        "лекарство",
        "лекарства",
        "рецепт",
        "аптека",
        "анализы",
        "спортзал",
        "тренировка",
        "витамины",
      ],
      es: ["médico", "dentista", "clínica", "hospital", "receta", "farmacia", "medicamento", "gimnasio"],
    },
  },
  {
    name: "education",
    meaning: "courses, books, languages, studies at school or university",
    triggers: {
      en: ["course", "lesson", "tutor", "university", "exam", "homework", "study"],
      ru: ["курсы", "урок", "репетитор", "университет", "экзамен", "учёба", "лекция", "книга"],
      es: ["curso", "universidad", "examen", "libro", "idioma"],
    },
  },
  {
    name: "family",
    meaning: "kids, school, parents and relatives",
    triggers: {
      en: [
        "mum",
        "mom",
        "dad",
        "kids",
        "kid",
        "school",
        "grandma",
        "grandpa",
        "wife",
        "husband",
        "daughter",
        "parents",
      ],
      ru: [
        "мама",
        "папа",
        "бабушка",
        "дедушка",
        "дети",
        "ребёнок",
        "сын",
        "дочь",
        "муж",
        "жена",
        "школа",
        "учитель",
        "класс",
        "родители",
        "родительское",
        "дневник",
        "тётя",
      ],
      es: ["mamá", "papá", "hijos", "hijo", "hija", "colegio", "abuela", "abuelo", "padres", "niños"],
    },
  },
  {
    name: "home",
    meaning: "the flat: repairs, rent, the landlord, neighbours",
    triggers: {
      en: [
        "flat",
        "apartment",
        "landlord",
        "rent",
        "plumber",
        "leak",
        "electrician",
        "neighbours",
        "boiler",
        "intercom",
        "repair",
      ],
      ru: [
        "квартира",
        "аренда",
        "ремонт",
        "сантехник",
        "протечка",
        "электрик",
        "соседи",
        "подъезд",
        "домофон",
        "подвал",
        "чердак",
        "этаж",
        "коридор",
        "жильцы",
        "переезд",
        "роутер",
      ],
      es: [
        "piso",
        "alquiler",
        "casero",
        "fontanero",
        "avería",
        "vecinos",
        "portal",
        "reforma",
        "calefacción",
        "mudanza",
      ],
    },
  },
  {
    name: "delivery",
    meaning: "a parcel, order or courier to send, track or collect",
    triggers: {
      en: ["delivery", "deliver", "parcel", "package", "shipment", "ship", "courier", "tracking", "pickup", "order"],
      ru: ["доставка", "посылка", "курьер", "трек", "выдачи", "сдэк", "озон", "заказ"],
      es: ["entrega", "paquete", "envío", "pedido", "mensajero", "repartidor", "correos"],
    },
  },
  {
    name: "shopping",
    meaning: "things to buy",
    triggers: {
      en: ["buy", "purchase", "shop", "shopping", "groceries"],
      ru: ["купить", "покупка", "магазин"],
      es: ["comprar", "compra", "tienda", "supermercado"],
    },
  },
  {
    name: "entertainment",
    meaning: "films, series, concerts, games, shows",
    triggers: {
      en: ["film", "movie", "cinema", "series", "concert", "game", "theatre", "theater", "netflix"],
      ru: ["фильм", "сериал", "концерт", "игра", "театр", "спектакль", "матч", "кинотеатр"],
      es: ["película", "cine", "serie", "concierto", "juego", "teatro"],
    },
  },
  {
    name: "events",
    meaning: "an event, tickets, a venue, an RSVP",
    triggers: {
      en: [
        "event",
        "tickets",
        "ticket",
        "rsvp",
        "venue",
        "conference",
        "festival",
        "party",
        "reservation",
        "restaurant",
      ],
      ru: [
        "мероприятие",
        "билеты",
        "конференция",
        "фестиваль",
        "свадьба",
        "вечеринка",
        "праздник",
        "ресторан",
        "столик",
      ],
      es: ["evento", "entradas", "boda", "fiesta", "congreso", "conferencia", "restaurante"],
    },
  },
  {
    name: "community",
    meaning: "a group or club you run or help: members, moderation, admin work",
    triggers: {
      en: ["community", "club", "members", "volunteer", "moderator"],
      ru: ["сообщество", "клуб", "участники", "модерация", "волонтёр"],
      es: ["comunidad", "voluntario", "miembros"],
    },
  },
  {
    name: "intro",
    meaning: "introduce people, or ask for an introduction",
    triggers: {
      en: ["intro", "introduce", "introduction", "referral"],
      ru: ["познакомить", "познакомь", "знакомство"],
      es: ["presentarte", "presentaros"],
    },
  },
  {
    name: "money",
    meaning: "pay, invoice, refund, a price or a debt",
    triggers: {
      en: [
        "pay",
        "payment",
        "invoice",
        "refund",
        "price",
        "money",
        "transfer",
        "debt",
        "owe",
        "cost",
        "reimburse",
        "expenses",
      ],
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
        "вернуть",
        "скинуться",
      ],
      es: ["pagar", "pago", "factura", "dinero", "transferencia", "deuda", "precio", "reembolso", "cobrar"],
    },
  },
  {
    name: "documents",
    meaning: "a contract, scan, form or signature to send or receive",
    triggers: {
      en: [
        "document",
        "documents",
        "contract",
        "scan",
        "sign",
        "signature",
        "form",
        "certificate",
        "pdf",
        "agreement",
        "nda",
      ],
      ru: ["документ", "договор", "скан", "подписать", "подпись", "анкета", "справка", "акт", "согласие", "протокол"],
      es: ["documento", "contrato", "escaneo", "firmar", "firma", "formulario", "certificado"],
    },
  },
  {
    name: "meeting",
    meaning: "a call, meeting or appointment to arrange or attend",
    triggers: {
      en: ["meeting", "meet", "call", "appointment", "schedule", "zoom", "reschedule", "agenda", "sync", "standup"],
      ru: ["встреча", "встретиться", "созвон", "созвониться", "звонок", "позвонить", "собрание"],
      es: ["reunión", "reunirse", "llamada", "cita", "agenda", "videollamada"],
    },
  },
  {
    name: "clients",
    meaning: "a client's request, a proposal, a client follow-up",
    triggers: {
      en: ["client", "clients", "customer", "proposal"],
      ru: ["клиент", "заказчик"],
      es: ["cliente", "propuesta"],
    },
  },
  {
    name: "projects",
    meaning: "deliverables, deadlines, launches",
    triggers: {
      en: ["project", "deadline", "launch", "milestone", "deliverable", "roadmap", "sprint"],
      ru: ["проект", "дедлайн", "запуск", "спринт"],
      es: ["proyecto", "lanzamiento", "plazo"],
    },
  },
  {
    name: "team",
    meaning: "colleagues, reviews, one-to-ones, time off",
    triggers: {
      en: ["team", "colleague", "colleagues", "vacation", "onboarding", "manager"],
      ru: ["команда", "коллега", "коллеги", "отпуск", "онбординг", "руководитель"],
      es: ["equipo", "compañero", "vacaciones"],
    },
  },
  {
    name: "follow-up",
    meaning: "you wait for someone: chase them",
    triggers: {
      en: ["remind", "reminder", "chase", "nudge", "followup"],
      ru: ["напоминаю", "напомнить", "напоминание", "пинг"],
      es: ["recordatorio", "recordar"],
    },
  },
  {
    name: "reply",
    meaning: "someone waits for your answer",
    triggers: {
      en: ["reply", "respond", "answer"],
      ru: ["ответь", "ответить", "ответ"],
      es: ["responder", "respuesta", "contestar", "contesta"],
    },
  },
  {
    name: "work",
    meaning: "a job task with no closer category",
    triggers: {
      en: ["work", "job", "office", "task"],
      ru: ["работа", "офис", "задача", "начальник"],
      es: ["trabajo", "oficina", "tarea", "jefe"],
    },
  },
  {
    name: "personal",
    meaning: "friends, gifts, favours",
    triggers: {
      en: ["friend", "friends", "gift", "favour", "favor", "birthday"],
      ru: ["подруга", "подарок", "просьба", "рождения", "друзья"],
      es: ["amigo", "amiga", "regalo", "favor", "cumpleaños"],
    },
  },
  { name: "other", meaning: "none of the above", triggers: { en: [], ru: [], es: [] } },
]

export const FALLBACK_CATEGORY = "other"

const LANGUAGES = ["en", "ru", "es"] as const
const NAME = /^[a-z][a-z0-9-]{0,29}$/
const MAX_CATEGORIES = 60

/**
 * One category as `config set task_categories.<name>` takes it: `<meaning> | <words>`. A word may say its language
 * (`es:vuelo`); one that does not is Russian when written in Cyrillic, English otherwise. Only `es:` words are also
 * matched by their Spanish stem, in a message that reads as Spanish.
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
  if (list.length >= MAX_CATEGORIES)
    throw new CliError("validation_error", `the category list takes up to ${MAX_CATEGORIES} categories`)
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
