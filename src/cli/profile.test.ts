import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { commandWords, liftProfile, refuseCommandName, rootOf } from "./profile.js"
import { createProgram } from "./program.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "0.0.0" }
const commands = () => {
  const session = new Command("session")
  session.command("start")
  session.command("end")
  return [session, new Command("chats"), new Command("messages")]
}
const createProgram_ = () => createProgram({ app, commands })

const words = () => commandWords(createProgram_())

describe("the first word", () => {
  it("is the profile when it is not a command", () => {
    expect(liftProfile(["personal", "chats", "list"], words())).toEqual({
      profile: "personal",
      rest: ["chats", "list"],
    })
  })

  it("is the command when it is one, and then there is no profile", () => {
    expect(liftProfile(["chats", "list"], words())).toEqual({ rest: ["chats", "list"] })
  })

  it("**is never an option** — `app --json chats list` still works", () => {
    expect(liftProfile(["--json", "chats", "list"], words())).toEqual({ rest: ["--json", "chats", "list"] })
  })

  it("**comes after the options before it**, and an option's value is never the profile", () => {
    expect(liftProfile(["--json", "personal", "chats", "list"], words())).toEqual({
      profile: "personal",
      rest: ["--json", "chats", "list"],
    })
    expect(liftProfile(["--timeout", "5s", "personal", "chats"], words(), new Set(["--timeout"]))).toEqual({
      profile: "personal",
      rest: ["--timeout", "5s", "chats"],
    })
  })

  it("is nothing at all when there are no arguments", () => {
    expect(liftProfile([], words())).toEqual({ rest: [] })
  })

  it("counts `help` as a command, which commander answers without listing it", () => {
    expect(liftProfile(["help", "chats"], words())).toEqual({ rest: ["help", "chats"] })
  })
})

describe("a profile named after a command", () => {
  it("is refused at creation, which is the only moment it can be explained", () => {
    expect(() => refuseCommandName("chats", words(), "app")).toThrowError(
      expect.objectContaining({ code: "validation_error" }),
    )
    expect(() => refuseCommandName("chats", words(), "app")).toThrowError(/would always mean the command/)
  })

  it("does not stop an ordinary name", () => {
    expect(() => refuseCommandName("personal", words(), "app")).not.toThrow()
  })

  /**
   * `session start` asks the tree it is standing in, so this is the half that can break without
   * any test noticing: stop one level short and the list is `help, start, end`, which accepts a
   * profile called `chats` and refuses one called `start`.
   */
  it("sees every command from inside a subcommand, not just its neighbours", () => {
    const program = createProgram_()
    const session = program.commands.find((command) => command.name() === "session")
    const start = session?.commands.find((command) => command.name() === "start")

    expect(start).toBeDefined()
    if (!start) return
    expect([...commandWords(rootOf(start))].sort()).toEqual([...words()].sort())
    expect(commandWords(rootOf(start)).has("chats")).toBe(true)
  })
})
