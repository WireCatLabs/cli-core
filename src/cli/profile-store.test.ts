import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { openContentStore } from "../content/index.js"
import { openCrmStore } from "../crm/cli/index.js"
import { openStore } from "../store/store.js"
import { openProfileStore } from "./profile-store.js"

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
    openProfileStore({ app, env, profile: "work", readOnly, provider: PORTAL.provider, open, account })
  return { path, account, opened, crmStore }
}

describe("the store a CRM command opens", () => {
  it("saves the profile on the first run, then reads its account without asking the sign-in", async () => {
    const { account, crmStore } = setup()
    const first = await crmStore(true)
    expect(first.account).toEqual(PORTAL)
    expect((await first.store.accounts.storedAccount(PORTAL)).id).toBe(first.accountId)
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

describe("the store a phone system's command opens, whose account is the profile", () => {
  const phone = (extra: NodeJS.ProcessEnv = {}) => {
    const path = join(mkdtempSync(join(tmpdir(), "pbx-store-")), "wirecat.db")
    const env = { MESSAGING_STORE: path, ...extra }
    const opened: string[] = []
    const open = (at: NodeJS.ProcessEnv, options?: { readOnly?: boolean }) => {
      opened.push(at.MESSAGING_STORE ?? "")
      return openStore({ env: at, ...(options?.readOnly ? { readOnly: true } : {}) })
    }
    const pbxStore = (readOnly: boolean, saves?: boolean) =>
      openProfileStore({
        app: { ...app, command: "pbx", envPrefix: "PBX" },
        env,
        profile: "office",
        readOnly,
        provider: "asterisk",
        open,
        name: "office",
        ...(saves === undefined ? {} : { saves }),
      })
    return { path, env, opened, pbxStore }
  }
  const OFFICE = { provider: "asterisk", account: "office" }

  it("answers the account's id, and saves a new account with the profile's name", async () => {
    const { pbxStore } = phone()
    const { store, account, accountId } = await pbxStore(false)
    try {
      expect(account).toEqual(OFFICE)
      expect(await store.accounts.storedAccount(OFFICE)).toMatchObject({ id: accountId, name: "office", scope: "work" })
    } finally {
      await store.close()
    }
  })

  it("under the read-only lock, reads an account an older build saved with no profile", async () => {
    const { env, path, opened, pbxStore } = phone({ PBX_READ_ONLY: "1" })
    const older = await openStore({ env })
    const id = await older.accounts.saveAccount(OFFICE, { name: "office" })
    await older.close()
    const { store, accountId } = await pbxStore(true)
    try {
      expect(accountId).toBe(id)
      expect(opened).toEqual([path])
    } finally {
      await store.close()
    }
  })

  it("with saves false, a read of a profile no run saved writes nothing, store file included", async () => {
    const { path, pbxStore } = phone()
    const { store, account } = await pbxStore(true, false)
    expect(account).toEqual(OFFICE)
    await store.close()
    expect(existsSync(path)).toBe(false)
  })

  it("with saves false, a writable open saves no account, and finds one a sync saved", async () => {
    const { path, opened, pbxStore } = phone()
    const first = await pbxStore(false, false)
    await first.store.close()
    expect(opened.at(-1)).not.toBe(path)
    const synced = await pbxStore(false)
    await synced.store.close()
    const again = await pbxStore(false, false)
    try {
      expect(again.accountId).toBe(synced.accountId)
      expect(opened.at(-1)).toBe(path)
    } finally {
      await again.store.close()
    }
  })
})

it("is the store a CRM command and a content command open", () => {
  expect(openCrmStore).toBe(openProfileStore)
  expect(openContentStore).toBe(openProfileStore)
})
