import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { afterEach, describe, expect, it } from "vitest"
import { proposalRegistry } from "../services/proposals/registry.js"
import { IDENTITY_LINK_KIND } from "./identity-links.js"
import { type AccountKey, MENTION_QUERY, type MessageStore, openStore } from "./store.js"

const TG: AccountKey = { provider: "telegram", account: "1" }
const MAX: AccountKey = { provider: "max", account: "2" }
const owner = { method: "manual", by: "owner" }
const agent = { bot: "claude-code" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const open = async () => {
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "identity-links-")), "store.db"),
    decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
  })
  opened.push(store)
  return store
}

const ana = { provider: "telegram", id: "1" }
const anya = { provider: "max", id: "7" }

const twoPeople = async (store: MessageStore) => {
  await store.people.savePeople(TG, [{ id: "1", name: "Ana" }])
  await store.people.savePeople(MAX, [{ id: "7", name: "Anya" }])
}

const uidOf = async (store: MessageStore, ref: { provider: string; id: string }) =>
  (await store.people.personOf(ref))?.uid as string

describe("an identity_link proposal", () => {
  it("waits for the owner when an agent proposes it, and the owner's confirm makes one person", async () => {
    const store = await open()
    await twoPeople(store)

    const proposal = await store.people.proposeLink({ identity: ana, with: anya, signal: "agent", by: agent })

    expect(proposal).toMatchObject({ kind: IDENTITY_LINK_KIND, status: "proposed" })
    expect(await uidOf(store, ana)).not.toBe(await uidOf(store, anya))
    await store.people.decideLink(proposal.id, { confirm: true, by: "owner" })
    expect(await uidOf(store, ana)).toBe(await uidOf(store, anya))
  })

  it("is never confirmed by an agent, even with agent decisions on", async () => {
    const store = await open()
    await twoPeople(store)
    const proposal = await store.people.proposeLink({ identity: ana, with: anya, signal: "agent", by: agent })

    await expect(
      store.people.decideLink(proposal.id, { confirm: true, by: { bot: "codex", reason: "same face" } }),
    ).rejects.toMatchObject({ code: "permission_error", details: { reason: "proposal.owner-only" } })
    const { refused } = await proposalRegistry(store).decide([proposal.id], {
      confirm: true,
      by: { bot: "codex", reason: "same face" },
    })
    expect(refused).toMatchObject([{ id: proposal.id, reason: "proposal.owner-only" }])
    expect(await uidOf(store, ana)).not.toBe(await uidOf(store, anya))
  })

  it("is staged and approved only through the people review, never as a generic action", async () => {
    const store = await open()
    await twoPeople(store)
    await expect(
      store.proposedActions.propose({ kind: IDENTITY_LINK_KIND, by: agent, payload: {} }),
    ).rejects.toMatchObject({ details: { reason: "identity-link.dedicated-review" } })
    const proposal = await store.people.proposeLink({ identity: ana, with: anya, signal: "agent", by: agent })
    await expect(store.proposedActions.approve(proposal.id, "owner")).rejects.toMatchObject({
      details: { reason: "identity-link.dedicated-review" },
    })
  })

  it("is opened once per pair of people, whichever side proposes it", async () => {
    const store = await open()
    await twoPeople(store)

    const first = await store.people.proposeLink({ identity: ana, with: anya, signal: "agent", by: agent })
    const again = await store.people.proposeLink({ identity: anya, with: ana, signal: "agent", by: { bot: "codex" } })

    expect(again.id).toBe(first.id)
    expect(await store.proposedActions.list({ kinds: [IDENTITY_LINK_KIND] })).toHaveLength(1)
  })

  it("is not proposed for people the owner separated", async () => {
    const store = await open()
    await twoPeople(store)
    await store.people.linkIdentities(ana, anya, owner)
    await store.people.unlinkIdentity(anya, owner)

    await expect(
      store.people.proposeLink({ identity: ana, with: anya, signal: "agent", by: agent }),
    ).rejects.toMatchObject({ code: "conflict", details: { reason: "identity.separated" } })
    expect(await store.proposedActions.list({ kinds: [IDENTITY_LINK_KIND] })).toEqual([])
  })

  it("is not proposed again once the owner rejected the pair", async () => {
    const store = await open()
    await twoPeople(store)
    const proposal = await store.people.proposeLink({ identity: ana, with: anya, signal: "agent", by: agent })
    await store.people.decideLink(proposal.id, { confirm: false, by: "owner", reason: "two people" })

    await expect(
      store.people.proposeLink({ identity: anya, with: ana, signal: "agent", by: agent }),
    ).rejects.toMatchObject({ details: { reason: "identity.rejected" } })
  })

  it("refuses a confirm once the owner took an identity off either person since it was proposed", async () => {
    const store = await open()
    await twoPeople(store)
    await store.people.savePeople(MAX, [{ id: "8", name: "Anya work" }])
    await store.people.linkIdentities(anya, { provider: "max", id: "8" }, owner)
    const proposal = await store.people.proposeLink({ identity: ana, with: anya, signal: "agent", by: agent })
    await store.people.unlinkIdentity({ provider: "max", id: "8" }, owner)

    await expect(store.people.decideLink(proposal.id, { confirm: true, by: "owner" })).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "identity.stale" },
    })
    expect(await uidOf(store, ana)).not.toBe(await uidOf(store, anya))
  })

  it("is listed and decided through the proposal registry", async () => {
    const store = await open()
    await twoPeople(store)
    const proposal = await store.people.proposeLink({
      identity: ana,
      with: anya,
      signal: "agent",
      by: agent,
      reason: "same phone in a message",
    })
    const registry = proposalRegistry(store)

    const { items } = await registry.list({ kinds: [IDENTITY_LINK_KIND], limit: 10, offset: 0 })
    expect(items).toMatchObject([
      {
        id: proposal.id,
        subject: `person:${await uidOf(store, ana)}`,
        object: `person:${await uidOf(store, anya)}`,
        ownerOnly: true,
        reason: "same phone in a message",
      },
    ])
    const { decided } = await registry.decide([proposal.id], { confirm: true, by: "owner" })
    expect(decided).toMatchObject([{ status: "confirmed", made: [`person:${await uidOf(store, anya)}`] }])
  })
})

describe("an agent's link through a mention", () => {
  const phoneMention = async (store: MessageStore) => {
    await store.people.savePeople(TG, [{ id: "1", name: "Ana" }])
    await store.messages.saveMessages(
      TG,
      "-1",
      [
        {
          id: "1",
          chatId: "-1",
          senderId: "1",
          senderName: "Ana",
          timestamp: "2026-10-01T10:00:00.000Z",
          editedAt: null,
          text: "+7 900 000-00-01",
          outgoing: false,
          attachments: [],
          replyTo: null,
          forwardedFrom: null,
          reactions: null,
        },
      ],
      { via: "history" },
    )
    const [phone] = (
      await store.mentions.mentions(TG, parseLucene("kind:phone", { ...MENTION_QUERY, defaultField: "value" }), {
        offset: 0,
      })
    ).items
    return phone?.id ?? 0
  }

  it("becomes a proposal and moves nothing", async () => {
    const store = await open()
    const phone = await phoneMention(store)
    const person = await uidOf(store, ana)

    const decided = await store.mentions.confirmMention(TG, phone, `person:${person}`, { by: "claude-code" })

    expect(decided).toMatchObject({ status: "proposed", proposal: expect.any(String) })
    expect(await uidOf(store, { provider: "phone", id: "+79000000001" })).not.toBe(person)
    await store.people.decideLink(decided.proposal as string, { confirm: true, by: "owner" })
    expect(await uidOf(store, { provider: "phone", id: "+79000000001" })).toBe(person)
    expect((await store.mentions.mention(TG, phone))?.status).toBe("linked")
  })

  it("goes back to undecided when the owner rejects the link it proposed", async () => {
    const store = await open()
    const phone = await phoneMention(store)
    const person = await uidOf(store, ana)
    const decided = await store.mentions.confirmMention(TG, phone, `person:${person}`, { by: "claude-code" })

    await store.people.decideLink(decided.proposal as string, { confirm: false, by: "owner" })

    expect((await store.mentions.mention(TG, phone))?.status).toBe("found")
  })

  it("never replaces the owner's link of the identity", async () => {
    const store = await open()
    const phone = await phoneMention(store)
    await store.people.savePeople(TG, [{ id: "2", name: "Bea" }])
    const person = await uidOf(store, ana)
    await store.mentions.confirmMention(TG, phone, `person:${person}`, { by: "owner" })

    const bea = await uidOf(store, { provider: "telegram", id: "2" })
    await store.mentions.confirmMention(TG, phone, `person:${bea}`, { by: "claude-code" })

    expect(await uidOf(store, { provider: "phone", id: "+79000000001" })).toBe(person)
  })
})

describe("the link proposals read", () => {
  it("names the people as they are now, filters by a person, and pages with hasMore", async () => {
    const store = await open()
    await twoPeople(store)
    await store.people.savePeople(MAX, [
      { id: "8", name: "Cas" },
      { id: "9", name: "Dee" },
    ])
    const first = await store.people.proposeLink({ identity: ana, with: anya, signal: "agent", by: agent })
    await store.people.proposeLink({ identity: ana, with: { provider: "max", id: "8" }, signal: "agent", by: agent })
    await store.people.linkIdentities({ provider: "max", id: "9" }, anya, owner)
    const now = await uidOf(store, anya)

    const page = await store.people.linkProposals({ person: await uidOf(store, ana), limit: 1, offset: 0 })
    const withAnya = await store.people.linkProposals({ person: now, limit: 10, offset: 0 })

    expect(page).toMatchObject({ hasMore: true, items: [{ status: "proposed" }] })
    expect(withAnya.items).toMatchObject([
      { id: first.id, persons: [`person:${await uidOf(store, ana)}`, `person:${now}`] },
    ])
    expect(withAnya.hasMore).toBe(false)
  })

  it("lists by score, highest first, with the proposals that have none last and newest first", async () => {
    const store = await open()
    await twoPeople(store)
    await store.people.savePeople(MAX, [
      { id: "8", name: "Cas" },
      { id: "9", name: "Dee" },
      { id: "10", name: "Eve" },
    ])
    const ids: string[] = []
    for (const [id, score] of [
      ["8", undefined],
      ["9", 0.3],
      ["10", undefined],
    ] as const)
      ids.push(
        (
          await store.people.proposeLink({
            identity: ana,
            with: { provider: "max", id },
            signal: "agent",
            by: agent,
            ...(score === undefined ? {} : { score }),
          })
        ).id,
      )
    ids.push((await store.people.proposeLink({ identity: ana, with: anya, signal: "agent", by: agent, score: 0.7 })).id)

    const everyone = await store.people.linkProposals({ order: "score", limit: 2, offset: 0 })
    const rest = await store.people.linkProposals({ order: "score", limit: 2, offset: 2 })
    const anas = await store.people.linkProposals({
      person: await uidOf(store, ana),
      order: "score",
      limit: 10,
      offset: 0,
    })

    expect([...everyone.items, ...rest.items].map(({ id }) => id)).toEqual([ids[3], ids[1], ids[2], ids[0]])
    expect(anas.items.map(({ id }) => id)).toEqual([ids[3], ids[1], ids[2], ids[0]])
  })

  it("pages everyone's proposals newest first, by status", async () => {
    const store = await open()
    await twoPeople(store)
    await store.people.savePeople(MAX, [
      { id: "8", name: "Cas" },
      { id: "9", name: "Dee" },
    ])
    const ids = []
    for (const other of [anya, { provider: "max", id: "8" }, { provider: "max", id: "9" }])
      ids.push((await store.people.proposeLink({ identity: ana, with: other, signal: "agent", by: agent })).id)
    await store.people.decideLink(ids[1] as string, { confirm: false, by: "owner" })

    const pages = await Promise.all(
      [0, 1, 2].map((offset) => store.people.linkProposals({ status: "all", limit: 1, offset })),
    )
    const proposed = await store.people.linkProposals({ limit: 10, offset: 0 })

    expect(pages.map(({ items, hasMore }) => [items.map(({ id }) => id), hasMore])).toEqual([
      [[ids[2]], true],
      [[ids[1]], true],
      [[ids[0]], false],
    ])
    expect(proposed.items.map(({ id }) => id)).toEqual([ids[2], ids[0]])
    expect((await store.people.linkProposals({ status: "rejected", limit: 10, offset: 0 })).items).toMatchObject([
      { id: ids[1], status: "rejected" },
    ])
  })
})
