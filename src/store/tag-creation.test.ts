import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tag-creation-")), "fixture.db")
  const store = await openStore({ path, now: () => 3000 })
  stores.push(store)
  const project = await store.knowledge.addProject({ name: "Research Example", key: "RES" })
  const tag = await store.knowledge.createTag("onboarding")
  return { store, path, project, tag }
}

describe("native label creation review", () => {
  it("refuses similar labels on implicit writes and rolls back the whole batch", async () => {
    const { store, project } = await fixture()
    await expect(
      store.knowledge.addTags(null, { type: "project", id: project.id }, ["garden", "on-boarding"]),
    ).rejects.toMatchObject({ details: { reason: "tag-review.required", candidates: [{ name: "onboarding" }] } })
    expect(await store.knowledge.tags(null, { type: "project", id: project.id })).toEqual([])
    expect((await store.knowledge.resolveVocabulary("garden")).matches).toEqual([])
  })
  it("allows an owner-reviewed distinct label but never permits agent override", async () => {
    const { store } = await fixture()
    const review = await store.knowledge.tagPreflight("on-boarding")
    expect(review.disposition).toBe("review")
    await expect(
      store.knowledge.createTag("on-boarding", {
        by: "agent",
        expectedCreationFingerprint: review.creationFingerprint,
      }),
    ).rejects.toMatchObject({ code: "permission_error" })
    expect(
      await store.knowledge.createTag("on-boarding", { expectedCreationFingerprint: review.creationFingerprint }),
    ).toMatchObject({ name: "on-boarding", kind: "tag" })
  })
  it("binds approval to the requested name and kind and refuses stale cross-handle previews", async () => {
    const { store, path } = await fixture()
    const review = await store.knowledge.tagPreflight("on-boarding")
    for (const input of [
      { name: "onboardings", kind: "tag" as const },
      { name: "on-boarding", kind: "topic" as const },
    ])
      await expect(
        store.knowledge.createTag(input.name, {
          kind: input.kind,
          expectedCreationFingerprint: review.creationFingerprint,
        }),
      ).rejects.toMatchObject({ details: { reason: "tag-review.stale" } })
    const second = await openStore({ path, now: () => 4000 })
    stores.push(second)
    await second.knowledge.createTag("garden")
    await expect(
      store.knowledge.createTag("on-boarding", { expectedCreationFingerprint: review.creationFingerprint }),
    ).rejects.toMatchObject({ details: { reason: "tag-review.stale" } })
    await expect(
      store.knowledge.createTag("on-boarding", { expectedCreationFingerprint: "bad" }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })
  it("checks both kinds and explicit aliases without choosing a similar canonical target", async () => {
    const { store, project, tag } = await fixture()
    await store.knowledge.addVocabularyAlias({ kind: "tag", id: String(tag.id) }, "arrival")
    await expect(store.knowledge.createTag("arrivals", { kind: "topic" })).rejects.toMatchObject({
      details: { reason: "tag-review.required", candidates: [{ id: String(tag.id) }] },
    })
    expect(await store.knowledge.addTags(null, { type: "project", id: project.id }, ["arrival"])).toEqual([
      "onboarding",
    ])
    expect((await store.knowledge.vocabulary({ kind: "tag" })).entries).toHaveLength(1)
  })
})
