import { describe, expect, it } from "vitest"
import { type BotSubject, type StoredActivity, scorePerson } from "./check.js"
import { askCas, askLols, askRegistries, notCovered } from "./registries.js"

const NOW = new Date("2026-10-06T12:00:00.000Z")
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()

const person: BotSubject = {
  id: "42",
  name: "Ana Pérez",
  usernames: ["ana"],
  bio: "teacher",
  flags: { bot: false, scam: false, fake: false, deleted: false },
  hasPhoto: true,
  registered: { at: daysAgo(900), source: "telegram" },
}
const said = (chatId: string, text: string, days = 5) => ({
  chatId,
  text,
  timestamp: daysAgo(days),
  forwardedFrom: null,
})
const activity = (messages: StoredActivity["messages"], complete = true): StoredActivity => ({
  messages,
  complete,
  chatsStored: 2,
})
const reasonsOf = (check: ReturnType<typeof scorePerson>) => check.reasons.map(({ reason }) => reason).sort()

describe("scoring one person", () => {
  it("finds nothing in an ordinary profile with ordinary messages", () => {
    const check = scorePerson({
      subject: person,
      provider: "telegram",
      activity: activity([said("1", "see you at seven")]),
      photos: { count: 3, oldestAt: daysAgo(800) },
      registries: [],
      now: NOW,
    })
    expect(check.reasons).toEqual([])
    expect(check.score).toBe(0)
    expect(check.unknown).toEqual([])
  })

  it.each([
    ["bot", { flags: { ...person.flags, bot: true } }],
    ["scam", { flags: { ...person.flags, scam: true } }],
    ["fake", { flags: { ...person.flags, fake: true } }],
    ["deleted", { flags: { ...person.flags, deleted: true } }],
    ["no_photo", { hasPhoto: false }],
    ["no_username", { usernames: [] }],
    ["odd_name", { name: "user 4815162342" }],
    ["no_bio", { bio: "" }],
    ["new_account", { registered: { at: daysAgo(3), source: "estimate" } }],
  ] as const)("reads %s from the profile", (reason, change) => {
    const check = scorePerson({
      subject: { ...person, ...change },
      provider: "telegram",
      activity: activity([said("1", "hello there")]),
      photos: { count: 3, oldestAt: daysAgo(800) },
      registries: [],
      now: NOW,
    })
    expect(reasonsOf(check)).toEqual([reason])
  })

  it("labels a young account with where its date came from", () => {
    const check = scorePerson({
      subject: { ...person, registered: { at: daysAgo(3), source: "estimate" } },
      provider: "telegram",
      registries: [],
      now: NOW,
    })
    expect(check.reasons.find(({ reason }) => reason === "new_account")).toMatchObject({ source: "estimate" })
  })

  it("reads photo_recent from the oldest photo, never_wrote, link_first and same_text from the store", () => {
    const spam = "Earn 500 a day from home, write to me now for details"
    const check = scorePerson({
      subject: person,
      provider: "telegram",
      activity: activity([said("1", spam, 1), said("2", spam, 2), { ...said("3", "https://example.test/x", 3) }]),
      photos: { count: 1, oldestAt: daysAgo(4) },
      registries: [],
      now: NOW,
    })
    expect(reasonsOf(check)).toEqual(["link_first", "photo_recent", "same_text"])
    expect(check.reasons.find(({ reason }) => reason === "same_text")?.detail).toBe("one text in 2 chats")

    const silent = scorePerson({ subject: person, provider: "telegram", activity: activity([]), registries: [] })
    expect(reasonsOf(silent)).toContain("never_wrote")
  })

  it("says what it could not judge rather than guessing", () => {
    const check = scorePerson({
      subject: { id: "42", name: "Ana", usernames: ["ana"] },
      provider: "max",
      registries: [],
      now: NOW,
    })
    expect(check.reasons).toEqual([])
    expect(check.unknown).toEqual(
      expect.arrayContaining(["bot", "no_photo", "no_bio", "new_account", "photo_recent", "never_wrote"]),
    )
  })

  it("does not call a first message a link when the store holds only part of what they wrote", () => {
    const check = scorePerson({
      subject: person,
      provider: "telegram",
      activity: activity([said("1", "https://example.test")], false),
      registries: [],
      now: NOW,
    })
    expect(reasonsOf(check)).toEqual([])
    expect(check.unknown).toContain("link_first")
  })

  it("adds a registry's listing with the registry named", () => {
    const check = scorePerson({
      subject: person,
      provider: "telegram",
      registries: [
        { name: "lols", answer: "listed", checkedAt: NOW.toISOString(), reasons: ["lols_banned", "lols_scammer"] },
      ],
      now: NOW,
    })
    expect(check.reasons.map(({ reason, source }) => [reason, source])).toEqual([
      ["lols_banned", "registry:lols"],
      ["lols_scammer", "registry:lols"],
    ])
    expect(check.score).toBe(6)
  })
})

const answering =
  (status: number, body: unknown, seen: { url: string; headers: Record<string, string> }[] = []): typeof fetch =>
  async (input, init) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  }

describe("the public ban lists", () => {
  it("reads CAS: not found is clean, a result is a listing, 401 asks for a key", async () => {
    expect(await askCas("7", { fetch: answering(200, { ok: false, description: "Record not found." }) })).toMatchObject(
      { name: "cas", answer: "clean" },
    )
    expect(
      await askCas("7", {
        fetch: answering(200, { ok: true, result: { offenses: 4, time_added: "2026-01-01T00:00:00.000Z" } }),
      }),
    ).toMatchObject({
      answer: "listed",
      reasons: ["cas_banned"],
      detail: "banned, 4 offenses, since 2026-01-01T00:00:00.000Z",
    })
    expect(await askCas("7", { fetch: answering(401, { ok: false }) })).toMatchObject({
      answer: "unknown",
      detail: "now asks for a key from combot.org",
    })
  })

  it("sends a CAS key in a header, never in the address, and never says it", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const answer = await askCas("7", { casKey: "SECRET-KEY", fetch: answering(401, { ok: false }, seen) })
    expect(seen[0]?.url).not.toContain("SECRET-KEY")
    expect(seen[0]?.headers.authorization).toBe("Bearer SECRET-KEY")
    expect(JSON.stringify(answer)).not.toContain("SECRET-KEY")

    const failing: typeof fetch = async (input) => {
      throw new Error(`connect failed for ${String(input)} with SECRET-KEY`)
    }
    expect(JSON.stringify(await askCas("7", { casKey: "SECRET-KEY", fetch: failing }))).not.toContain("SECRET")
  })

  it("reads lols.bot: banned and scammer are listings, a bad answer is unknown", async () => {
    expect(await askLols("7", { fetch: answering(200, { ok: true, user_id: 7, banned: false }) })).toMatchObject({
      answer: "clean",
    })
    expect(
      await askLols("7", {
        fetch: answering(200, { ok: true, user_id: 7, banned: true, scammer: true, offenses: 12, spam_factor: 55.6 }),
      }),
    ).toMatchObject({ answer: "listed", reasons: ["lols_banned", "lols_scammer"] })
    expect(await askLols("7", { fetch: answering(500, "oops") })).toMatchObject({ answer: "unknown" })
  })

  it("answers for the rest when one is down", async () => {
    const mixed: typeof fetch = async (input) => {
      if (String(input).includes("cas.chat")) throw new TypeError("fetch failed")
      return new Response(JSON.stringify({ ok: true, user_id: 7, banned: false }), { status: 200 })
    }
    const answers = await askRegistries("7", { fetch: mixed })
    expect(answers.map(({ name, answer, detail }) => [name, answer, detail])).toEqual([
      ["cas", "unknown", "unreachable"],
      ["lols", "clean", undefined],
    ])
  })

  it("says a non-Telegram account is not in them", () => {
    expect(notCovered("WhatsApp").map(({ answer, detail }) => [answer, detail])).toEqual([
      ["unknown", "lists Telegram accounts only, not WhatsApp ones"],
      ["unknown", "lists Telegram accounts only, not WhatsApp ones"],
    ])
  })
})
