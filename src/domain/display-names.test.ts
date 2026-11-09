import { describe, expect, it } from "vitest"
import { displayName, nameKey } from "./display-names.js"

describe("displayName", () => {
  it("drops wrapping quotes and spaces, nested ones too", () => {
    expect(displayName('"CZECH AIRLINES "')).toBe("CZECH AIRLINES")
    expect(displayName("  «“Acme   Ltd”»  ")).toBe("Acme Ltd")
    expect(displayName("O'Brien")).toBe("O'Brien")
  })

  it("gives a name with no letter or digit way to the username, then the phone, then the email", () => {
    expect(displayName("!", { username: "rin", phone: "+34600000000" })).toBe("@rin")
    expect(displayName("!$", { phone: "+34600000000", email: "rin@example.test" })).toBe("+34600000000")
    expect(displayName(null, { email: "rin@example.test" })).toBe("rin@example.test")
    expect(displayName("!", {})).toBe("!")
    expect(displayName("   ", {})).toBeNull()
  })
})

describe("nameKey", () => {
  it("ignores case, quotes, punctuation and word order", () => {
    expect(nameKey('"Ivanov Ivan"')).toBe(nameKey("ivan IVANOV"))
    expect(nameKey("Ivanov, Ivan.")).toBe("ivan ivanov")
    expect(nameKey("Ёлкин Пётр")).toBe(nameKey("пётр ёлкин"))
  })

  it("has no key for a name with nothing to read", () => {
    expect(nameKey("!$")).toBeNull()
    expect(nameKey(undefined)).toBeNull()
  })
})
