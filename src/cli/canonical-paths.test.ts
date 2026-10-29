import type { Command } from "commander"
import { describe, expect, it } from "vitest"
import { sharedProgram } from "../testing/shared-program.js"
import { createProgram } from "./program.js"

const walk = (command: Command): Command[] => [command, ...command.commands.flatMap(walk)]

describe("canonical command paths", () => {
  it("mounts no compatibility command aliases or hidden legacy paths", () => {
    const program = createProgram(sharedProgram)
    for (const command of walk(program)) expect(command.aliases()).toEqual([])
    const contacts = program.commands.find((command) => command.name() === "contacts")
    expect(contacts?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["show", "events", "aliases"]),
    )
    const models = program.commands.find((command) => command.name() === "models")
    expect(models?.commands.map((command) => command.name()).sort()).toEqual(["download", "keys", "list"])
  })
})
