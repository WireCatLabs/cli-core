import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { openStore } from "../../store/store.js"
import { openCrmStore } from "./store.js"

const app = { command: "crm", appName: "crm-cli", envPrefix: "CRM", description: "x", version: "1.0.0" }
const PORTAL = { provider: "example-crm", account: "portal.example.com" }

const setup = (extra: NodeJS.ProcessEnv = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-store-")), "wirecat.db")
  const env = { MESSAGING_STORE: path, ...extra }
  const account = vi.fn(() => PORTAL)
  const opened: string[] = []
  const open = (at: NodeJS.ProcessEnv, options?: { readOnly?: boolean }) => {
    opened.push(at.MESSAGING_STORE ?? "")
    return openStore({ env: at, ...(options?.readOnly ? { readOnly: true } : {}) })
  }
  const crmStore = (readOnly: boolean) =>
    openCrmStore({ app, env, profile: "work", readOnly, provider: PORTAL.provider, open, account })
  return { path, account, opened, crmStore }
}

describe("the store a CRM command opens", () => {
  it("saves the profile on the first run, then reads its account without asking the sign-in", async () => {
    const { account, crmStore } = setup()
    const first = await crmStore(true)
    expect(first.account).toEqual(PORTAL)
    await first.store.close()
    expect(account).toHaveBeenCalledTimes(1)
    const again = await crmStore(true)
    try {
      expect(again.account).toEqual(PORTAL)
      expect(account).toHaveBeenCalledTimes(1)
      expect((await again.store.accounts.storedAccount(PORTAL)).scope).toBe("work")
    } finally {
      await again.store.close()
    }
  })

  it("under the read-only lock, reads an empty store in a folder it removes, and creates no store file", async () => {
    const { path, account, opened, crmStore } = setup({ CRM_READ_ONLY: "1" })
    const { store, account: key } = await crmStore(true)
    const temporary = opened.at(-1) ?? ""
    expect(temporary).not.toBe(path)
    expect(existsSync(temporary)).toBe(true)
    expect(key).toEqual({ provider: PORTAL.provider, account: "work" })
    await store.close()
    expect(existsSync(temporary)).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(account).not.toHaveBeenCalled()
  })

  it("under the read-only lock, a sync still opens the real store for writing", async () => {
    const { path, crmStore } = setup({ CRM_READ_ONLY: "1" })
    const { store } = await crmStore(false)
    await store.close()
    expect(existsSync(path)).toBe(true)
  })
})
