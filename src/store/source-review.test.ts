import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { contextEvidenceFingerprint } from "../context/evidence.js"
import type { Message } from "../domain/models.js"
import { proposalRegistry } from "../services/proposals/registry.js"
import type { DecisionPolicy } from "./decisions.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import type { SourceReviewPayload } from "./source-review.js"
import { orphanPointers } from "./sqlite/entity-types.js"
import type { EvidenceInput } from "./sqlite/evidence-signature.js"
import { storedEvidenceMetadata } from "./sqlite/evidence-signature.js"
import { SOURCE_WALK } from "./sqlite/source-review.js"
import { referenceOfThing } from "./sqlite/things.js"
import { type MessageStore, openStore } from "./store.js"

const opened: { store: MessageStore; db: CacheDatabase }[] = []
afterEach(async () => {
  for (const { store, db } of opened.splice(0)) {
    db.close()
    await store.close()
  }
})

const agent = { bot: "digest-writer", model: "synthetic-model-1" }
const CHAT = { provider: "example-chat", account: "example" }
const MESSAGE: Message = {
  id: "m1",
  chatId: "c",
  senderId: "7",
  senderName: "Kai Sample",
  timestamp: "2026-11-01T10:00:00.000Z",
  editedAt: null,
  text: "",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}
const deciding: DecisionPolicy = { agentDecisions: true, ruleProposalsOwnerOnly: true }

const fixture = async (decisions?: DecisionPolicy) => {
  const path = join(mkdtempSync(join(tmpdir(), "source-review-")), "store.db")
  const clock = { at: 1_000 }
  const store = await openStore({ path, now: () => clock.at, ...(decisions === undefined ? {} : { decisions }) })
  const db = await openCache(path)
  opened.push({ store, db })
  const later = () => {
    clock.at += 1_000
  }
  const remember = (evidence: EvidenceInput[], body = "Delivery is on the 28th") =>
    store.memories.add({ kind: "preference", body, scope: "work", evidence, author: "owner", status: "confirmed" })
  const reviews = () =>
    db
      .prepare("SELECT id, status, target_type, target_id, payload, result FROM proposed_actions WHERE kind = ?")
      .all("memory_source_review")
      .map((row) => ({
        id: Number(row.id),
        status: String(row.status),
        target_type: row.target_type,
        target_id: row.target_id,
        payload: JSON.parse(String(row.payload)) as SourceReviewPayload,
        result: row.result == null ? null : JSON.parse(String(row.result)),
      }))
  const signatures = (from: { id: string }, type = "memory") =>
    db
      .prepare("SELECT metadata FROM links WHERE from_type = ? AND from_id = ? AND kind = 'evidence' ORDER BY id")
      .all(type, Number(from.id))
      .map((row) => storedEvidenceMetadata(row.metadata))
  return { path, store, db, clock, later, remember, reviews, signatures }
}

const quoted = async (text = "We agreed delivery on the 28th. Call at 10.") => {
  const f = await fixture()
  const note = await f.store.notes.addNote({ text })
  return { ...f, note }
}

describe("checking the sources of memories and facts", () => {
  it("raises nothing when the source changed but still says the quoted words, and signs it anew", async () => {
    const f = await quoted()
    const memory = await f.remember([{ ref: f.note.ref, quote: "delivery on the 28th" }])
    f.later()
    await f.store.notes.editNote(f.note.ref, "We agreed delivery on the 28th. Call at 11.", 1)
    expect(await f.store.knowledge.checkSources()).toEqual({
      checked: 1,
      baselined: 0,
      raised: 0,
      refreshed: 1,
      closed: 0,
      changedRefs: [f.note.ref],
    })
    expect(f.reviews()).toEqual([])
    expect(f.signatures(memory)).toMatchObject([
      { v: 1, rev: 2, cited_rev: 1, quote: "delivery on the 28th", checked_at: 2_000 },
    ])
    expect(await f.store.memories.get(memory.ref)).toMatchObject({ status: "confirmed", sourceReview: null })
  })

  it("raises a changed review when the quote is gone, naming the cited version, and leaves the status alone", async () => {
    const f = await quoted()
    const memory = await f.remember([{ ref: f.note.ref, quote: "delivery on the 28th" }])
    f.later()
    await f.store.notes.editNote(f.note.ref, "We agreed delivery on the 30th.", 1)
    expect(await f.store.knowledge.checkSources()).toMatchObject({ raised: 1, refreshed: 0 })
    const [review] = f.reviews()
    expect(review).toMatchObject({
      status: "proposed",
      target_type: "memory",
      target_id: Number(memory.id),
      payload: {
        target: memory.ref,
        cause: "changed",
        raisedAt: new Date(2_000).toISOString(),
        sources: [{ ref: f.note.ref, cause: "changed", citedRev: 1 }],
        challenges: [],
      },
    })
    expect(JSON.stringify(review?.payload)).not.toContain("30th")
    expect(await f.store.memories.get(memory.ref)).toMatchObject({
      status: "confirmed",
      sourceReview: { id: String(review?.id), cause: "changed" },
    })
  })

  it("raises a changed review when a source without a quote changed", async () => {
    const f = await quoted()
    const fact = await f.store.facts.add({
      type: "decision",
      statement: "Delivery on the 28th",
      by: "owner",
      evidence: [f.note.ref],
    })
    f.later()
    await f.store.notes.editNote(f.note.ref, "We agreed delivery on the 28th, maybe.", 1)
    await f.store.knowledge.checkSources()
    expect(await f.store.facts.get(fact.ref)).toMatchObject({ status: "accepted", sourceReview: { cause: "changed" } })
  })

  it("raises a deleted review naming a cited source that is gone from the store", async () => {
    const f = await quoted()
    const other = await f.store.notes.addNote({ text: "Second note" })
    const memory = await f.remember([f.note.ref, other.ref])
    f.later()
    await f.store.notes.removeNote(other.ref)
    await f.store.knowledge.checkSources()
    const [review] = f.reviews()
    expect(review?.payload).toMatchObject({
      cause: "deleted",
      sources: [{ ref: null, kind: "note", cause: "deleted" }],
    })
    expect((await f.store.memories.get(memory.ref)).status).toBe("confirmed")
  })

  it("follows a message through the store's own writer: an edit raises changed, a deletion deleted", async () => {
    const f = await fixture()
    await f.store.accounts.saveAccount(CHAT, { name: "Example chat" })
    const save = (id: string, text: string) =>
      f.store.messages.saveMessages(CHAT, "c", [{ ...MESSAGE, id, text }], { via: "update" })
    await save("m1", "We agreed delivery on the 28th. Call at 10.")
    await save("m2", "Delivery on the 28th works for us")
    const refs = ["m1", "m2"].map((external) => {
      const row = f.db.prepare("SELECT id FROM messages WHERE external_id = ?").get(external)
      return referenceOfThing(f.db, { type: "message", id: Number(row?.id) }) as string
    })
    const kept = await f.remember([{ ref: refs[0] as string, quote: "delivery on the 28th" }], "Kept")
    const edited = await f.remember([refs[0] as string], "Edited")
    const deleted = await f.remember([refs[1] as string], "Deleted")
    f.later()
    await save("m1", "We agreed delivery on the 28th. Call at 11.")
    await f.store.messages.markDeleted(CHAT, ["m2"], { chatId: "c" })
    expect((await f.store.memories.get(deleted.ref)).sourceReview).toMatchObject({ cause: "deleted" })
    expect(await f.store.knowledge.checkSources()).toMatchObject({ checked: 3, raised: 1, refreshed: 1 })
    expect((await f.store.memories.get(kept.ref)).sourceReview).toBeNull()
    expect((await f.store.memories.get(edited.ref)).sourceReview).toMatchObject({ cause: "changed" })
    expect((await f.store.memories.get(deleted.ref)).sourceReview).toMatchObject({ cause: "deleted" })
    const review = f.reviews().find((one) => one.target_id === Number(edited.id))
    expect(review?.payload.sources).toEqual([{ link: expect.any(Number), ref: refs[0], cause: "changed", citedRev: 0 }])
  })

  it("raises an outdated review naming what replaced a cited fact", async () => {
    const f = await quoted()
    const decided = await f.store.facts.add({ type: "decision", statement: "Delivery on the 28th", by: "owner" })
    const memory = await f.remember([decided.ref])
    f.later()
    const replacement = await f.store.facts.add({
      type: "decision",
      statement: "Delivery on the 30th",
      by: "owner",
      supersedes: decided.ref,
    })
    await f.store.knowledge.checkSources()
    expect(f.reviews()[0]?.payload).toMatchObject({
      target: memory.ref,
      cause: "outdated",
      sources: [{ ref: decided.ref, cause: "outdated", replacement: replacement.ref }],
    })
  })

  it("raises nothing when a cited memory was only confirmed", async () => {
    const f = await quoted()
    const cited = await f.store.memories.add({
      kind: "preference",
      body: "Delivery is on the 28th",
      scope: "work",
      evidence: [f.note.ref],
      author: agent,
    })
    await f.remember([cited.ref], "Kai Sample plans for the 28th")
    f.later()
    await f.store.memories.confirm(cited.ref, "owner")
    expect(await f.store.knowledge.checkSources()).toMatchObject({ raised: 0, refreshed: 1 })
  })

  it("records an agent's challenge as a contradicted review and nothing else", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    const counter = await f.store.notes.addNote({ text: "Delivery moved to the 30th" })
    const proposal = await f.store.knowledge.challenge(memory.ref, {
      evidence: [counter.ref],
      reason: "a later note moves the delivery",
      by: agent,
    })
    expect(proposal).toMatchObject({ kind: "memory_source_review", status: "proposed", target: memory.ref })
    expect(proposal.payload).toMatchObject({
      cause: "contradicted",
      sources: [],
      challenges: [{ evidence: [counter.ref], reason: "a later note moves the delivery", by: agent.bot }],
    })
    expect((await f.store.memories.get(memory.ref)).status).toBe("confirmed")
    const again = await f.store.knowledge.challenge(memory.ref, {
      evidence: [counter.ref],
      reason: "still",
      by: "owner",
      suggestion: "Delivery is on the 30th",
    })
    expect(again.id).toBe(proposal.id)
    expect(again.payload).toMatchObject({
      challenges: [{ by: agent.bot }, { by: "owner" }],
      suggestions: [{ author: "owner", body: "Delivery is on the 30th" }],
    })
  })

  it("refuses a challenge without a reason or evidence, or of a memory that no longer holds", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    await expect(
      f.store.knowledge.challenge(memory.ref, { evidence: [f.note.ref], reason: " ", by: agent }),
    ).rejects.toMatchObject({ details: { reason: "source-review.reason-required" } })
    await expect(
      f.store.knowledge.challenge(memory.ref, { evidence: [], reason: "wrong", by: agent }),
    ).rejects.toMatchObject({ details: { reason: "source-review.evidence-required" } })
    await f.store.memories.markStale(memory.ref, "owner")
    await expect(
      f.store.knowledge.challenge(memory.ref, { evidence: [f.note.ref], reason: "wrong", by: agent }),
    ).rejects.toMatchObject({ details: { reason: "source-review.not-holding" } })
    expect(f.reviews()).toEqual([])
  })

  it("closes the review of a superseded memory as executed, and its correction starts signed", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    f.later()
    await f.store.notes.editNote(f.note.ref, "We agreed delivery on the 30th.", 1)
    await f.store.knowledge.checkSources()
    const fixed = await f.store.memories.add({
      kind: "preference",
      body: "Delivery is on the 30th",
      scope: "work",
      evidence: [{ ref: f.note.ref, quote: "delivery on the 30th" }],
      author: "owner",
      status: "confirmed",
      supersedes: memory.ref,
    })
    expect(f.reviews()[0]).toMatchObject({ status: "executed", result: { closed: "superseded" } })
    expect(await f.store.memories.get(memory.ref)).toMatchObject({ status: "superseded", sourceReview: null })
    expect(f.signatures(fixed)).toMatchObject([{ v: 1, rev: 2, quote: "delivery on the 30th", checked_at: 2_000 }])
    expect(await f.store.knowledge.checkSources()).toMatchObject({ raised: 0 })
  })

  it("closes a fact's review when the fact is reversed or superseded", async () => {
    const f = await quoted()
    const first = await f.store.facts.add({ type: "decision", statement: "28th", by: "owner", evidence: [f.note.ref] })
    const second = await f.store.facts.add({
      type: "decision",
      statement: "28th too",
      by: "owner",
      evidence: [f.note.ref],
    })
    for (const fact of [first, second])
      await f.store.knowledge.challenge(fact.ref, { evidence: [f.note.ref], reason: "wrong day", by: agent })
    await f.store.facts.reverse(first.ref, "owner")
    await f.store.facts.add({ type: "decision", statement: "30th", by: "owner", supersedes: second.ref })
    expect(f.reviews().map((review) => [review.status, review.result])).toEqual([
      ["executed", { closed: "reversed" }],
      ["executed", { closed: "superseded" }],
    ])
  })

  it("signs a link written before signatures in silence when its source has not changed since", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    f.db.prepare("UPDATE links SET metadata = NULL WHERE from_type = 'memory'").run()
    f.later()
    expect(await f.store.knowledge.checkSources()).toMatchObject({ checked: 1, baselined: 1, raised: 0 })
    expect(f.signatures(memory)).toMatchObject([{ v: 1, rev: 1, checked_at: 2_000 }])
    expect(f.reviews()).toEqual([])
  })

  it("raises a review for a link written before signatures whose source was edited after it was cited", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    f.db.prepare("UPDATE links SET metadata = NULL WHERE from_type = 'memory'").run()
    f.later()
    await f.store.notes.editNote(f.note.ref, "We agreed delivery on the 30th.", 1)
    expect(await f.store.knowledge.checkSources()).toMatchObject({ baselined: 0, raised: 1 })
    expect(f.reviews()[0]?.payload).toMatchObject({ target: memory.ref, cause: "changed" })
  })

  it("gives one review for two runs over the same change", async () => {
    const f = await quoted()
    await f.remember([f.note.ref])
    f.later()
    await f.store.notes.editNote(f.note.ref, "We agreed delivery on the 30th.", 1)
    await f.store.knowledge.checkSources()
    f.later()
    expect(await f.store.knowledge.checkSources()).toMatchObject({ checked: 1, raised: 0 })
    expect(f.reviews()).toHaveLength(1)
  })

  it("updates an open changed review in place when the source is then deleted, and moves it forward", async () => {
    const f = await quoted()
    await f.remember([f.note.ref])
    f.later()
    await f.store.notes.editNote(f.note.ref, "We agreed delivery on the 30th.", 1)
    await f.store.knowledge.checkSources()
    f.later()
    await f.store.notes.removeNote(f.note.ref)
    const reviews = f.reviews()
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.payload).toMatchObject({
      cause: "deleted",
      raisedAt: new Date(3_000).toISOString(),
      sources: [{ ref: null, kind: "note", cause: "deleted", citedRev: 1 }],
    })
    f.later()
    expect(await f.store.knowledge.checkSources()).toMatchObject({ checked: 0, raised: 0 })
  })

  it("keeps raisedAt when a later change is no graver", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    const counter = await f.store.notes.addNote({ text: "Delivery moved" })
    await f.store.knowledge.challenge(memory.ref, { evidence: [counter.ref], reason: "moved", by: agent })
    f.later()
    await f.store.notes.editNote(f.note.ref, "We agreed delivery on the 30th.", 1)
    await f.store.knowledge.checkSources()
    expect(f.reviews()[0]?.payload).toMatchObject({ cause: "contradicted", raisedAt: new Date(1_000).toISOString() })
  })

  it("checks at most limit links, walking on from where the last run stopped and starting over at the end", async () => {
    const f = await quoted()
    const notes = await Promise.all(["a", "b", "c"].map((text) => f.store.notes.addNote({ text })))
    const memory = await f.remember(notes.map((note) => note.ref))
    const legacy = () => f.db.prepare("UPDATE links SET metadata = NULL WHERE from_type = 'memory'").run()
    const signedAt = () => f.signatures(memory).map((signature) => signature?.checked_at ?? null)
    legacy()
    f.later()
    expect(await f.store.knowledge.checkSources({ limit: 2 })).toMatchObject({ checked: 2, baselined: 2 })
    expect(signedAt()).toEqual([2_000, 2_000, null])
    expect(await f.store.knowledge.checkSources({ limit: 2 })).toMatchObject({ checked: 1, baselined: 1 })
    expect(signedAt()).toEqual([2_000, 2_000, 2_000])
    legacy()
    f.later()
    expect(await f.store.knowledge.checkSources({ limit: 2 })).toMatchObject({ checked: 2, baselined: 2 })
    expect(signedAt()).toEqual([3_000, 3_000, null])
    await expect(f.store.knowledge.checkSources({ limit: 0 })).rejects.toMatchObject({ code: "validation_error" })
  })

  it("reads a bounded window of links per run among many that are not evidence, and moves on", async () => {
    const f = await quoted()
    const insert = f.db.prepare(
      "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author, updated_at) " +
        "VALUES ('note', ?, 'note', ?, 'links-to', 'owner', 1, 1000, 'owner', 1000)",
    )
    f.db.exec("BEGIN")
    for (let n = 0; n < 1_000; n++) insert.run(Number(f.note.id), Number(f.note.id))
    f.db.exec("COMMIT")
    const memory = await f.remember([f.note.ref])
    f.db.prepare("UPDATE links SET metadata = NULL WHERE from_type = 'memory'").run()
    const cursor = () =>
      Number(f.db.prepare("SELECT value FROM store_settings WHERE key = 'source-check.cursor'").get()?.value)
    let runs = 0
    while (f.signatures(memory)[0] === undefined && runs < 100) {
      const before = cursor() || 0
      const counts = await f.store.knowledge.checkSources({ limit: 5 })
      runs++
      if (counts.checked === 0) expect(cursor()).toBe(before + 100)
    }
    expect(runs).toBe(11)
    expect(cursor()).toBe(0)
  })

  it("stays within limit over a few thousand links", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    const insert = f.db.prepare(
      "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author, updated_at) " +
        "VALUES ('memory', ?, 'note', ?, 'evidence', 'owner', 1, 1000, 'owner', 1000)",
    )
    f.db.exec("BEGIN")
    for (let n = 0; n < 3_000; n++) insert.run(Number(memory.id), Number(f.note.id))
    f.db.exec("COMMIT")
    f.later()
    expect(await f.store.knowledge.checkSources({ limit: 500 })).toMatchObject({ checked: 500, baselined: 499 })
    const signed = f.db
      .prepare("SELECT count(*) AS n FROM links WHERE kind = 'evidence' AND json_extract(metadata, '$.checked_at') = ?")
      .get(2_000)
    expect(signed?.n).toBe(499)
  })
})

describe("a source deleted or retired", () => {
  it("raises a deleted review when a cited event is marked deleted", async () => {
    const f = await fixture()
    const id = Number(
      f.db
        .prepare(
          "INSERT INTO events (title, origin, created_at, updated_at) VALUES ('Delivery', 'calendar', 0, 0) RETURNING id",
        )
        .get()?.id,
    )
    const memory = await f.remember([referenceOfThing(f.db, { type: "event", id }) as string])
    f.later()
    f.db.prepare("UPDATE events SET deleted_at = 2000 WHERE id = ?").run(id)
    expect(await f.store.knowledge.checkSources()).toMatchObject({ raised: 1 })
    expect((await f.store.memories.get(memory.ref)).sourceReview).toMatchObject({ cause: "deleted" })
  })

  it("opens a deleted review for a memory whose cited fact is removed, in the same write", async () => {
    const f = await quoted()
    const fact = await f.store.facts.add({ type: "decision", statement: "Thursdays", by: "owner" })
    const memory = await f.remember([fact.ref])
    f.later()
    await f.store.facts.remove(fact.ref, "owner")
    expect(await f.store.memories.get(memory.ref)).toMatchObject({
      status: "confirmed",
      sourceReview: { cause: "deleted" },
    })
    expect(f.reviews()[0]?.payload.sources).toEqual([
      { link: expect.any(Number), ref: null, kind: "fact", cause: "deleted", citedRev: null },
    ])
    expect(await f.store.memories.sources(memory.ref)).toEqual([
      expect.objectContaining({ kind: "fact", missing: true }),
    ])
  })

  it("folds a cited fact's reversal into the open review of the memory resting on it", async () => {
    const f = await quoted()
    const fact = await f.store.facts.add({ type: "decision", statement: "Thursdays", by: "owner" })
    const memory = await f.remember([f.note.ref, fact.ref])
    await f.store.knowledge.challenge(memory.ref, { evidence: [f.note.ref], reason: "doubt", by: agent })
    f.later()
    await f.store.facts.reverse(fact.ref, "owner")
    await f.store.knowledge.checkSources()
    const reviews = f.reviews()
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.payload).toMatchObject({
      cause: "contradicted",
      sources: [{ ref: fact.ref, cause: "outdated" }],
      challenges: [{ reason: "doubt" }],
    })
  })

  it("writes nothing for links whose sources did not change, so a rerun queues no involvement", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    await f.store.knowledge.checkSources()
    const before = f.signatures(memory)
    f.db.prepare("DELETE FROM involvement_pending").run()
    f.later()
    expect(await f.store.knowledge.checkSources()).toMatchObject({ checked: 1, baselined: 0, refreshed: 0, raised: 0 })
    expect(f.signatures(memory)).toEqual(before)
    expect(f.db.prepare("SELECT * FROM involvement_pending").all()).toEqual([])
  })

  it("closes the open review of a memory met in the walk that no longer holds", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    await f.store.knowledge.challenge(memory.ref, { evidence: [f.note.ref], reason: "doubt", by: agent })
    f.db.prepare("UPDATE memories SET status = 'stale' WHERE id = ?").run(Number(memory.id))
    expect(await f.store.knowledge.checkSources()).toMatchObject({ closed: 1 })
    expect(f.reviews()[0]).toMatchObject({ status: "executed", result: { closed: "no-longer-holds" } })
  })
})

describe("a correction of a memory or fact under review", () => {
  it("of a memory keeps the review open while proposed, and closes it when confirmed", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    await f.store.knowledge.challenge(memory.ref, { evidence: [f.note.ref], reason: "wrong day", by: agent })
    const fix = await f.store.memories.add({
      kind: "preference",
      body: "Delivery is on the 30th",
      scope: "work",
      evidence: [f.note.ref],
      author: agent,
      supersedes: memory.ref,
    })
    expect(f.reviews()[0]?.status).toBe("proposed")
    expect((await f.store.memories.get(memory.ref)).status).toBe("confirmed")
    await f.store.memories.confirm(fix.ref, "owner")
    expect(f.reviews()[0]).toMatchObject({ status: "executed", result: { closed: "superseded" } })
  })

  it("of the owner's accepted fact is not accepted by an agent, even with agent decisions on", async () => {
    const f = await fixture(deciding)
    const note = await f.store.notes.addNote({ text: "Thursdays" })
    const fact = await f.store.facts.add({
      type: "decision",
      statement: "Thursdays",
      by: "owner",
      evidence: [note.ref],
    })
    await f.store.knowledge.challenge(fact.ref, { evidence: [note.ref], reason: "owner doubts", by: "owner" })
    const fix = await f.store.facts.add({ type: "decision", statement: "Fridays", by: agent, supersedes: fact.ref })
    await expect(f.store.facts.accept(fix.ref, { bot: "codex", reason: "looks right" })).rejects.toMatchObject({
      code: "permission_error",
      details: { reason: "proposal.owner-only" },
    })
    expect((await f.store.facts.get(fact.ref)).status).toBe("accepted")
    expect(f.reviews()[0]?.status).toBe("proposed")
    const proposed = await f.store.facts.add({ type: "decision", statement: "Mondays", by: agent })
    const fixOfProposed = await f.store.facts.add({
      type: "decision",
      statement: "Tuesdays",
      by: { bot: "other-agent" },
      supersedes: proposed.ref,
    })
    expect(await f.store.facts.accept(fixOfProposed.ref, { bot: "codex", reason: "fine" })).toMatchObject({
      status: "accepted",
    })
  })
})

describe("deciding a source review", () => {
  const raised = async (decisions?: DecisionPolicy) => {
    const f = await fixture(decisions)
    const note = await f.store.notes.addNote({ text: "We agreed delivery on the 28th." })
    const memory = await f.remember([note.ref])
    f.later()
    await f.store.notes.editNote(note.ref, "We agreed delivery on the 30th.", 1)
    await f.store.knowledge.checkSources()
    const id = String(f.reviews()[0]?.id)
    return { ...f, note, memory, id }
  }

  it("as still true re-baselines the sources and marks the memory verified now", async () => {
    const f = await raised()
    f.later()
    const decided = await f.store.knowledge.decideSourceReview(f.id, { confirm: true, by: "owner" })
    expect(decided).toMatchObject({ status: "approved", result: { stillTrue: true } })
    expect(await f.store.memories.get(f.memory.ref)).toMatchObject({
      status: "confirmed",
      sourceReview: null,
      lastVerifiedAt: new Date(3_000).toISOString(),
    })
    expect(f.signatures(f.memory)).toMatchObject([{ v: 1, rev: 2, checked_at: 3_000 }])
    expect(await f.store.knowledge.checkSources()).toMatchObject({ raised: 0 })
  })

  it("as dismissed re-baselines the sources and keeps the memory as it was", async () => {
    const f = await raised()
    const decided = await f.store.knowledge.decideSourceReview(f.id, { confirm: false, by: "owner", reason: "fine" })
    expect(decided).toMatchObject({ status: "rejected", result: { dismissed: true, reason: "fine" } })
    expect(await f.store.memories.get(f.memory.ref)).toMatchObject({ status: "confirmed", sourceReview: null })
    expect(await f.store.knowledge.checkSources()).toMatchObject({ raised: 0 })
  })

  it("through the review registry, and never as a generic action", async () => {
    const f = await raised()
    const registry = proposalRegistry(f.store)
    expect(await registry.get(f.id)).toMatchObject({
      kind: "memory_source_review",
      ownerOnly: true,
      subject: f.memory.ref,
    })
    await expect(f.store.proposedActions.approve(f.id, "owner")).rejects.toMatchObject({
      details: { reason: "source-review.dedicated-review" },
    })
    await expect(f.store.proposedActions.reject(f.id, "owner")).rejects.toMatchObject({
      details: { reason: "source-review.dedicated-review" },
    })
    await expect(
      f.store.proposedActions.propose({ kind: "memory_source_review", by: agent, target: f.memory.ref }),
    ).rejects.toMatchObject({ details: { reason: "source-review.dedicated-review" } })
    expect(await registry.decide([f.id], { confirm: true, by: "owner" })).toMatchObject({
      decided: [{ id: f.id, status: "confirmed" }],
      refused: [],
    })
  })

  it("is refused to an agent even when agent decisions are on", async () => {
    const f = await raised(deciding)
    const by = { bot: "codex", reason: "the note still says it" }
    expect(await proposalRegistry(f.store).decide([f.id], { confirm: true, by })).toMatchObject({
      decided: [],
      refused: [{ id: f.id, reason: "proposal.owner-only" }],
    })
    await expect(f.store.knowledge.decideSourceReview(f.id, { confirm: false, by })).rejects.toMatchObject({
      code: "permission_error",
      details: { reason: "proposal.owner-only" },
    })
    expect(f.reviews()[0]?.status).toBe("proposed")
  })
})

describe("retiring a confirmed memory", () => {
  it("is refused to an agent, who challenges it instead; the owner's invalidate closes its review", async () => {
    const f = await quoted()
    const store = await openStore({ path: f.path, decisions: deciding })
    opened.push({ store, db: await openCache(f.path) })
    const memory = await f.remember([f.note.ref])
    await expect(store.memories.markStale(memory.ref, { bot: "codex", reason: "outdated" })).rejects.toMatchObject({
      code: "permission_error",
      details: { reason: "proposal.owner-only" },
    })
    expect((await store.memories.get(memory.ref)).status).toBe("confirmed")
    await store.knowledge.challenge(memory.ref, { evidence: [f.note.ref], reason: "outdated", by: { bot: "codex" } })
    await f.store.memories.markStale(memory.ref, "owner")
    expect(f.reviews()[0]).toMatchObject({ status: "executed", result: { closed: "invalidated" } })
  })

  it("still lets an allowed agent turn down another agent's proposed memory", async () => {
    const f = await fixture(deciding)
    const note = await f.store.notes.addNote({ text: "We agreed delivery on the 28th." })
    const memory = await f.store.memories.add({
      kind: "preference",
      body: "Delivery is on the 28th",
      scope: "work",
      evidence: [note.ref],
      author: agent,
    })
    expect(await f.store.memories.markStale(memory.ref, { bot: "codex", reason: "no" })).toMatchObject({
      status: "stale",
    })
  })
})

describe("the cost of a check", () => {
  it("walks links by their primary key with no sort", async () => {
    const f = await quoted()
    const plan = f.db
      .prepare(`EXPLAIN QUERY PLAN ${SOURCE_WALK}`)
      .all(0, Number.MAX_SAFE_INTEGER, 500)
      .map((row) => String(row.detail))
    expect(plan.join(" | ")).toMatch(/USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/)
    expect(plan.join(" | ")).not.toContain("TEMP B-TREE")
  })
})

describe("erasing a memory or fact under review", () => {
  it("erases its reviews too, leaving no pointer at the erased row", async () => {
    const f = await quoted()
    const memory = await f.remember([f.note.ref])
    const fact = await f.store.facts.add({ type: "decision", statement: "28th", by: "owner", evidence: [f.note.ref] })
    for (const ref of [memory.ref, fact.ref])
      await f.store.knowledge.challenge(ref, { evidence: [f.note.ref], reason: "doubt", by: agent, suggestion: "30th" })
    await f.store.memories.remove(memory.ref, "owner")
    await f.store.facts.remove(fact.ref, "owner")
    expect(f.reviews()).toEqual([])
    expect(orphanPointers(f.db).filter((orphan) => orphan.table === "proposed_actions")).toEqual([])
  })
})

describe("purging an account under review", () => {
  it("opens deleted reviews for its chat and messages, erasing their words from every review", async () => {
    const f = await fixture()
    await f.store.accounts.saveAccount(CHAT, { name: "Example chat" })
    await f.store.messages.saveMessages(CHAT, "c", [{ ...MESSAGE, text: "delivery on the 28th" }], { via: "update" })
    const message = Number(f.db.prepare("SELECT id FROM messages").get()?.id)
    const chat = Number(f.db.prepare("SELECT id FROM chats").get()?.id)
    const messageRef = referenceOfThing(f.db, { type: "message", id: message }) as string
    const chatRef = referenceOfThing(f.db, { type: "chat", id: chat }) as string
    const memory = await f.remember([{ ref: messageRef, quote: "delivery on the 28th" }, chatRef])
    const note = await f.store.notes.addNote({ text: "Another note" })
    const other = await f.remember([note.ref], "Unrelated")
    await f.store.knowledge.challenge(memory.ref, {
      evidence: [messageRef],
      reason: "Kai wrote: delivery on the 28th is cancelled",
      by: agent,
      suggestion: "Kai said delivery on the 30th",
    })
    await f.store.knowledge.challenge(other.ref, { evidence: [messageRef], reason: "Kai wrote: 28th", by: agent })
    await f.store.memories.markStale(other.ref, "owner")
    f.later()
    await f.store.accounts.purge(CHAT)
    const reviews = f.reviews()
    expect(JSON.stringify(reviews)).not.toMatch(/28th|30th|Kai|example-chat/)
    expect(reviews.find((review) => review.target_id === Number(memory.id))?.payload).toMatchObject({
      cause: "contradicted",
      sources: expect.arrayContaining([
        expect.objectContaining({ ref: null, kind: "message", cause: "deleted" }),
        expect.objectContaining({ ref: null, kind: "chat", cause: "deleted" }),
      ]),
      challenges: [{ evidence: [], reason: "[source erased]" }],
      suggestions: [{ evidence: [], body: "[source erased]" }],
    })
    expect(reviews.find((review) => review.target_id === Number(other.id))).toMatchObject({
      status: "executed",
      payload: { challenges: [{ reason: "[source erased]" }] },
    })
    expect(orphanPointers(f.db).filter((orphan) => ["links", "proposed_actions"].includes(orphan.table))).toEqual([])
    expect(await f.store.knowledge.checkSources()).toMatchObject({ raised: 0 })
  })
})

describe("a chat merge", () => {
  it("moves evidence onto the kept chat and messages with nothing to review", async () => {
    const f = await fixture()
    const owner = { provider: "whatsapp", account: "1@lid" }
    const chatOf = (id: string, title: string | null) => ({
      id,
      title,
      kind: "dialog" as const,
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: null,
    })
    await f.store.accounts.saveAccount(owner, { name: "WhatsApp" })
    await f.store.chats.saveChats(owner, [chatOf("phone", null), chatOf("lid", "Ana")])
    await f.store.messages.saveMessages(
      owner,
      "phone",
      [{ ...MESSAGE, id: "A2", chatId: "phone", text: "held twice" }],
      {
        via: "history",
      },
    )
    await f.store.messages.saveMessages(owner, "lid", [{ ...MESSAGE, id: "A2", chatId: "lid", text: "held twice" }], {
      via: "update",
    })
    const gone = Number(f.db.prepare("SELECT id FROM chats WHERE external_id = 'lid'").get()?.id)
    const copy = Number(f.db.prepare("SELECT id FROM messages WHERE chat_id = ?").get(gone)?.id)
    await f.remember([
      referenceOfThing(f.db, { type: "chat", id: gone }) as string,
      { ref: referenceOfThing(f.db, { type: "message", id: copy }) as string, quote: "held twice" },
    ])
    f.later()
    await f.store.chats.rekeyChat(owner, "phone", "lid")
    expect(await f.store.knowledge.checkSources()).toMatchObject({ checked: 2, raised: 0, refreshed: 0 })
    expect(f.reviews()).toEqual([])
  })
})

describe("what a source check offers for reading again", () => {
  it("lists changed sources, raised or signed anew, but not deleted ones, cited memories, or what a batch reads", async () => {
    const f = await fixture()
    const notes = await Promise.all(
      ["Delivery on the 28th", "Call at 10", "Room 4", "Gone soon"].map((text) => f.store.notes.addNote({ text })),
    )
    const [kept, raised, extracting, gone] = notes as [
      (typeof notes)[0],
      (typeof notes)[0],
      (typeof notes)[0],
      (typeof notes)[0],
    ]
    const cited = await f.remember([kept.ref], "Cited memory")
    await f.remember([{ ref: kept.ref, quote: "Delivery" }, raised.ref, extracting.ref, gone.ref, cited.ref])
    f.later()
    await f.store.notes.editNote(kept.ref, "Delivery on the 30th", 1)
    await f.store.notes.editNote(raised.ref, "Call at 11", 1)
    await f.store.notes.editNote(extracting.ref, "Room 5", 1)
    await f.store.notes.removeNote(gone.ref)
    await f.store.memories.markStale(cited.ref, "owner")
    const record = await f.store.contextRecords?.read(extracting.ref)
    if (!record) throw new Error("Missing record")
    const project = await f.store.knowledge.addProject({ name: "Harbour" })
    await f.store.evidenceFindings.stage(
      {
        schemaVersion: 1,
        key: "room",
        extractor: "synthetic",
        findings: [
          {
            id: "room",
            kind: "fact",
            type: "decision",
            statement: "The meeting moved to room 5",
            project: project.ref,
            evidence: [{ reference: extracting.ref, fingerprint: contextEvidenceFingerprint(record) }],
          },
        ],
      },
      agent,
    )
    const check = await f.store.knowledge.checkSources()
    expect(check.changedRefs.sort()).toEqual([kept.ref, raised.ref].sort())
  })
})

describe("changed sources since a time", () => {
  it("still lists a change an earlier check took, and leaves out deleted, extracted and unchanged sources", async () => {
    const f = await fixture()
    const notes = await Promise.all(
      ["Delivery on the 28th", "Call at 10", "Room 4", "Gone soon", "Same"].map((text) =>
        f.store.notes.addNote({ text }),
      ),
    )
    const [kept, raised, extracting, gone, same] = notes as [
      (typeof notes)[0],
      (typeof notes)[0],
      (typeof notes)[0],
      (typeof notes)[0],
      (typeof notes)[0],
    ]
    await f.remember([{ ref: kept.ref, quote: "Delivery" }, raised.ref, extracting.ref, gone.ref, same.ref])
    f.later()
    await f.store.notes.editNote(kept.ref, "Delivery on the 30th", 1)
    await f.store.notes.editNote(raised.ref, "Call at 11", 1)
    await f.store.notes.editNote(extracting.ref, "Room 5", 1)
    await f.store.notes.removeNote(gone.ref)
    const since = f.clock.at
    expect((await f.store.knowledge.checkSources()).changedRefs.sort()).toEqual(
      [kept.ref, raised.ref, extracting.ref].sort(),
    )
    f.later()
    expect((await f.store.knowledge.checkSources()).changedRefs).toEqual([])
    const record = await f.store.contextRecords?.read(extracting.ref)
    if (!record) throw new Error("Missing record")
    const project = await f.store.knowledge.addProject({ name: "Harbour" })
    await f.store.evidenceFindings.stage(
      {
        schemaVersion: 1,
        key: "room",
        extractor: "synthetic",
        findings: [
          {
            id: "room",
            kind: "fact",
            type: "decision",
            statement: "The meeting moved to room 5",
            project: project.ref,
            evidence: [{ reference: extracting.ref, fingerprint: contextEvidenceFingerprint(record) }],
          },
        ],
      },
      agent,
    )
    const changed = await f.store.knowledge.changedSources({ since })
    expect(changed.map(({ ref }) => ref).sort()).toEqual([kept.ref, raised.ref].sort())
    expect(changed[0]?.checkedAt).toBe(new Date(since).toISOString())
    expect(await f.store.knowledge.changedSources({ since: since + 1 })).toEqual([])
  })
})

describe("reading a review's sources", () => {
  it("gives each source as cited and as it is now, with the quote, while the review holds no text", async () => {
    const f = await quoted()
    const other = await f.store.notes.addNote({ text: "Second note" })
    const memory = await f.remember([{ ref: f.note.ref, quote: "delivery on the 28th" }, other.ref])
    f.later()
    await f.store.notes.editNote(f.note.ref, "We agreed delivery on the 30th.", 1)
    await f.store.notes.removeNote(other.ref)
    await f.store.knowledge.checkSources()
    const marker = (await f.store.memories.get(memory.ref)).sourceReview
    expect(await f.store.knowledge.sourceReviewTexts(marker?.id as string)).toEqual([
      { link: expect.any(Number), ref: null, quote: null, cited: null, now: null },
      {
        link: expect.any(Number),
        ref: f.note.ref,
        quote: "delivery on the 28th",
        cited: "We agreed delivery on the 28th. Call at 10.",
        now: "We agreed delivery on the 30th.",
      },
    ])
  })

  it("refuses a proposal that is not a source review", async () => {
    const f = await quoted()
    const memory = await f.store.memories.add({
      kind: "preference",
      body: "Proposed",
      scope: "work",
      evidence: [f.note.ref],
      author: agent,
      status: "proposed",
    })
    const proposal = (await f.store.proposedActions.list({})).find((one) => one.target === memory.ref)
    await expect(f.store.knowledge.sourceReviewTexts(proposal?.id ?? "1")).rejects.toMatchObject({
      code: expect.stringMatching(/validation_error|not_found/),
    })
  })
})
