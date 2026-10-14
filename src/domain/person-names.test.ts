import { describe, expect, it } from "vitest"
import { createStemmer } from "../search/stem.js"
import { cyrillicOf, findNames, nameIndex } from "./person-names.js"

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
