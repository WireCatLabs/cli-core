import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { terminalAsker } from "../index.js"

const parsed = (...argv: string[]) => {
  const command = new Command("call")
    .option("--yes")
    .option("--json")
    .action(() => {})
  command.parse(argv, { from: "user" })
  return command
}

describe("terminalAsker", () => {
  it("goes ahead on --yes", async () => {
    await expect(terminalAsker(parsed("--yes"))("api.events.insert", { chatId: null })).resolves.toBeUndefined()
  })

  it("refuses under --json without asking, and names the permission it needed", async () => {
    await expect(terminalAsker(parsed("--json"))("api.events.insert", { chatId: null })).rejects.toMatchObject({
      code: "confirmation_required",
      message: expect.stringContaining("add --yes to go ahead"),
      details: { permission: "api.events.insert" },
    })
  })
})
