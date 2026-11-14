import { Command } from "commander"
import { expect, it } from "vitest"
import { provide } from "./context.js"
import { pagingOf, withPaging } from "./paging.js"

it("pages by the shipped default when a host's settings leave out limit and page", () => {
  const program = new Command("app")
  const list = withPaging(program.command("list"))
  provide(program, { resolveSettings: () => ({}) } as unknown as Parameters<typeof provide>[1])
  program.parse(["node", "app", "list"])
  expect(pagingOf(list)).toEqual({ limit: 20, page: 1 })
})
