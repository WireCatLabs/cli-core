import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { type MessageStore, openStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import { proposalRegistry } from "../proposals/registry.js"
import { aliasHits } from "./alias-hits.js"
import { chatSenders } from "./chat-senders.js"
import { chatTitle } from "./chat-title.js"
import { emailDomain } from "./email-domain.js"
import { mailThread } from "./mail-thread.js"
import { memberChats } from "./member-chats.js"
import { memberDialog } from "./member-dialog.js"
import { combinedScore, SCAN_BOT, scanProjectLinks } from "./scan.js"
import type { LinkScorer, ScorerInput } from "./types.js"

const handles: MessageStore[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const TG: AccountKey = { provider: "telegram", account: "2" }
const MAX: AccountKey = { provider: "max", account: "1" }
const MAIL: AccountKey = { provider: "email", account: "owner@synthetic.test" }
const SINCE = "2026-10-05T00:00:00.000Z"

const chat = (id: string, title: string, kind: Chat["kind"] = "group"): Chat => ({
  id,
  title,
  kind,
  unreadCount: 0,
  lastMessageAt: "2026-10-20T00:00:00.000Z",
  participantsCount: null,
})

const texts: string[] = []
let next = 1
const message = (chatId: string, senderId: string, text: string, day = 10): Message => {
  texts.push(text)
  const id = String(next++)
  return {
    id,
    chatId,
    senderId,
    senderName: "Dana Reed",
    timestamp: `2026-10-${String(day).padStart(2, "0")}T10:00:${String(Number(id) % 60).padStart(2, "0")}.000Z`,
    editedAt: null,
    text,
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  }
}

const save = (store: MessageStore, key: AccountKey, chatId: string, messages: Message[]) =>
  store.messages.saveMessages(key, chatId, messages, { via: "history" })

/** Mail contacts are the addresses the account has a one-to-one thread with. */
const mailContacts = async (store: MessageStore, addresses: string[]) => {
  await store.people.savePeople(
    MAIL,
    addresses.map((id) => ({ id, name: null })),
  )
  await store.chats.saveChats(
    MAIL,
    addresses.map((id) => chat(id, id, "dialog")),
  )
  for (const id of addresses) await store.roster.saveMembers(MAIL, id, [id])
}

const personOf = async (store: MessageStore, provider: string, id: string) =>
  `person:${(await store.people.personOf({ provider, id }))?.uid}`

/**
 * Harbour Clinic (HRB, alias «Harbour»). Confirmed: Dana (telegram 77), Lee (telegram 79) and the chat «Ops». Another
 * Dana Reed (telegram 78) is a different person who writes in «Ops»; the owner is telegram 1.
 */
const fixture = async () => {
  let clock = Date.parse("2026-11-01T00:00:00.000Z")
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "link-scan-")), "store.db"),
    now: () => clock++,
    decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
  })
  handles.push(store)
  for (const key of [TG, MAX, MAIL]) await store.accounts.saveAccount(key, { name: null })
  const project = await store.knowledge.addProject({ name: "Harbour Clinic", key: "HRB" })
  await store.knowledge.addVocabularyAlias({ kind: "project", id: project.id }, "Harbour")
  const other = await store.knowledge.addProject({ name: "Quay Works", key: "QWK" })
  await store.people.savePeople(TG, [
    { id: "1", name: "Owner Example" },
    { id: "77", name: "Dana Reed", username: "dana" },
    { id: "78", name: "Dana Reed" },
    { id: "79", name: "Lee Park" },
    { id: "80", name: "Sam Quiet" },
  ])
  await store.people.linkToOwner({ provider: "telegram", id: "1" })
  await store.chats.saveChats(TG, [
    chat("-500", "Harbour site + CRM"),
    chat("-510", "HRB sales"),
    chat("-520", "Harbourside walks"),
    chat("-600", "Coffee"),
    chat("-610", "Book club"),
    chat("-700", "Random"),
    chat("-900", "Ops"),
    chat("77", "Dana Reed", "dialog"),
    chat("78", "Dana Reed", "dialog"),
    chat("1", "Saved", "saved"),
  ])
  await store.chats.saveChats(MAX, [chat("-100", "Harbour Clinic board")])
  await store.roster.saveMembers(TG, "-600", ["1", "77", "79"])
  await store.roster.saveMembers(TG, "-610", ["1", "77", "80"])
  await save(store, TG, "-700", [
    message("-700", "80", "Did the Harbour invoice arrive?"),
    message("-700", "80", "Harbour wants the plan by Friday"),
    message("-700", "80", "Call about Harbour later"),
    message("-700", "80", "Harbour, again", 1),
    message("-700", "80", "Harbourside is lovely"),
  ])
  await save(store, TG, "-900", [
    ...Array.from({ length: 6 }, () => message("-900", "78", "Shift starts at nine")),
    ...Array.from({ length: 2 }, () => message("-900", "79", "Ok")),
    message("-900", "80", "Dana Reed is joining tomorrow"),
  ])
  const dana = await personOf(store, "telegram", "77")
  const lee = await personOf(store, "telegram", "79")
  const ops = "chat:telegram/2/-900"
  for (const from of [dana, lee, ops])
    await store.knowledge.relate(null, { by: "owner", from, to: project.ref, kind: "member-of" })
  await store.knowledge.relate(null, { by: "owner", from: dana, to: other.ref, kind: "member-of" })
  return { store, project, other, dana, lee, ops, tick: () => clock++ }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const inputOf = async (f: Fixture, sources: AccountKey[] = [TG, MAX, MAIL]): Promise<ScorerInput> => ({
  store: f.store,
  project: { ref: f.project.ref, name: "Harbour Clinic", key: "HRB", aliases: ["Harbour"] },
  confirmed: { chats: [f.ops], people: [f.dana, f.lee].sort() },
  sources,
  since: SINCE,
  purposes: ["work", "sales", "support", "other"],
  owner: await personOf(f.store, "telegram", "1"),
})

const froms = (found: { from: string }[]) => found.map(({ from }) => from).sort()

describe("link scorers", () => {
  it("chat-title: a title naming the name, key or alias as whole words, with a configured purpose", async () => {
    const f = await fixture()
    const found = await chatTitle.candidates(await inputOf(f))
    expect(froms(found)).toEqual(["chat:max/1/-100", "chat:telegram/2/-500", "chat:telegram/2/-510"])
    expect(found.find((one) => one.from === "chat:telegram/2/-510")).toMatchObject({ weight: 0.7, purpose: "sales" })
    expect(found.find((one) => one.from === "chat:telegram/2/-500")?.purpose).toBeUndefined()
    expect(await chatTitle.candidates(await inputOf(f, [TG]))).toHaveLength(2)
  })

  it("alias-hits: whole-word hits in the window, grouped by chat, 3–9 weaker than 10 and more", async () => {
    const f = await fixture()
    const [found, ...rest] = await aliasHits.candidates(await inputOf(f))
    expect(rest).toEqual([])
    expect(found).toMatchObject({
      from: "chat:telegram/2/-700",
      weight: 0.35,
      why: "3 messages since 2026-10-05 name the project",
    })
    expect(found?.evidence).toHaveLength(3)
    await save(
      f.store,
      TG,
      "-700",
      Array.from({ length: 7 }, () => message("-700", "80", "Harbour notes")),
    )
    expect((await aliasHits.candidates(await inputOf(f)))[0]?.weight).toBe(0.55)
    expect(await aliasHits.candidates(await inputOf(f, [MAX]))).toEqual([])
  })

  it("member-chats: a group where two confirmed members are, not one", async () => {
    const f = await fixture()
    const found = await memberChats.candidates(await inputOf(f))
    expect(found).toEqual([
      expect.objectContaining({ from: "chat:telegram/2/-600", weight: 0.5, evidence: [f.dana, f.lee].sort() }),
    ])
  })

  it("member-dialog: a dialog with a member, divided by that member's projects", async () => {
    const f = await fixture()
    const found = await memberDialog.candidates(await inputOf(f))
    expect(found).toEqual([expect.objectContaining({ from: "chat:telegram/2/77", weight: 0.3 })])
    expect(froms(found)).not.toContain("chat:telegram/2/78")
  })

  it("chat-senders: by identity, any message in a chat of 10 or fewer; a namesake stays a different person", async () => {
    const f = await fixture()
    const namesake = await personOf(f.store, "telegram", "78")
    expect(namesake).not.toBe(f.dana)
    const found = await chatSenders.candidates(await inputOf(f))
    expect(froms(found)).toEqual([namesake, f.lee, await personOf(f.store, "telegram", "80")].sort())
    expect(found.find((one) => one.from === namesake)).toMatchObject({ weight: 0.5, identity: "contact:telegram/78" })
  })

  it("chat-senders: 5 messages in a group of more than 10", async () => {
    const f = await fixture()
    await f.store.roster.saveMembers(
      TG,
      "-900",
      Array.from({ length: 11 }, (_, index) => String(1000 + index)),
    )
    const found = await chatSenders.candidates(await inputOf(f))
    expect(froms(found)).toEqual([await personOf(f.store, "telegram", "78")])
  })

  it("chat-senders: a group of more than 30 counts less", async () => {
    const f = await fixture()
    await f.store.roster.saveMembers(
      TG,
      "-900",
      Array.from({ length: 31 }, (_, index) => String(1000 + index)),
    )
    expect((await chatSenders.candidates(await inputOf(f)))[0]?.weight).toBe(0.2)
  })

  it("mail-thread: a member's thread, strong when the subject names the project", async () => {
    const f = await fixture()
    await f.store.people.savePeople(MAIL, [{ id: "lee@vendor.test", name: "Lee Park" }])
    await f.store.people.linkIdentities(
      { provider: "telegram", id: "79" },
      { provider: "email", id: "lee@vendor.test" },
      { method: "manual", by: "owner" },
    )
    const accountId = (await f.store.accounts.storedAccount(MAIL)).id
    const email = (externalId: string, subject: string, from: string) => ({
      externalId,
      subject,
      from: { address: from, name: null },
      to: [{ address: "owner@synthetic.test", name: null }],
      cc: [],
      sentAt: Date.parse("2026-10-12T00:00:00.000Z"),
      receivedAt: Date.parse("2026-10-12T00:00:00.000Z"),
      references: [],
      bodyText: "Synthetic body",
      outgoing: false,
      read: true,
      mailboxes: [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }],
    })
    await f.store.mail.saveThread({
      accountId,
      externalId: "t-1",
      emails: [email("<a@vendor.test>", "HRB rollout", "lee@vendor.test")],
      now: f.tick(),
    })
    await f.store.mail.saveThread({
      accountId,
      externalId: "t-2",
      emails: [email("<b@vendor.test>", "Lunch", "lee@vendor.test")],
      now: f.tick(),
    })
    await f.store.mail.saveThread({
      accountId,
      externalId: "t-3",
      emails: [email("<c@else.test>", "HRB rollout", "someone@else.test")],
      now: f.tick(),
    })
    const found = await mailThread.candidates(await inputOf(f))
    expect(found.map(({ from, weight }) => [from, weight]).sort()).toEqual([
      ["chat:email/owner%40synthetic.test/t-1", 0.7],
      ["chat:email/owner%40synthetic.test/t-2", 0.3],
    ])
  })

  it("email-domain: people sharing a company domain, by their addresses, never a free mail domain", async () => {
    const f = await fixture()
    await mailContacts(f.store, ["ann@acme.test", "bo@acme.test", "cy@gmail.com", "di@gmail.com"])
    const found = await emailDomain.candidates({ ...(await inputOf(f)), project: null })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: "related-to", weight: 0.3 })
    expect(found[0]?.identity).toMatch(/^contact:email\/(ann|bo)%40acme\.test$/)
  })
})

describe("scanProjectLinks", () => {
  it("combines signals as 1 − Π(1 − w)", () => {
    expect(combinedScore([0.7])).toBe(0.7)
    expect(combinedScore([0.5, 0.5])).toBe(0.75)
    expect(combinedScore([])).toBe(0)
  })

  it("a dry run lists what it would propose and writes nothing", async () => {
    const f = await fixture()
    const registry = proposalRegistry(f.store)
    const before = await registry.list({ kinds: ["relationship"], status: "all", limit: 50, offset: 0 })
    const result = await scanProjectLinks(f.store, { project: "HRB", sources: [TG, MAX], since: SINCE, write: false })
    expect(result.proposals.length).toBeGreaterThan(0)
    expect(result.proposals.every((one) => one.state === "dry-run" && one.id === null)).toBe(true)
    expect(await registry.list({ kinds: ["relationship"], status: "all", limit: 50, offset: 0 })).toEqual(before)
  })

  it("writes scored proposals by the scan bot, with signals, and never message text", async () => {
    const f = await fixture()
    const result = await scanProjectLinks(f.store, { project: "HRB", sources: [TG, MAX], since: SINCE, write: true })
    const namesake = await personOf(f.store, "telegram", "78")
    expect(froms(result.proposals)).toEqual(
      [
        "chat:max/1/-100",
        "chat:telegram/2/-500",
        "chat:telegram/2/-510",
        "chat:telegram/2/-600",
        "chat:telegram/2/-610",
        "chat:telegram/2/78",
        namesake,
        await personOf(f.store, "telegram", "80"),
      ].sort(),
    )
    expect(result.proposals.every((one) => one.state === "new" && one.id !== null)).toBe(true)
    expect(result.skipped).toMatchObject({ confirmed: 1, rejected: 0, nameOnly: 0, overLimit: 0 })
    expect(result.skipped.belowThreshold).toBe(2)
    const sales = result.proposals.find((one) => one.from === "chat:telegram/2/-510")
    const row = await proposalRegistry(f.store).get(String(sales?.id))
    expect(row).toMatchObject({
      kind: "relationship",
      status: "proposed",
      proposedBy: { type: "bot", name: SCAN_BOT.bot, kind: "rule" },
      score: 0.7,
      signals: [{ scorer: "chat-title@1", weight: 0.7, why: "the chat title names the project (key)" }],
    })
    const stored = await f.store.proposedActions.get(String(sales?.id))
    expect(stored.payload).toMatchObject({ purpose: "sales" })
    for (const proposal of result.proposals) {
      const action = await f.store.proposedActions.get(String(proposal.id))
      const written = JSON.stringify(action)
      for (const text of new Set(texts)) expect(written).not.toContain(text)
    }
    expect(
      await proposalRegistry(f.store).decide([String(sales?.id)], {
        confirm: true,
        by: { bot: "claude-code", reason: "looks right" },
      }),
    ).toMatchObject({ decided: [], refused: [{ reason: "proposal.owner-only" }] })
  })

  it("skips a pair a link joins, and never proposes again a pair the owner rejected, even from a newer scorer", async () => {
    const f = await fixture()
    const first = await scanProjectLinks(f.store, { project: "HRB", sources: [TG], since: SINCE, write: true })
    const site = first.proposals.find((one) => one.from === "chat:telegram/2/-500")
    const sales = first.proposals.find((one) => one.from === "chat:telegram/2/-510")
    const registry = proposalRegistry(f.store)
    await registry.decide([String(site?.id)], { confirm: false, by: "owner", reason: "not this one" })
    await registry.decide([String(sales?.id)], { confirm: true, by: "owner" })
    const newer: LinkScorer = { ...chatTitle, version: 2 }
    const again = await scanProjectLinks(f.store, {
      project: "HRB",
      sources: [TG],
      since: SINCE,
      write: true,
      scorers: [newer],
    })
    expect(again.proposals).toEqual([])
    expect(again.skipped).toMatchObject({ rejected: 1, confirmed: 1 })
  })

  it("updates a pending proposal in place, under the same id", async () => {
    const f = await fixture()
    const first = await scanProjectLinks(f.store, { project: "HRB", sources: [TG], since: SINCE, write: true })
    const coffee = first.proposals.find((one) => one.from === "chat:telegram/2/-600")
    expect(coffee?.score).toBe(0.5)
    await save(
      f.store,
      TG,
      "-600",
      Array.from({ length: 3 }, () => message("-600", "77", "HRB standup")),
    )
    const again = await scanProjectLinks(f.store, { project: "HRB", sources: [TG], since: SINCE, write: true })
    const updated = again.proposals.find((one) => one.from === "chat:telegram/2/-600")
    expect(updated).toMatchObject({ id: coffee?.id, state: "updated", score: combinedScore([0.5, 0.35]) })
    expect(again.proposals.find((one) => one.from === "chat:telegram/2/-500")?.state).toBe("unchanged")
    const row = await f.store.proposedActions.get(String(coffee?.id))
    expect((row.payload as { signals: { scorer: string }[] }).signals.map((one) => one.scorer).sort()).toEqual([
      "alias-hits@1",
      "member-chats@1",
    ])
  })

  it("adds a scan's signals to an agent's pending proposal and keeps its author", async () => {
    const f = await fixture()
    const agent = await f.store.knowledge.proposeRelation(
      null,
      { from: "chat:telegram/2/-500", to: f.project.ref, kind: "member-of", reason: "client group" },
      { bot: "claude-code" },
    )
    const result = await scanProjectLinks(f.store, { project: "HRB", sources: [TG], since: SINCE, write: true })
    expect(result.proposals.find((one) => one.from === "chat:telegram/2/-500")).toMatchObject({
      id: agent.id,
      state: "updated",
    })
    const row = await proposalRegistry(f.store).get(agent.id)
    expect(row).toMatchObject({
      proposedBy: { name: "claude-code", kind: "agent" },
      reason: "client group",
      score: 0.7,
    })
  })

  it("caps new proposals per run and counts the rest", async () => {
    const f = await fixture()
    const result = await scanProjectLinks(f.store, {
      project: "HRB",
      sources: [TG, MAX],
      since: SINCE,
      write: true,
      limit: 2,
    })
    expect(result.proposals).toHaveLength(2)
    expect(result.proposals.every((one) => one.score === 0.7)).toBe(true)
    expect(result.skipped.overLimit).toBe(6)
  })

  it("refuses a person candidate found by name only, or by someone else's identity, and never proposes the owner", async () => {
    const f = await fixture()
    const namesake = await personOf(f.store, "telegram", "78")
    const owner = await personOf(f.store, "telegram", "1")
    const byName: LinkScorer = {
      id: "by-name",
      version: 1,
      candidates: async ({ project }) => [
        { from: namesake, to: String(project?.ref), kind: "member-of", weight: 0.9, why: "named", evidence: [] },
        {
          from: namesake,
          to: String(project?.ref),
          kind: "member-of",
          weight: 0.9,
          why: "named",
          evidence: [],
          identity: "contact:telegram/77",
        },
        {
          from: owner,
          to: String(project?.ref),
          kind: "member-of",
          weight: 0.9,
          why: "wrote",
          evidence: [],
          identity: "contact:telegram/1",
        },
      ],
    }
    const result = await scanProjectLinks(f.store, {
      project: "HRB",
      sources: [TG],
      since: SINCE,
      write: true,
      scorers: [byName],
    })
    expect(result.proposals).toEqual([])
    expect(result.skipped.nameOnly).toBe(1)
  })

  it("reads only the sources it is given and refuses none or an unknown one", async () => {
    const f = await fixture()
    const result = await scanProjectLinks(f.store, { project: "HRB", sources: [MAX], since: SINCE, write: false })
    expect(froms(result.proposals)).toEqual(["chat:max/1/-100"])
    await expect(
      scanProjectLinks(f.store, { project: "HRB", sources: [], since: SINCE, write: false }),
    ).rejects.toThrow("none is picked for you")
    await expect(
      scanProjectLinks(f.store, {
        project: "HRB",
        sources: [{ provider: "max", account: "404" }],
        since: SINCE,
        write: false,
      }),
    ).rejects.toThrow("no account max:404")
  })

  it("with no project, runs the email-domain rule as a weak person ↔ person proposal", async () => {
    const f = await fixture()
    await mailContacts(f.store, ["ann@acme.test", "bo@acme.test"])
    const result = await scanProjectLinks(f.store, { project: null, sources: [MAIL], since: SINCE, write: true })
    expect(result.proposals).toEqual([expect.objectContaining({ kind: "related-to", score: 0.3, state: "new" })])
    const [proposal] = result.proposals
    await proposalRegistry(f.store).decide([String(proposal?.id)], { confirm: false, by: "owner" })
    const again = await scanProjectLinks(f.store, { project: null, sources: [MAIL], since: SINCE, write: true })
    expect(again.skipped.rejected).toBe(1)
  })

  it("scans 2 000 chats in under 5 seconds", async () => {
    const f = await fixture()
    await f.store.chats.saveChats(
      TG,
      Array.from({ length: 2000 }, (_, index) => chat(String(-10_000 - index), `Synthetic chat ${index}`)),
    )
    await f.store.roster.saveMembers(TG, "-10001", ["77", "79"])
    const started = performance.now()
    const result = await scanProjectLinks(f.store, { project: "HRB", sources: [TG], since: SINCE, write: false })
    expect(performance.now() - started).toBeLessThan(5000)
    expect(froms(result.proposals)).toContain("chat:telegram/2/-10001")
  })
})
