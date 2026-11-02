import { afterEach, describe, expect, it } from "vitest"
import { normalize } from "../store/normalize.js"
import { amountOf, amountsOf, dayOf, dueDayOf } from "./task-signature.js"

const day = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000)
const wednesday = Date.parse("2026-10-14T10:00:00Z")
const zone = process.env.TZ

afterEach(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

describe("amountOf", () => {
  it.each([
    ["оплати 45000 ₽", { value: 45000, currency: "RUB" }],
    ["верни 15к до конца месяца", { value: 15000, currency: null }],
    ["15 тыс руб", { value: 15000, currency: "RUB" }],
    ["переведи 15000 р. сегодня", { value: 15000, currency: "RUB" }],
    ["can you pay 85 eur?", { value: 85, currency: "EUR" }],
    ["$120 for the domain", { value: 120, currency: "USD" }],
    ["1,5k for the flights", { value: 1500, currency: null }],
    ["50 000 ₽", { value: 50000, currency: "RUB" }],
    ["50\u00a0000 ₽", { value: 50000, currency: "RUB" }],
    ["50 000р", { value: 50000, currency: "RUB" }],
    ["50к", { value: 50000, currency: null }],
    ["1.200 €", { value: 1200, currency: "EUR" }],
    ["$300", { value: 300, currency: "USD" }],
    ["1 200 eur", { value: 1200, currency: "EUR" }],
  ])("reads %j", (text, amount) => {
    expect(amountOf(normalize(text))).toEqual(amount)
  })

  it("ignores a number with no currency or multiplier", () => {
    expect(amountOf("верни 3000 за бензин")).toBeNull()
  })
})

describe("amountsOf", () => {
  it("reads every amount in order", () => {
    expect(amountsOf("аванс 50 000 ₽, остаток $300 и 1.200 €")).toEqual([
      { value: 50000, currency: "RUB" },
      { value: 300, currency: "USD" },
      { value: 1200, currency: "EUR" },
    ])
  })

  it.each([
    ["5 000.50 ₽", { value: 5000.5, currency: "RUB" }],
    ["1 000 000.5 р", { value: 1000000.5, currency: "RUB" }],
    ["5\u2009000 ₽", { value: 5000, currency: "RUB" }],
    ["5\u202f000 ₽", { value: 5000, currency: "RUB" }],
    ["5\u00a0000 ₽", { value: 5000, currency: "RUB" }],
    ["$1,200", { value: 1200, currency: "USD" }],
    ["$1,200.50", { value: 1200.5, currency: "USD" }],
    ["1.200,50 EUR", { value: 1200.5, currency: "EUR" }],
    ["1,5 eur", { value: 1.5, currency: "EUR" }],
  ])("reads raw text %j", (text, amount) => {
    expect(amountsOf(text)).toEqual([amount])
  })

  it.each([
    ["+34 612 345 678"],
    ["позвони +7 916 123 45 67"],
    ["встреча 02.11.2026 в 15:30"],
    ["до 20.10"],
    ["room 4 on floor 12"],
  ])("finds no amount in %j", (text) => {
    expect(amountsOf(text)).toEqual([])
  })
})

describe("dueDayOf", () => {
  it.each([
    ["сделай завтра", "2026-10-15"],
    ["край послезавтра", "2026-10-16"],
    ["send it by friday", "2026-10-16"],
    ["до пятницы", "2026-10-16"],
    ["до 20.10", "2026-10-20"],
    ["before the 5th", "2026-11-05"],
    ["до конца месяца", "2026-10-31"],
    ["the report for march 3", "2026-03-03"],
    ["к 3 ноября", "2026-11-03"],
  ])("reads %j", (text, due) => {
    expect(dueDayOf(normalize(text), wednesday)).toBe(day(due))
  })

  it("takes the phrase that comes first", () => {
    expect(dueDayOf("завтра или в пятницу", wednesday)).toBe(day("2026-10-15"))
  })

  it("is null when the text names no date", () => {
    expect(dueDayOf("купи хлеба", wednesday)).toBeNull()
  })

  it.each([
    "закажи средства для посуды",
    "закажи завтрак в номер",
    "please decide 3 options",
    "maybe 2 tickets",
    "срок 5-го квартала",
    "call upon 5th street",
    "в марке 3 вида",
  ])("reads no date in %j", (text) => {
    expect(dueDayOf(normalize(text), wednesday)).toBeNull()
  })

  it.each([
    ["в среду", "2026-10-21"],
    ["до 3 мая", "2026-05-03"],
    ["к 5 ноябрю", "2026-11-05"],
    ["dec 3", "2026-12-03"],
    ["sept 9", "2026-09-09"],
  ])("still reads the whole word %j", (text, due) => {
    expect(dueDayOf(normalize(text), wednesday)).toBe(day(due))
  })

  it.each([
    ["envíamelo mañana", "2026-10-15"],
    ["mañana por la mañana", "2026-10-15"],
    ["lo de la mesa es para mañana por la noche", "2026-10-15"],
    ["pasado mañana", "2026-10-16"],
    ["hoy", "2026-10-14"],
    ["el viernes", "2026-10-16"],
    ["el próximo lunes", "2026-10-19"],
    ["el miércoles", "2026-10-21"],
    ["el sábado", "2026-10-17"],
    ["a fin de mes", "2026-10-31"],
    ["antes del final del mes", "2026-10-31"],
    ["el 15 de noviembre", "2026-11-15"],
    ["15 de setiembre", "2026-09-15"],
    ["antes del día 20", "2026-10-20"],
    ["antes del 5", "2026-11-05"],
    ["antes del 5 de diciembre", "2026-12-05"],
    ["para el día 3 de mayo", "2026-05-03"],
    ["antes del 3.12", "2026-12-03"],
  ])("reads the Spanish %j", (text, due) => {
    expect(dueDayOf(normalize(text), wednesday)).toBe(day(due))
  })

  it.each([
    "llámame por la mañana",
    "a las 10 de la mañana",
    "esta mañana te mandé la factura",
    "los viernes hay reunión",
    "antes del 3/11",
    "hasta el 50% de descuento",
    "el 5 de los 10 pagos",
    "buy 2 mayo jars",
  ])("reads no date in the Spanish %j", (text) => {
    expect(dueDayOf(normalize(text), wednesday)).toBeNull()
  })

  it("counts days in the machine's time zone", () => {
    const lateEvening = Date.parse("2026-10-14T22:30:00Z")
    process.env.TZ = "Europe/Madrid"
    expect(dayOf(lateEvening)).toBe(day("2026-10-15"))
    expect(dueDayOf("завтра", lateEvening)).toBe(day("2026-10-16"))
    process.env.TZ = "America/New_York"
    expect(dueDayOf("завтра", lateEvening)).toBe(day("2026-10-15"))
  })
})
