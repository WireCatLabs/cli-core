import { describe, expect, it } from "vitest"
import { brokenKeyring, memoryKeyring, systemKeyring } from "./keyring.js"

describe("memoryKeyring", () => {
  it("stores, reads and deletes per service and account", () => {
    const keyring = memoryKeyring()

    keyring.set("max-cli", "default", "secret-a")
    keyring.set("max-cli", "personal", "secret-b")

    expect(keyring.get("max-cli", "default")).toBe("secret-a")
    expect(keyring.get("max-cli", "personal")).toBe("secret-b")
    expect(keyring.delete("max-cli", "default")).toBe(true)
    expect(keyring.get("max-cli", "default")).toBeNull()
  })

  it("answers null for an entry that was never written, rather than throwing", () => {
    expect(memoryKeyring().get("max-cli", "absent")).toBeNull()
  })

  it("keeps two services apart under the same account name", () => {
    const keyring = memoryKeyring()
    keyring.set("max-cli", "default", "one")
    keyring.set("other-cli", "default", "two")
    expect(keyring.get("max-cli", "default")).toBe("one")
  })
})

describe("brokenKeyring", () => {
  it("refuses every operation, so the file fallback has something to be tested against", () => {
    const keyring = brokenKeyring()
    expect(() => keyring.get("max-cli", "default")).toThrow(/no secret service/)
    expect(() => keyring.set("max-cli", "default", "x")).toThrow()
    expect(() => keyring.delete("max-cli", "default")).toThrow()
  })
})

describe("systemKeyring", () => {
  it("cannot reach the real keychain from a test", () => {
    expect(() => systemKeyring.get("cli-core-test", "default")).toThrow(/real OS keyring/)
    expect(() => systemKeyring.set("cli-core-test", "default", "x")).toThrow(/real OS keyring/)
    expect(() => systemKeyring.delete("cli-core-test", "default")).toThrow(/real OS keyring/)
  })
})
