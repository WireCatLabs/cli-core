import { describe, expect, it } from "vitest"
import type { Chat, Contact } from "./domain/models.js"
import { type PeopleLookup, pickChat, pickPerson } from "./resolve.js"

const chat = (id: string, title: string): Chat => ({
  id,
  title,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 2,
})

describe("a chat named by its title", () => {
  it("resolves a full exact title when no other title contains it", () => {
    expect(pickChat("мама", [chat("1", "Мама"), chat("2", "Папа")]).id).toBe("1")
  })

  it("asks which one when an exact title is also part of another title", () => {
    expect(() => pickChat("Мама", [chat("1", "Мама"), chat("2", "Мама Иванова")])).toThrow(/matches 2 chats/)
  })

  it("finds a title whether or not the typed emoji carries a presentation mark", () => {
    expect(pickChat("Семья❤\uFE0F", [chat("1", "Семья❤"), chat("2", "Работа")]).id).toBe("1")
    expect(pickChat("семья❤", [chat("1", "Семья❤\uFE0F")]).id).toBe("1")
  })

  it("finds a title typed with a composed letter when it is stored as letter plus accent", () => {
    expect(pickChat("Йога", [chat("1", "И\u0306ога")]).id).toBe("1")
  })

  it("lists each candidate on one line, so a title cannot add a row of its own", () => {
    const forged = "Работа\n  999  Работа (настоящая)"
    let message = ""
    try {
      pickChat("Работа", [chat("1", "Работа отдел"), chat("2", forged)])
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.split("\n")).toHaveLength(3)
    expect(message).toContain("Работа\\x0a  999")
  })
})

describe("a person named by name or @username", () => {
  const person = (id: string, name: string, username: string | null = null): Contact => ({
    id,
    name,
    username,
    description: null,
    lastMessagedAt: null,
  })
  const people = [person("-5", "Иван Петров", "ivanp"), person("7", "Иван Сидоров")]
  const lookup: PeopleLookup = { get: (id) => people.find((one) => one.id === id), all: () => people }

  it("takes an exact @username over a name fragment", () => {
    expect(pickPerson("@ivanp", lookup).id).toBe("-5")
  })

  it("finds a name whatever presentation mark its emoji carries", () => {
    const marked = [person("9", "Оля 🌸\uFE0F")]
    expect(pickPerson("оля 🌸", { get: () => undefined, all: () => marked }).id).toBe("9")
  })

  it("takes a negative id as an id, not a name", () => {
    expect(pickPerson("-5", lookup).name).toBe("Иван Петров")
  })

  it("takes an id that is not digits as an id, as another messenger may hand out", () => {
    const opaque = [...people, person("u_9f2", "Олег")]
    expect(pickPerson("u_9f2", { get: (id) => opaque.find((one) => one.id === id), all: () => opaque }).name).toBe(
      "Олег",
    )
  })

  it("says nobody is known for a digit id it has not seen, rather than matching it as a name", () => {
    expect(() => pickPerson("404", lookup)).toThrow(/no person 404/)
  })

  it("asks which one when a fragment matches two", () => {
    expect(() => pickPerson("Иван", lookup)).toThrow(/matches 2 people/)
  })

  it("takes this messenger's contact reference as the id, and refuses another messenger's", () => {
    const telegram = { ...lookup, provider: "telegram" }
    expect(pickPerson("contact:telegram/-5", telegram).name).toBe("Иван Петров")
    expect(() => pickPerson("contact:telegram/404", telegram)).toThrow(/no person 404/)
    expect(() => pickPerson("contact:max/-5", telegram)).toThrow(
      /is a MAX contact; open it with max <profile> contacts show/,
    )
  })
})
