import { afterEach, describe, expect, it } from "vitest"
import { providerEntryOf, providerNamed, useProviders } from "./providers.js"
import { openOf, type ProfilesFor, type RefSummary, refLabel } from "./ref-summaries.js"

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
  title: "Задачи SEO Neirox",
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
