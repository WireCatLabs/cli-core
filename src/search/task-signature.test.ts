import { afterEach, describe, expect, it } from "vitest"
import { normalize } from "../store/normalize.js"
import { amountOf, dayOf, dueDayOf } from "./task-signature.js"

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
  ])("reads %j", (text, amount) => {
    expect(amountOf(normalize(text))).toEqual(amount)
  })

  it("ignores a number with no currency or multiplier", () => {
    expect(amountOf("верни 3000 за бензин")).toBeNull()
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

  it("counts days in the machine's time zone", () => {
    const lateEvening = Date.parse("2026-10-14T22:30:00Z")
    process.env.TZ = "Europe/Madrid"
    expect(dayOf(lateEvening)).toBe(day("2026-10-15"))
    expect(dueDayOf("завтра", lateEvening)).toBe(day("2026-10-16"))
    process.env.TZ = "America/New_York"
    expect(dueDayOf("завтра", lateEvening)).toBe(day("2026-10-15"))
  })
})
