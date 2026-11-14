import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brokenKeyring, CliError, type KeyringStore, memoryKeyring, systemKeyring } from "@wirecat/cli-base"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProfileTokenStore } from "./profile-token.js"

const app = { appName: "crm-cli", command: "crm", envPrefix: "CRM", description: "A test CRM", version: "1.0.0" }

const envHere = (): NodeJS.ProcessEnv => ({ CRM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "crm-config-")) })

const storeOf = (env: NodeJS.ProcessEnv, keyring?: KeyringStore) =>
  new ProfileTokenStore({ app, env, ...(keyring ? { keyring } : {}), warn: () => {} })

describe("where the token is kept (WC-SECR-4)", () => {
  it("reads <PREFIX>_TOKEN before the keyring", () => {
    const keyring = memoryKeyring()
    const env = { ...envHere(), CRM_TOKEN: "from-env" }
    const store = storeOf(env, keyring)
    store.write("work", "from-keyring")
    expect(store.variable).toBe("CRM_TOKEN")
    expect(store.read("work")).toEqual({ secret: "from-env", source: "environment" })
  })

  it("keeps one keyring entry per profile, token:<profile> under the app's service", () => {
    const keyring = memoryKeyring()
    const store = storeOf(envHere(), keyring)
    expect(store.write("work", "work-token")).toBe("keyring")
    expect(store.write("home", "home-token")).toBe("keyring")
    expect([...keyring.entries.keys()].sort()).toEqual(["crm-cli:token:home", "crm-cli:token:work"])
    expect(store.read("home")).toEqual({ secret: "home-token", source: "keyring" })
    expect(store.remove("work")).toEqual(["keyring"])
    expect(store.read("work")).toBeUndefined()
  })

  it("falls back to a private file without asking and warns once when the keyring fails", () => {
    const warn = vi.fn()
    const store = new ProfileTokenStore({ app, env: envHere(), keyring: brokenKeyring(), warn })
    expect(store.write("work", "example-token")).toBe("file")
    expect(store.read("work")).toEqual({ secret: "example-token", source: "file" })
    expect(warn.mock.calls.filter(([text]) => String(text).includes("could not reach the OS keyring"))).toHaveLength(1)
  })

  it("keeps the token in the file when asked, and a keyring sign-in moves it back", () => {
    const keyring = memoryKeyring()
    const store = storeOf(envHere(), keyring)
    expect(store.write("work", "example-token-1")).toBe("keyring")
    expect(store.write("work", "example-token", "file")).toBe("file")
    expect(keyring.entries.size).toBe(0)
    expect(store.read("work")).toEqual({ secret: "example-token", source: "file" })
    expect(store.write("work", "example-token-2")).toBe("keyring")
    expect(store.read("work")).toEqual({ secret: "example-token-2", source: "keyring" })
  })
})

describe("signed in or not", () => {
  it("need gives the token, or session.missing naming the command that signs in", () => {
    const store = storeOf(envHere(), memoryKeyring())
    const missing = (() => {
      try {
        store.need("work")
      } catch (error) {
        return error
      }
    })()
    expect(missing).toBeInstanceOf(CliError)
    expect(missing).toMatchObject({
      code: "authentication_error",
      message: "profile work is not signed in — run `crm work session start`",
      details: { reason: "session.missing" },
    })
    store.write("work", "example-token")
    expect(store.need("work")).toBe("example-token")
  })

  it("signedIn is false, not a throw, when the keyring cannot be read", () => {
    const keyring = memoryKeyring()
    const store = storeOf(envHere(), keyring)
    expect(store.signedIn("work")).toBe(false)
    store.write("work", "example-token")
    expect(store.signedIn("work")).toBe(true)
    vi.spyOn(keyring, "get").mockImplementation(() => {
      throw new Error("the keyring is locked")
    })
    expect(store.signedIn("work")).toBe(false)
  })
})

describe("a run with a throwaway HOME (WC-SECR-24)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Credentials treats a run as moved only with the system keyring, so this stubs it in memory instead of memoryKeyring.
  const stubSystemKeyring = (saved: Record<string, string>) => ({
    set: vi.spyOn(systemKeyring, "set").mockImplementation((service, account, secret) => {
      saved[`${service}/${account}`] = secret
    }),
    delete: vi.spyOn(systemKeyring, "delete").mockImplementation((service, account) => {
      const existed = `${service}/${account}` in saved
      delete saved[`${service}/${account}`]
      return existed
    }),
    get: vi
      .spyOn(systemKeyring, "get")
      .mockImplementation((service, account) => saved[`${service}/${account}`] ?? null),
  })

  it("reads the owner's token but never writes or deletes the shared entry, also with file storage", () => {
    const saved: Record<string, string> = { "crm-cli/token:work": "owner-token" }
    const keyring = stubSystemKeyring(saved)
    const store = new ProfileTokenStore({
      app,
      env: { HOME: mkdtempSync(join(tmpdir(), "crm-home-")) },
      warn: () => {},
    })

    expect(store.read("work")).toEqual({ secret: "owner-token", source: "keyring" })
    expect(store.write("work", "throwaway-token")).toBe("keyring")
    expect(store.read("work")).toEqual({ secret: "throwaway-token", source: "keyring" })
    store.write("work", "file-token", "file")
    expect(store.remove("work")).toEqual(["file"])

    const touched = [...keyring.set.mock.calls, ...keyring.delete.mock.calls].map(([service]) => service)
    expect(touched.length).toBeGreaterThan(0)
    expect(touched).not.toContain("crm-cli")
    expect(saved["crm-cli/token:work"]).toBe("owner-token")
  })
})

describe("a second secret in the same entry", () => {
  it("**keeps a named secret beside the token in the profile's one entry**, each read on its own", () => {
    const keyring = memoryKeyring()
    const store = storeOf(envHere(), keyring)
    store.write("office", "db-password")
    expect(store.writeSecret("office", "ssh", "ssh-password")).toBe("keyring")

    expect([...keyring.entries.keys()]).toEqual(["crm-cli:token:office"])
    expect(store.read("office")).toEqual({ secret: "db-password", source: "keyring" })
    expect(store.readSecret("office", "ssh")).toEqual({ secret: "ssh-password", source: "keyring" })
    expect(store.readSecret("office", "sftp")).toBeUndefined()
  })

  it("**changes the token without losing the named secrets**, and the other way round", () => {
    const store = storeOf(envHere(), memoryKeyring())
    store.writeSecret("office", "ssh", "ssh-1")
    expect(store.read("office")).toBeUndefined()
    store.write("office", "db-1")
    store.writeSecret("office", "ssh", "ssh-2")
    store.write("office", "db-2")

    expect([store.need("office"), store.readSecret("office", "ssh")?.secret]).toEqual(["db-2", "ssh-2"])
  })

  it("**reads an entry written before as the token alone**, and stores the token alone as before", () => {
    const keyring = memoryKeyring()
    keyring.set("crm-cli", "token:work", "older-token")
    const store = storeOf(envHere(), keyring)

    expect(store.read("work")?.secret).toBe("older-token")
    store.write("work", "plain-token")
    expect(keyring.get("crm-cli", "token:work")).toBe("plain-token")
  })

  it("forgets one secret and keeps the rest; the last one gone removes the entry", () => {
    const keyring = memoryKeyring()
    const store = storeOf(envHere(), keyring)
    store.write("office", "db-password")
    store.writeSecret("office", "ssh", "ssh-password")

    expect(store.removeSecret("office", "ssh")).toEqual(["keyring"])
    expect(keyring.get("crm-cli", "token:office")).toBe("db-password")
    store.remove("office")
    store.writeSecret("office", "ssh", "ssh-password")
    store.removeSecret("office", "ssh")
    expect(keyring.entries.size).toBe(0)
  })

  it("takes a named secret from <PREFIX>_TOKEN_<NAME> first, for CI", () => {
    const store = storeOf({ ...envHere(), CRM_TOKEN_SSH: "from-env", CRM_TOKEN: "token-env" }, memoryKeyring())
    store.writeSecret("office", "ssh", "from-keyring")

    expect(store.secretVariable("ssh")).toBe("CRM_TOKEN_SSH")
    expect(store.readSecret("office", "ssh")).toEqual({ secret: "from-env", source: "environment" })
    expect(store.read("office")).toEqual({ secret: "token-env", source: "environment" })
  })

  it("keeps a file entry in the file when a named secret is added", () => {
    const keyring = memoryKeyring()
    const store = storeOf(envHere(), keyring)
    store.write("office", "db-password", "file")

    expect(store.writeSecret("office", "ssh", "ssh-password")).toBe("file")
    expect(keyring.entries.size).toBe(0)
    expect(store.readSecret("office", "ssh")).toEqual({ secret: "ssh-password", source: "file" })
  })

  it("refuses a name that is not a-z, 0-9 and -, or is token", () => {
    const store = storeOf(envHere(), memoryKeyring())
    for (const name of ["token", "SSH", "a b", ""])
      expect(() => store.writeSecret("office", name, "x")).toThrow("a secret's name")
  })

  describe("in a run with a throwaway HOME (WC-SECR-24)", () => {
    afterEach(() => vi.restoreAllMocks())

    it("**adds a named secret to a temporary entry and never touches the owner's**", () => {
      const saved: Record<string, string> = { "crm-cli/token:office": "owner-db" }
      vi.spyOn(systemKeyring, "set").mockImplementation((service, account, secret) => {
        saved[`${service}/${account}`] = secret
      })
      vi.spyOn(systemKeyring, "delete").mockImplementation((service, account) => delete saved[`${service}/${account}`])
      vi.spyOn(systemKeyring, "get").mockImplementation((service, account) => saved[`${service}/${account}`] ?? null)
      const store = new ProfileTokenStore({
        app,
        env: { HOME: mkdtempSync(join(tmpdir(), "crm-home-")) },
        warn: () => {},
      })

      store.writeSecret("office", "ssh", "throwaway-ssh")
      expect([store.read("office")?.secret, store.readSecret("office", "ssh")?.secret]).toEqual([
        "owner-db",
        "throwaway-ssh",
      ])
      store.removeSecret("office", "ssh")
      store.remove("office")

      expect(saved["crm-cli/token:office"]).toBe("owner-db")
      expect(Object.keys(saved)).toEqual(["crm-cli/token:office"])
    })
  })
})
