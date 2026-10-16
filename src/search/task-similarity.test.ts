import { describe, expect, it } from "vitest"
import { dayOf } from "./task-signature.js"
import {
  bandOf,
  compareTasks,
  compareViews,
  type PreparedTask,
  prepareTask,
  rankCandidates,
  TASK_SIMILARITY_WEIGHTS,
  type TaskSide,
} from "./task-similarity.js"

const DAY = 86_400_000
const now = Date.parse("2026-10-14T10:00:00Z")
const at = (daysAgo: number) => new Date(now - daysAgo * DAY)

const bare = (fields: Partial<PreparedTask> = {}): PreparedTask => ({
  stems: new Set(),
  trigrams: new Set(),
  amount: null,
  dueDay: null,
  createdMs: now,
  ...fields,
})

describe("prepareTask", () => {
  it("joins digit groups and drops stop words before stemming", () => {
    const task = prepareTask({
      title: "Send the invoice",
      description: "Can you send it for 15 000 ₽?",
      createdAt: at(0),
    })
    expect([...task.stems]).toEqual(["send", "invoic", "15000"])
  })

  it("folds a stop word before looking it up", () => {
    const task = prepareTask({ title: "Пожалуйста, оплати газ", createdAt: at(0) })
    expect([...task.stems]).toEqual(["оплат", "газ"])
  })

  it("drops Spanish stop words", () => {
    const task = prepareTask({ title: "Pagar la factura del gas", createdAt: at(0) })
    expect([...task.stems]).toEqual(["pagar", "pag", "factura", "factur", "gas"])
  })

  it("reads the amount and due date from the text unless they are given", () => {
    const text = { title: "Оплатить счёт", description: "15 000 руб до пятницы", createdAt: at(0) }
    expect(prepareTask(text)).toMatchObject({ amount: { value: 15000, currency: "RUB" }, dueDay: dayOf(now) + 2 })
    expect(prepareTask({ ...text, amount: null, due: new Date(2026, 9, 20, 23, 30) })).toMatchObject({
      amount: null,
      dueDay: Date.UTC(2026, 9, 20) / DAY,
    })
  })
})

describe("compareTasks levels", () => {
  const stems = (...words: string[]) => new Set(words)

  it.each([
    [stems("a", "b", "c"), stems("a", "b", "c", "d", "e"), "high"],
    [stems("a", "b", "c"), stems("a", "d", "e", "f", "g", "h", "i", "j", "k", "l"), "low"],
    [stems("a", "b", "c"), stems("a", "b", "d", "e", "f", "g", "h"), "low"],
    [stems("a", "b", "c"), stems("a", "b", "c", "d", "e", "f", "g", "h", "i", "j"), "middle"],
    [stems(), stems(), "low"],
  ])("text %#", (a, b, level) => {
    expect(compareTasks(bare({ stems: a }), bare({ stems: b })).levels.text).toBe(level)
  })

  it("text takes the higher of stem and title trigram overlap", () => {
    const a = bare({ stems: stems("x"), trigrams: stems("abc", "bcd") })
    const b = bare({ stems: stems("y"), trigrams: stems("abc", "bcd", "cde") })
    expect(compareTasks(a, b)).toMatchObject({
      levels: { text: "high" },
      reasons: ["titles 67% alike letter by letter"],
    })
  })

  it.each([
    ["person:a", "person:a", "same"],
    ["person:a", "person:b", "different"],
    ["person:a", undefined, "unknown"],
  ])("person %s / %s is %s", (a, b, level) => {
    const side = (person: string | undefined) => bare(person === undefined ? {} : { person })
    expect(compareTasks(side(a), side(b)).levels.person).toBe(level)
  })

  it.each([
    [{ value: 15000, currency: "RUB" }, { value: 15000, currency: "RUB" }, "equal"],
    [{ value: 15000, currency: "RUB" }, { value: 15000, currency: null }, "equal"],
    [{ value: 15000, currency: "RUB" }, { value: 15000, currency: "EUR" }, "different"],
    [{ value: 15000, currency: "RUB" }, { value: 40000, currency: "RUB" }, "different"],
    [{ value: 15000, currency: "RUB" }, null, "missing"],
  ])("amount %j / %j is %s", (a, b, level) => {
    expect(compareTasks(bare({ amount: a }), bare({ amount: b })).levels.amount).toBe(level)
  })

  it.each([
    ["money", "money", "same"],
    ["money", "meeting", "different"],
    ["money", undefined, "unknown"],
  ])("category %s / %s is %s", (a, b, level) => {
    const side = (category: string | undefined) => bare(category === undefined ? {} : { category })
    expect(compareTasks(side(a), side(b)).levels.category).toBe(level)
  })

  it.each([
    [100, 102, "near"],
    [100, 103, "far"],
    [100, null, "missing"],
  ])("due days %s / %s is %s", (a, b, level) => {
    expect(compareTasks(bare({ dueDay: a }), bare({ dueDay: b })).levels.due).toBe(level)
  })

  it.each([
    [3, "near"],
    [3.5, "weeks"],
    [14, "weeks"],
    [14.5, "far"],
  ])("tasks %s days apart are %s", (days, level) => {
    expect(compareTasks(bare(), bare({ createdMs: now - days * DAY })).levels.time).toBe(level)
  })

  it("counts a reply chain only when the caller says so", () => {
    expect(compareTasks(bare(), bare()).levels.reply).toBe("no")
    expect(compareTasks(bare(), bare(), { replyChain: true })).toMatchObject({ levels: { reply: "yes" }, score: 6 })
  })
})

describe("weights and bands", () => {
  it("are the cli-testing#60 recommended weights", () => {
    const numbers = Object.fromEntries(
      Object.entries(TASK_SIMILARITY_WEIGHTS).map(([field, levels]) => [
        field,
        Object.fromEntries(Object.entries(levels).map(([level, { weight }]) => [level, weight])),
      ]),
    )
    expect(numbers).toEqual({
      text: { high: 5, middle: 5, low: -2 },
      person: { same: 1, different: -3, unknown: 0 },
      amount: { equal: 6, different: -4, missing: 0 },
      category: { same: 1, different: -1, unknown: 0 },
      due: { near: 4, far: -1, missing: 0 },
      reply: { yes: 6, no: 0 },
      time: { near: 2, weeks: -2, far: -3 },
    })
  })

  it.each([
    [10, "likely"],
    [9, "maybe"],
    [5, "maybe"],
    [4, "different"],
  ])("%s is %s", (score, band) => {
    expect(bandOf(score)).toBe(band)
  })
})

describe("a task read with one of its messages", () => {
  const sent = at(9)
  const own = prepareTask({ title: "Pay the bill", createdAt: at(0) })
  const withMessage = prepareTask({
    title: "Pay the bill",
    createdAt: at(0),
    message: { text: "15 000 rub, by tomorrow", sentAt: sent },
  })

  it("reads the message's amount, and its due date from when it was sent", () => {
    expect(withMessage).toMatchObject({ amount: { value: 15000, currency: "RUB" }, dueDay: dayOf(sent.getTime()) + 1 })
    expect(withMessage.stems).toEqual(new Set(["pay", "bill", "15000", "rub", "tomorrow"]))
  })

  it("reads a Spanish message's due date from when it was sent", () => {
    const spanish = prepareTask({
      title: "Pagar la factura",
      createdAt: at(0),
      message: { text: "¿Me la pagas mañana?", sentAt: sent },
    })
    expect(spanish.dueDay).toBe(dayOf(sent.getTime()) + 1)
  })

  it("counts the best view whole, so a message can raise a score and never lower it", () => {
    const other = prepareTask({ title: "Pay the bill", amount: { value: 9000, currency: "RUB" }, createdAt: at(0) })
    expect(compareViews([own, withMessage], [other])).toEqual(compareTasks(own, other))
    const same = prepareTask({ title: "Pay the bill", amount: { value: 15000, currency: "RUB" }, createdAt: at(0) })
    expect(compareViews([own, withMessage], [same])).toEqual(compareTasks(withMessage, same))
  })
})

describe("the worked example on the tasks architecture page", () => {
  const bob = "person:bob-sample"
  const fresh = prepareTask({
    title: "Send the invoice for 15 000 ₽ by Friday",
    description: "Can you send the invoice for 15 000 ₽ by Friday?",
    person: bob,
    category: "money",
    createdAt: at(0),
  })
  const req22 = prepareTask({ title: "Send the invoice for 15000 ₽", person: bob, category: "money", createdAt: at(1) })
  const req19 = prepareTask({
    title: "Send the contract invoice, 40 000 ₽",
    person: bob,
    category: "money",
    createdAt: at(10),
  })

  it("stems the new task as the page says", () => {
    expect([...fresh.stems]).toEqual(["send", "invoic", "15000", "friday"])
  })

  it("scores REQ-22 15, likely, on 3 of 4 stems", () => {
    const result = compareTasks(fresh, req22)
    expect(result.text).toMatchObject({ sharedStems: 3, allStems: 4, stems: 0.75 })
    expect(result.text.trigrams).toBeLessThan(result.text.stems)
    expect(result).toMatchObject({ score: 15, band: "likely" })
    expect(result.reasons.join(", ")).toBe("same person, same amount, 3 of 4 stems shared")
  })

  it("scores REQ-19 1, different, on 2 of 6 stems and another amount", () => {
    const result = compareTasks(fresh, req19)
    expect(result.text).toMatchObject({ sharedStems: 2, allStems: 6 })
    expect(result.text.trigrams).toBeLessThan(result.text.stems)
    expect(result).toMatchObject({ score: 1, band: "different", levels: { amount: "different", time: "weeks" } })
  })

  it("ranks REQ-22 first", () => {
    const ranked = rankCandidates(
      [fresh],
      [
        { id: "REQ-19", views: [req19] },
        { id: "REQ-22", views: [req22] },
      ],
    )
    expect(ranked.map(({ id, score }) => [id, score])).toEqual([
      ["REQ-22", 15],
      ["REQ-19", 1],
    ])
  })
})

describe("pairs from the cli-testing duplicate set", () => {
  const task = (fields: Omit<TaskSide, "createdAt"> & { createdAt: string }) =>
    prepareTask({ ...fields, createdAt: new Date(fields.createdAt) })

  it("scores one bill written as `15 000 руб` and `15000 р.` likely", () => {
    const first = task({
      title: "Оплатить счёт за ремонт кухни",
      description: "Оплати счёт за ремонт кухни, 15 000 руб, до пятницы",
      person: "person:maria",
      category: "money",
      createdAt: "2026-09-06T11:21:00.000Z",
    })
    const reminder = task({
      title: "Перевести Марии за кухню",
      description: "переведи за счёт по кухне 15000 р., край — пятница",
      person: "person:maria",
      category: "money",
      createdAt: "2026-09-07T09:28:00.000Z",
    })
    expect(compareTasks(reminder, first)).toMatchObject({
      score: 19,
      band: "likely",
      levels: { text: "middle", amount: "equal", due: "near", time: "near" },
    })
  })

  it("scores a gift for dad and one for mum maybe: one word apart, no field tells them apart", () => {
    const dad = task({
      title: "Скинуться на подарок папе",
      description: "Скидываемся на подарок папе по 3000",
      person: "person:nina",
      category: "money",
      createdAt: "2026-10-14T12:13:00.000Z",
    })
    const mum = task({
      title: "Скинуться на подарок маме",
      description: "А на подарок маме по 3000 к ноябрю",
      person: "person:nina",
      category: "money",
      createdAt: "2026-10-16T20:20:00.000Z",
    })
    expect(compareTasks(mum, dad)).toMatchObject({ score: 9, band: "maybe", levels: { text: "high" } })
  })

  it("scores two trips at the same price likely though they are different jobs", () => {
    const theatre = task({
      title: "Сдать деньги на экскурсию в театр",
      description: "Родители, сдаём по 2 500 руб на театр до 20.10",
      person: "person:olga",
      category: "money",
      createdAt: "2026-10-11T20:03:00.000Z",
    })
    const zoo = task({
      title: "Сдать деньги на экскурсию в зоопарк",
      description: "И ещё по 2 500 руб на зоопарк до 30.10, это другая поездка",
      person: "person:olga",
      category: "money",
      createdAt: "2026-10-12T09:10:00.000Z",
    })
    expect(compareTasks(zoo, theatre)).toMatchObject({
      score: 14,
      band: "likely",
      levels: { amount: "equal", due: "far" },
    })
  })

  it("scores two Spanish messages about one payment likely, the verb in two forms", () => {
    const first = task({
      title: "Pagar a Lucía la cena",
      description: "¿Me pagas los 45 € de la cena del sábado?",
      person: "person:lucia",
      category: "money",
      createdAt: "2026-10-12T19:00:00.000Z",
    })
    const reminder = task({
      title: "Pago de la cena a Lucía",
      description: "Recuerda que falta el pago de la cena, 45 euros",
      person: "person:lucia",
      category: "money",
      createdAt: "2026-10-13T09:30:00.000Z",
    })
    expect(compareTasks(reminder, first)).toMatchObject({
      band: "likely",
      levels: { text: "middle", amount: "equal", time: "near" },
    })
  })

  it("leaves a reply that asks for something new in maybe, not attached", () => {
    const contract = task({
      title: "Send Alice the updated contract",
      description: "can you send the updated contract?",
      person: "person:alice",
      category: "documents",
      createdAt: "2026-10-11T15:00:00.000Z",
    })
    const table = task({
      title: "Book a table for Friday",
      description: "thanks! also, can you book a table for Friday?",
      person: "person:alice",
      category: "meeting",
      createdAt: "2026-10-11T17:07:00.000Z",
    })
    expect(compareTasks(table, contract, { replyChain: true })).toMatchObject({
      score: 6,
      band: "maybe",
      reasons: ["same person", "in one reply chain", "0 of 10 stems shared"],
    })
  })
})
