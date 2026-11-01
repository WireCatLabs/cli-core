import { Command } from "commander"
import { expect, it } from "vitest"
import { priorityOption } from "./priority.js"

it("keeps --priority none as a word through Commander, which turns a parser's null into an empty string", () => {
  const parsed = (value: string) =>
    new Command().option("--priority <n>", "", priorityOption).parse(["--priority", value], { from: "user" }).opts()
  expect(parsed("none")).toEqual({ priority: "none" })
  expect(parsed("high")).toEqual({ priority: 0.625 })
})
