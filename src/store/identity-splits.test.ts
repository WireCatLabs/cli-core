import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { proposalRegistry } from "../services/proposals/registry.js"
import { IDENTITY_SPLIT_KIND } from "./identity-splits.js"
import { openCache } from "./open.js"
import { forgetErasedSplits } from "./sqlite/identity-split-proposals.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const OWN: AccountKey = { provider: "telegram", account: "1", scope: "personal" }
const MAX: AccountKey = { provider: "max", account: "2", scope: "personal" }
const agent = { bot: "claude-code" }
const tg = (id: string) => ({ provider: "telegram", id })
const max = (id: string) => ({ provider: "max", id })
const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

let path = ""
const open = async () => {
  path = join(mkdtempSync(join(tmpdir(), "identity-splits-")), "store.db")
  const store = await openStore({ path })
  handles.push(store)
  return store
}

/** The owner, with a spouse's MAX account and a friend's Telegram joined to them by an older build's rule. */
const absorbed = async () => {
  const store = await open()
  await store.people.savePeople(OWN, [
    { id: "1", name: "Aleksei Ivanov" },
    { id: "7", name: "Pavel Orlov" },
  ])
  await store.accounts.saveAccount(OWN, { name: null })
  await store.people.savePeople(MAX, [{ id: "2", name: "Svetlana 2" }])
  await store.people.linkIdentities(tg("1"), max("2"), { method: "account", by: "rules" })
  await store.people.linkIdentities(tg("1"), tg("7"), { method: "same-email", by: "rules" })
  return store
}

const ownerRefs = async (store: MessageStore) =>
  (await store.people.owner())?.identities.map(({ provider, id }) => `${provider}:${id}`).sort()

describe("a split an agent proposes (IDEA-271)", () => {
  it("waits for the owner with its reason, and only the owner's confirm takes the identity off", async () => {
    const store = await absorbed()
    const proposal = await store.people.proposeSplit({
      identities: [max("2")],
      by: agent,
      reason: "his wife's account",
    })

    expect(await ownerRefs(store)).toEqual(["max:2", "telegram:1", "telegram:7"])
    const listed = await store.people.splitProposals({ limit: 10, offset: 0 })
    expect(listed.items).toMatchObject([
      { id: proposal.id, split: "unlink", identities: ["max:2"], reason: "his wife's account", status: "proposed" },
    ])
    await expect(
      store.people.decideSplit(proposal.id, { confirm: true, by: { bot: "codex", reason: "agreed" } }),
    ).rejects.toMatchObject({ code: "permission_error" })

    const decided = await store.people.decideSplit(proposal.id, { confirm: true, by: "owner" })
    expect(await ownerRefs(store)).toEqual(["telegram:1", "telegram:7"])
    const moved = await store.people.personOf(max("2"))
    expect(decided).toMatchObject({ status: "approved", result: { person: moved?.uid } })
    expect(moved?.identities[0]).toMatchObject({ method: "unlink", linkedBy: "owner" })
  })

  it("undoes a merge by its id", async () => {
    const store = await absorbed()
    const owner = (await store.people.owner())?.uid as string
    const merge = (await store.people.merges(owner)).find(({ identities }) => identities[0]?.id === "2")?.id as string

    const proposal = await store.people.proposeSplit({ merge, by: agent, reason: "not the owner" })
    expect(proposal.payload).toMatchObject({ split: "unmerge", merge, identities: ["max:2"] })
    await store.people.decideSplit(proposal.id, { confirm: true, by: "owner" })

    expect(await ownerRefs(store)).toEqual(["telegram:1", "telegram:7"])
  })

  it("is refused once the person changed since it was proposed, and proposing again renews it", async () => {
    const store = await absorbed()
    const proposal = await store.people.proposeSplit({ identities: [max("2")], by: agent, reason: "his wife's" })
    await store.people.unlinkIdentity(tg("7"), { method: "unlink", by: "owner" })

    await expect(store.people.decideSplit(proposal.id, { confirm: true, by: "owner" })).rejects.toMatchObject({
      details: { reason: "identity.stale" },
    })

    const renewed = await store.people.proposeSplit({ identities: [max("2")], by: agent, reason: "his wife's" })
    expect(renewed.id).toBe(proposal.id)
    await store.people.decideSplit(proposal.id, { confirm: true, by: "owner" })
    expect(await ownerRefs(store)).toEqual(["telegram:1"])
  })

  it("gives back the open one for the same identities, and after the owner's no refuses it", async () => {
    const store = await absorbed()
    const first = await store.people.proposeSplit({ identities: [max("2")], by: agent, reason: "his wife's" })
    const again = await store.people.proposeSplit({ identities: [max("2")], by: { bot: "codex" }, reason: "hers" })
    expect(again.id).toBe(first.id)

    await store.people.decideSplit(first.id, { confirm: false, by: "owner", reason: "it is mine" })
    await expect(
      store.people.proposeSplit({ identities: [max("2"), tg("7")], by: agent, reason: "his wife's" }),
    ).rejects.toMatchObject({ details: { reason: "identity.kept-together" } })
  })

  it("adds the new evidence when proposed again", async () => {
    const store = await absorbed()
    await store.people.proposeSplit({ identities: [max("2")], by: agent, reason: "hers", evidence: ["a"] })
    const again = await store.people.proposeSplit({
      identities: [max("2")],
      by: agent,
      reason: "hers",
      evidence: ["b"],
    })

    expect(again.payload).toMatchObject({ evidence: ["a", "b"] })
  })

  it("refuses identities of two people, and a split that leaves the person empty", async () => {
    const store = await absorbed()
    await store.people.savePeople(OWN, [{ id: "9", name: "Ivan Petrov" }])

    await expect(
      store.people.proposeSplit({ identities: [max("2"), tg("9")], by: agent, reason: "x" }),
    ).rejects.toMatchObject({ details: { reason: "identity.several-persons" } })
    await expect(store.people.proposeSplit({ identities: [tg("9")], by: agent, reason: "x" })).rejects.toMatchObject({
      details: { reason: "identity.nothing-left" },
    })
  })

  it("never runs as a plain action, and one an older build approved as one is not carried out", async () => {
    const store = await absorbed()
    const proposal = await store.people.proposeSplit({ identities: [max("2")], by: agent, reason: "his wife's" })
    await expect(store.proposedActions.approve(proposal.id, "owner")).rejects.toMatchObject({
      details: { reason: "identity-split.dedicated-review" },
    })

    const database = await openCache(path)
    handles.push(database)
    database.prepare("UPDATE proposed_actions SET status = 'approved' WHERE id = ?").run(Number(proposal.id))
    await expect(store.people.decideSplit(proposal.id, { confirm: true, by: "owner" })).rejects.toMatchObject({
      details: { reason: "proposal.wrong-state" },
    })
    expect(await ownerRefs(store)).toEqual(["max:2", "telegram:1", "telegram:7"])
    const other = await store.people.proposeSplit({ identities: [tg("7")], by: agent, reason: "a friend" })
    const list = async (status: "dropped" | "confirmed" | "proposed") =>
      (await store.people.splitProposals({ status, limit: 10, offset: 0 })).items.map(({ id }) => id)
    expect(await list("dropped")).toEqual([proposal.id])
    expect(await list("confirmed")).toEqual([])
    expect(await list("proposed")).toEqual([other.id])
    const [row] = (
      await proposalRegistry(store).list({ kinds: [IDENTITY_SPLIT_KIND], status: "all", limit: 10, offset: 0 })
    ).items.filter(({ id }) => id === proposal.id)
    expect(row).toMatchObject({ status: "rejected", summary: expect.stringMatching(/^not carried out/) })
  })

  it("is decided through the shared review, the owner's alone", async () => {
    const store = await absorbed()
    const proposal = await store.people.proposeSplit({ identities: [max("2")], by: agent, reason: "his wife's" })
    const review = proposalRegistry(store)

    const listed = await review.list({ kinds: [IDENTITY_SPLIT_KIND], limit: 10, offset: 0 })
    expect(listed.items).toMatchObject([{ id: proposal.id, kind: IDENTITY_SPLIT_KIND, ownerOnly: true }])
    const refused = await review.decide([proposal.id], { confirm: true, by: { bot: "codex", reason: "agreed" } })
    expect(refused.refused).toMatchObject([{ id: proposal.id, reason: "proposal.owner-only" }])

    const done = await review.decide([proposal.id], { confirm: true, by: "owner" })
    expect(done.decided).toMatchObject([{ id: proposal.id, status: "confirmed" }])
    expect(await ownerRefs(store)).toEqual(["telegram:1", "telegram:7"])
  })

  it("is forgotten with an erased identity, since it names its address", async () => {
    const store = await absorbed()
    await store.people.proposeSplit({ identities: [max("2")], by: agent, reason: "his wife's" })
    const database = await openCache(path)
    handles.push(database)
    database.exec("PRAGMA foreign_keys = OFF")
    const pk = database.prepare("SELECT id FROM identities WHERE provider = 'max' AND external_id = '2'").get()?.id
    for (const table of ["identity_link_events", "identity_links"])
      database.prepare(`DELETE FROM ${table} WHERE identity_id = ?`).run(Number(pk))
    database.prepare("DELETE FROM identities WHERE id = ?").run(Number(pk))

    forgetErasedSplits(database)
    expect((await store.people.splitProposals({ status: "all", limit: 10, offset: 0 })).items).toEqual([])
  })
})

describe("taking identities off the person named (BUG-709)", () => {
  const withColleague = async () => {
    const store = await absorbed()
    await store.people.savePeople(OWN, [
      { id: "8", name: "Ярослав Орлов" },
      { id: "9", name: "Yaroslav (work)" },
    ])
    await store.people.linkIdentities(tg("8"), tg("9"), { method: "manual", by: "owner" })
    const owner = (await store.people.owner())?.uid as string
    const colleague = (await store.people.personOf(tg("8")))?.uid as string
    return { store, owner, colleague }
  }

  it("refuses an identity that sits on someone else, names who holds it, and moves nothing", async () => {
    const { store, owner, colleague } = await withColleague()
    const refused = {
      code: "validation_error",
      details: { reason: "identity.held-elsewhere", param: "from", reference: `person:${colleague}` },
    }

    await expect(
      store.people.unlinkIdentity(tg("9"), { method: "unlink", by: "owner", from: owner }),
    ).rejects.toMatchObject(refused)
    await expect(store.people.split(owner, [tg("9")], "owner")).rejects.toMatchObject(refused)
    await expect(
      store.people.proposeSplit({ identities: [tg("9")], from: owner, by: agent, reason: "not mine" }),
    ).rejects.toMatchObject(refused)
    await expect(store.people.unlinkIdentity(tg("9"), { method: "unlink", by: "owner", from: owner })).rejects.toThrow(
      `telegram:9 sits on Ярослав Орлов (person:${colleague})`,
    )

    expect((await store.people.personOf(tg("9")))?.uid).toBe(colleague)
    expect(await ownerRefs(store)).toEqual(["max:2", "telegram:1", "telegram:7"])
  })

  it("takes it off when the person named holds it", async () => {
    const { store, colleague } = await withColleague()
    const alone = await store.people.unlinkIdentity(tg("9"), { method: "unlink", by: "owner", from: colleague })
    expect(alone.uid).not.toBe(colleague)
    expect((await store.people.personOf(tg("8")))?.identities.map(({ id }) => id)).toEqual(["8"])
  })
})
