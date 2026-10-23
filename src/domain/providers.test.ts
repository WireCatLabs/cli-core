import { describe, expect, it } from "vitest"
import { isKind, KINDS, kindOf, PROVIDERS, providerNamed } from "./providers.js"

describe("the provider registry", () => {
  it("gives every provider one kind and every name or alias one provider", () => {
    for (const { kind } of PROVIDERS) expect(KINDS).toContain(kind)
    const words = PROVIDERS.flatMap(({ name, aliases }) => [name, ...aliases])
    expect(new Set(words).size).toBe(words.length)
  })

  it("resolves an alias to its provider and a provider to its kind", () => {
    expect(providerNamed("TG")?.name).toBe("telegram")
    expect(providerNamed("tg-bot")?.name).toBe("telegram-bot")
    expect(providerNamed("wa-bot")?.name).toBe("whatsapp-bot")
    expect(kindOf("zoom")).toBe("meetings")
    expect(kindOf("email")).toBe("mail")
    expect(kindOf("folder")).toBe("notes")
    expect(kindOf("a-messenger-of-a-consumer")).toBe("messages")
    expect(isKind("Documents")).toBe(true)
    expect(isKind("telegram")).toBe(false)
  })
})
