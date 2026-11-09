import { Command } from "commander"
import { expect, it } from "vitest"
import type { AppIdentity } from "../ports/app.js"
import { provide } from "./context.js"
import { allAnswer } from "./messenger/search-answers.js"
import { commandPermissions } from "./permission-keys.js"
import { deniedKinds, deniedKindsOf } from "./search-left-out.js"
import { settingsFor } from "./settings.js"

const APP: AppIdentity = {
  command: "books",
  appName: "example-books-cli",
  envPrefix: "BOOKS",
  description: "synthetic",
  version: "1.0.0",
  messenger: false,
}

const leafUnder = (overrides: string[]) => {
  const root = new Command("books")
  const leaf = new Command("all")
  root.addCommand(new Command("search").addCommand(leaf))
  provide(root, {
    env: {},
    resolveSettings: settingsFor(APP, { permissions: commandPermissions() }).resolveSettings,
    agent: { result: () => {}, failure: () => {}, overrides },
  })
  return leaf
}

it("leaves the business lane out under business: deny, beside deals, and the answer says so", () => {
  const denied = deniedKinds(leafUnder(["business=deny"]), APP, ["business", "deal"])
  expect(denied).toEqual([
    {
      kind: "business",
      key: "business.list",
      why: expect.stringMatching(/^business left out: profile .* business\.list$/),
    },
  ])
  const answer = allAnswer(
    "search all",
    { query: "invoice", items: [], hasMore: false, searched: [], accounts: [], skipped: [] },
    { limit: 10 },
    false,
    [],
    denied,
  )
  expect(answer.missing).toContainEqual({ field: "items", why: denied[0]?.why })
  expect(deniedKinds(leafUnder([]), APP, ["business"])).toEqual([])
})

it("leaves out the kinds a CLI's own permission levels deny, naming who denies them", () => {
  expect(
    deniedKindsOf({ "deals.list": "deny", "leads.list": "allow" }, ["deal", "lead"], "memo's permissions", {}),
  ).toEqual([{ kind: "deal", key: "deals.list", why: "deal left out: memo's permissions denies deals.list" }])
})
