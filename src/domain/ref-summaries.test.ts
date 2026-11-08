import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openStore } from "../store/store.js"
import { providerEntryOf, providerNamed, useProviders } from "./providers.js"
import {
  openOf,
  type ProfilesFor,
  type RefSummary,
  refLabel,
  storedProfilesFor,
  writesWithOf,
} from "./ref-summaries.js"

afterEach(() => useProviders([]))

const chat: RefSummary = {
  ref: "chat:max/34871122/63488582",
  kind: "chat",
  title: "Сайт + автоматизация",
  in: "MAX",
  at: null,
  provider: "max",
  account: "34871122",
  tool: "max",
  state: "available",
}
const document: RefSummary = {
  ...chat,
  ref: "document:413",
  kind: "document",
  title: "Задачи SEO Example",
  in: "Google Drive",
  provider: "google-drive",
  account: "owner@example.com",
  tool: null,
}
const note: RefSummary = { ...chat, ref: "note:7", kind: "note", title: "Call notes", in: null, provider: "notes" }

const one: ProfilesFor = () => ({ profile: "default" })
const two: ProfilesFor = (provider, account) => ({
  why: `2 ${provider} profiles are signed in to account ${account}: default, docs-shots`,
  profiles: ["default", "docs-shots"],
})

describe("openOf", () => {
  it("names the one signed-in profile", () => {
    expect(openOf(chat, { profilesFor: one })).toEqual({
      argv: ["max", "default", "messages", "list", "chat:max/34871122/63488582"],
      profiles: ["default"],
      why: null,
    })
  })

  it("**never picks between two profiles**: argv keeps <profile> and lists the choices", () => {
    const asked: [string, string | null][] = []
    const open = openOf(chat, {
      profilesFor: (provider, account) => {
        asked.push([provider, account])
        return two(provider, account)
      },
    })
    expect(asked).toEqual([["max", "34871122"]])
    expect(open).toEqual({
      argv: ["max", "<profile>", "messages", "list", "chat:max/34871122/63488582"],
      profiles: ["default", "docs-shots"],
      why: "2 max profiles are signed in to account 34871122: default, docs-shots",
    })
  })

  it("gives no argv for a provider no CLI has registered, and opens it once one has", () => {
    expect(openOf(document, { profilesFor: one })).toEqual({
      argv: null,
      profiles: [],
      why: "no CLI has registered google-drive in this store yet; run its CLI once",
    })
    useProviders([
      { name: "google-drive", kind: "documents", aliases: [], command: "drive", opens: { document: "documents show" } },
    ])
    expect(openOf(document, { profilesFor: () => ({ profile: "personal" }) }).argv).toEqual([
      "drive",
      "personal",
      "documents",
      "show",
      "document:413",
    ])
  })

  it("opens a kind no provider holds with the caller's own words, and refuses an unknown ref", () => {
    expect(openOf(note, { profilesFor: one, local: { note: ["memo", "notes", "show"] } })).toEqual({
      argv: ["memo", "notes", "show", "note:7"],
      profiles: [],
      why: null,
    })
    expect(openOf({ ...note, provider: null }, { profilesFor: one }).argv).toBeNull()
    expect(openOf({ ...note, ref: "doc:413", kind: "unknown" }, { profilesFor: one }).why).toBe(
      "doc:413 is not a reference",
    )
  })

  it("opens mail through the message and chat words of the email provider", () => {
    useProviders([{ name: "email", kind: "mail", aliases: [], command: "mail", opens: { message: "mail show" } }])
    const email: RefSummary = { ...chat, ref: "msg:email/a/t/e", kind: "email", provider: "email", account: "a" }
    expect(openOf(email, { profilesFor: one }).argv).toEqual(["mail", "default", "mail", "show", "msg:email/a/t/e"])
  })
})

describe("refLabel", () => {
  it("reads alike for every kind and says when a ref is gone", () => {
    expect(refLabel(chat)).toBe("Chat «Сайт + автоматизация» (MAX)")
    expect(refLabel({ ...note, state: "deleted" })).toBe("Note «Call notes» (deleted)")
    expect(refLabel({ ...chat, title: null, in: null, state: "unavailable" })).toBe(
      "Chat chat:max/34871122/63488582 (unavailable)",
    )
    expect(refLabel({ ...chat, title: "two\nlines" })).toBe("Chat «two lines» (MAX)")
  })
})

describe("a provider entry's opens", () => {
  it("messengers open chats, messages and contacts from the seed", () => {
    for (const name of ["telegram", "max", "whatsapp"])
      expect(providerNamed(name)?.opens).toEqual({
        chat: "messages list",
        message: "messages show",
        contact: "contacts show",
      })
  })

  it("drops a kind this build does not know and refuses what is not command words", () => {
    const entry = { name: "notion", kind: "documents", aliases: [], command: "notion" }
    expect(providerEntryOf({ ...entry, opens: { document: "pages show", page: "pages show" } }).opens).toEqual({
      document: "pages show",
    })
    expect(() => providerEntryOf({ ...entry, opens: { document: "pages show; rm" } })).toThrow("command words")
    expect(() => providerEntryOf({ ...entry, opens: ["pages show"] })).toThrow("maps a kind")
  })

  it("a stored entry adds kinds to the seed's opens instead of replacing them", () => {
    useProviders([{ name: "max", kind: "messages", aliases: [], opens: { bot: "bots show" } }])
    expect(providerNamed("max")?.opens).toMatchObject({ chat: "messages list", bot: "bots show" })
  })
})

describe("writesWithOf over the store's profiles", () => {
  const portal = { provider: "bitrix24", account: "northstar.example" }
  const other = { provider: "bitrix24", account: "south.example" }

  const withStore = async (profiles: [string, typeof portal][]) => {
    const directory = mkdtempSync(join(tmpdir(), "writes-with-"))
    const store = await openStore({ path: join(directory, "store.db") })
    try {
      await store.accounts.registerProvider({ name: "bitrix24", kind: "crm", aliases: ["b24"], command: "b24" })
      for (const [profile, key] of profiles) await store.accounts.saveProfile("b24", profile, key)
      return storedProfilesFor(await store.accounts.profiles())
    } finally {
      await store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }

  it("names the one profile on the row's account", async () => {
    const profilesFor = await withStore([
      ["work", portal],
      ["south", other],
    ])
    expect(writesWithOf(portal, profilesFor)).toEqual({ tool: "b24", profile: "work", profiles: ["work"], why: null })
  })

  it("**never picks between two profiles** on one account", async () => {
    const profilesFor = await withStore([
      ["work", portal],
      ["sales", portal],
    ])
    expect(writesWithOf(portal, profilesFor)).toEqual({
      tool: "b24",
      profile: null,
      profiles: ["work", "sales"],
      why: "2 b24 profiles are on bitrix24:northstar.example: work, sales; the owner chooses one",
    })
  })

  it("lists no profile of another account, and says how to add one", async () => {
    const profilesFor = await withStore([["south", other]])
    expect(writesWithOf(portal, profilesFor)).toEqual({
      tool: "b24",
      profile: null,
      profiles: [],
      why: "no b24 profile has run on bitrix24:northstar.example here; run `b24 <profile>` with it once",
    })
  })

  it("is null for the owner's own row and names no tool for a provider no CLI registered", async () => {
    const profilesFor = await withStore([])
    expect(writesWithOf(null, profilesFor)).toBeNull()
    expect(writesWithOf({ provider: "amocrm", account: "x.example" }, profilesFor)).toEqual({
      tool: null,
      profile: null,
      profiles: [],
      why: "no CLI has registered amocrm in this store yet; run its CLI once",
    })
  })
})
