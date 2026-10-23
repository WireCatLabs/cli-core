import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { type MessageStore, openStore } from "../store/store.js"
import { meetingSearchesService } from "./meeting-searches.js"
import { searchesService } from "./searches.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "cli-test-searches-")), "store.db") })
  stores.push(store)
  return {
    store,
    meetings: meetingSearchesService(async () => store.searches),
    messages: searchesService({ store: async () => store } as never),
  }
}

it("saves, lists, runs and deletes a meeting search with its options", async () => {
  const { meetings, store } = await fixture()
  await meetings.create("Weekly-Plan", { query: "example plan", options: { project: "RES", limit: 5 } })
  expect((await meetings.list()).map((one) => [one.name, one.command, one.params])).toEqual([
    ["weekly-plan", "meetings-search", { limit: 5, project: "RES", text: "example plan" }],
  ])
  expect(await meetings.run("weekly-plan")).toMatchObject({
    name: "weekly-plan",
    query: "example plan",
    options: { limit: 5, project: "RES" },
  })
  expect((await meetings.show("weekly-plan")).runs).toBe(1)
  expect((await store.searches.searchHistory(5, 0, ["meetings-search"])).length).toBe(2)
  await meetings.delete("weekly-plan")
  await expect(meetings.show("weekly-plan")).rejects.toMatchObject({ code: "not_found" })
})

it("keeps meeting and message searches apart in the shared table", async () => {
  const { meetings, messages } = await fixture()
  await meetings.create("from-meetings", { query: "example plan", options: {} })
  await messages.create("from-messages", { text: "example" })
  expect((await meetings.list()).map((one) => one.name)).toEqual(["from-meetings"])
  expect((await messages.list()).map((one) => one.name)).toEqual(["from-messages"])
  await expect(meetings.run("from-messages")).rejects.toMatchObject({
    code: "validation_error",
    details: { reason: "search.kind" },
  })
  await expect(messages.resolve("from-meetings", {})).rejects.toMatchObject({ details: { reason: "search.kind" } })
  await expect(messages.delete("from-meetings")).rejects.toMatchObject({ details: { reason: "search.kind" } })
  await meetings.run("from-meetings")
  expect((await messages.history(10)).items.map((one) => one.command)).not.toContain("meetings-search")
  expect((await messages.clear()).cleared).toBe(0)
  await expect(meetings.create("from-messages", { query: "x", options: {} })).rejects.toMatchObject({
    details: { reason: "name.taken" },
  })
})
