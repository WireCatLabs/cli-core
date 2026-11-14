import { describe, expect, it } from "vitest"
import {
  addProvider,
  holdsKind,
  isKind,
  KINDS,
  kindIn,
  kindOf,
  kindsIn,
  PROVIDERS,
  providerEntryOf,
  providerNamed,
  useProviders,
} from "./providers.js"

describe("the provider registry", () => {
  it("gives every provider one kind and every name or alias one provider", () => {
    for (const { kind } of PROVIDERS) expect(KINDS).toContain(kind)
    const words = PROVIDERS.flatMap(({ name, aliases }) => [name, ...aliases])
    expect(new Set(words).size).toBe(words.length)
  })

  it("names gcal as the tool that holds Google Meet meetings", () => {
    expect(providerNamed("google-meet")?.command).toBe("gcal")
  })

  it("resolves an alias to its provider and a provider to its kind", () => {
    expect(providerNamed("TG")?.name).toBe("telegram")
    expect(providerNamed("tg-bot")?.name).toBe("telegram-bot")
    expect(providerNamed("wa-bot")?.name).toBe("whatsapp-bot")
    expect(kindOf("zoom")).toBe("meetings")
    expect(kindOf("email")).toBe("mail")
    expect(kindOf("folder")).toBe("notes")
    expect(kindOf("a-messenger-of-a-consumer")).toBe("messages")
    expect(kindIn("a-messenger-of-a-consumer")).toBeUndefined()
    expect(isKind("events")).toBe(true)
    expect(isKind("Documents")).toBe(true)
    expect(isKind("telegram")).toBe(false)
  })

  it("lets one provider hold several kinds, the first its kind, and leaves a one-kind entry as it was", () => {
    expect(kindsIn("phone")).toEqual(["messages", "events", "documents"])
    expect(kindIn("phone")).toBe("messages")
    expect(kindsIn("import")).toEqual(["documents", "messages", "events"])
    expect(holdsKind("phone", "events")).toBe(true)
    expect(kindsIn("telegram")).toEqual(["messages"])
    expect(holdsKind("telegram", "events")).toBe(false)
    expect(kindsIn("a-messenger-of-a-consumer")).toEqual([])
    expect(providerEntryOf({ name: "gcal", kind: "events" })).toEqual({ name: "gcal", kind: "events", aliases: [] })
    expect(providerEntryOf({ name: "box", kinds: ["mail", "notes"] })).toMatchObject({
      kind: "mail",
      kinds: ["mail", "notes"],
    })
    expect(() => providerEntryOf({ name: "box", kind: "notes", kinds: ["mail", "notes"] })).toThrow(
      /first of its kinds/,
    )
    expect(() => providerEntryOf({ name: "box", kinds: [] })).toThrow(/kind is one of/)
  })

  it("joins an older one-kind entry to a provider that holds more, and still refuses one that disagrees", () => {
    try {
      useProviders([{ name: "phone", kind: "messages", aliases: ["mobile"] }])
      expect(kindsIn("phone")).toEqual(["messages", "events", "documents"])
      expect(providerNamed("mobile")?.name).toBe("phone")
      expect(() => addProvider({ name: "phone", kind: "events", aliases: [] })).toThrow(/disagree on the kind/)
      expect(() => addProvider({ name: "telegram", kind: "events", aliases: [] })).toThrow(/disagree on the kind/)
    } finally {
      useProviders([])
    }
  })
})
