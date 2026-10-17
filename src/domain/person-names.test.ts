import { describe, expect, it } from "vitest"
import { createStemmer } from "../search/stem.js"
import { cyrillicOf, findNames, findUnknownNames, nameIndex } from "./person-names.js"

const index = nameIndex(
  [
    { id: 1, names: ["Arkady Belkin"] },
    { id: 2, names: ["Аркадий Смирнов", "arkasha"] },
    { id: 3, names: ["Олег"] },
  ],
  createStemmer(),
)
const names = (text: string) => findNames(text, index).map(({ value, people }) => `${value} ${people.join(",")}`)

describe("known names in a text", () => {
  it("finds a Latin profile name written in Russian, in any case", () => {
    expect(cyrillicOf("Arkady")).toBe("аркадий")
    expect(cyrillicOf("Sergey")).toBe("сергей")
    expect(names("Передай Белкину")).toEqual(["белкин 1"])
    expect(names("Олегу скажи")).toEqual(["олег 3"])
  })

  it("takes two names in a row that one person shares as one full name", () => {
    expect(names("Аркадию Смирнову привет")).toEqual(["аркад смирнов 2"])
    expect(names("Аркадий Белкин звонил")).toEqual(["аркад белкин 1"])
    expect(findNames("Аркадий Белкин", index)[0]?.confidence).toBe(0.9)
  })

  it("gives a first name alone every person who has it", () => {
    expect(names("Аркадий придёт")).toEqual(["аркад 1,2"])
    expect(findNames("Аркадий придёт", index)[0]?.confidence).toBe(0.6)
  })

  it("ignores lower-case words, short words and names nobody has", () => {
    expect(names("олег и аркадий; Или Ира? Петрову")).toEqual([])
    expect(findNames("Аркадий", nameIndex([], createStemmer()))).toEqual([])
  })
})

describe("unknown names in a text", () => {
  const unknown = (text: string, taken: { start: number; end: number }[] = []) =>
    findUnknownNames(text, createStemmer(), taken).map(({ start, end, confidence }) => [
      text.slice(start, end),
      confidence,
    ])

  it("finds a listed first name in any case", () => {
    expect(unknown("Передай Ольге, что всё готово")).toEqual([["Ольге", 0.4]])
    expect(unknown("встретился с Дмитрием")).toEqual([["Дмитрием", 0.4]])
    expect(unknown("Ask Sarah about it")).toEqual([["Sarah", 0.4]])
  })

  it("takes the patronymic and the surname beside a first name", () => {
    expect(unknown("Иван Петрович звонил")).toEqual([["Иван Петрович", 0.5]])
    expect(unknown("от Иванова Ивана Петровича")).toEqual([["Иванова Ивана Петровича", 0.5]])
    expect(unknown("Ольга Смирнова придёт")).toEqual([["Ольга Смирнова", 0.5]])
    expect(unknown("Anzor Mamedov")).toEqual([])
    expect(unknown("call John Smith tomorrow")).toEqual([["John Smith", 0.5]])
  })

  it("takes a patronymic with the name before it, an unlisted one only inside a sentence", () => {
    expect(unknown("ждём, Анзор Мамедович")).toEqual([["Анзор Мамедович", 0.5]])
    expect(unknown("Ольга Ильинична, Петру Ильичу")).toEqual([
      ["Ольга Ильинична", 0.5],
      ["Петру Ильичу", 0.5],
    ])
    expect(unknown("Спасибо Ивановичу. Петрович сказал")).toEqual([])
  })

  it("finds no name in words that end like a patronymic", () => {
    expect(
      unknown("Отлично, спасибо. Логично. Безусловно да. Словно сон. Ежедневно. Основной вопрос. Москвич"),
    ).toEqual([])
  })

  it("keeps a name that is also a word only beside a second name", () => {
    expect(unknown("Вера в лучшее. Grace period ends")).toEqual([])
    expect(unknown("Вера Николаевна согласна")).toEqual([["Вера Николаевна", 0.5]])
  })

  it("skips what another rule already found, and words that only look like a name", () => {
    expect(unknown("Олег пишет", [{ start: 0, end: 4 }])).toEqual([])
    expect(unknown("Свет погас. Москвич стоит у дома")).toEqual([])
    expect(unknown("Жена сказала. Люди пришли")).toEqual([])
    expect(unknown("скажи Жене, или Женечке")).toEqual([["Женечке", 0.4]])
  })

  it("takes no saint's name and no city that is also a first name", () => {
    expect(unknown("мост Saint Michael's Bridge, Coves de Sant Josep, St. Patrick's Day")).toEqual([])
    expect(unknown("собор Святого Петра, образ Девы Марии")).toEqual([])
    expect(unknown("штаб остался во Владимире, офис в Милане")).toEqual([])
    expect(unknown("скажи Владимиру, что Милана приедет")).toEqual([
      ["Владимиру", 0.4],
      ["Милана", 0.4],
    ])
  })
})
