import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { outputFor } from "./context.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { answerFields, checkJson, liftJson } from "./json-fields.js"
import { run } from "./program.js"
import { commandAt } from "./steps.js"

const root = new Command("chat")
const chats = root.command("chats")
const list = annotate(chats.command("list"), { output: { entity: "chat" } })
root.command("messages").command("list").argument("[chat]")
const target = (words: string[]) =>
  commandAt(
    root,
    words
      .filter((word) => !word.startsWith("-"))
      .slice(0, 2)
      .join(" "),
  )

describe("--json [fields]", () => {
  it("uses a provider's result fields for parsing, validation and terminal guidance", () => {
    const providerFields = (command: Command | undefined) => (command === list ? ["name", "mime"] : undefined)
    expect(answerFields(list, providerFields)).toEqual(["name", "mime"])
    expect(liftJson(["chats", "list", "--json", "name"], target, providerFields)).toEqual({
      argv: ["chats", "list", "--json"],
      json: true,
      fields: "name",
    })
    expect(() => checkJson(list, { json: true, fields: "name" }, false, providerFields)).not.toThrow()
    expect(() => checkJson(list, { json: true, fields: "title" }, false, providerFields)).toThrow(
      "no field title here; the fields are name, mime",
    )
    expect(() => checkJson(list, { json: true }, true, providerFields)).toThrow("--json=name,mime")
  })

  it("falls back to shared fields when a provider leaves a command undescribed", () => {
    expect(answerFields(list, () => undefined)).toEqual(answerFields(list))
    expect(() => checkJson(list, { json: true, fields: "title" }, false, () => undefined)).not.toThrow()
    expect(answerFields(undefined, () => undefined)).toBeUndefined()
  })

  it("takes fields after = or as the next word when they are the answer's fields", () => {
    expect(liftJson(["chats", "list", "--json=title,kind"], target)).toEqual({
      argv: ["chats", "list", "--json"],
      json: true,
      fields: "title,kind",
    })
    expect(liftJson(["chats", "list", "--json", "title"], target)).toEqual({
      argv: ["chats", "list", "--json"],
      json: true,
      fields: "title",
    })
  })

  it("never takes a command word or a positional argument", () => {
    expect(liftJson(["--json", "chats", "list"], target).argv).toEqual(["--json", "chats", "list"])
    expect(liftJson(["messages", "list", "--json", "111"], target).argv).toEqual(["messages", "list", "--json", "111"])
    expect(liftJson(["messages", "list", "--json", "olga"], target)).toEqual({
      argv: ["messages", "list", "--json", "olga"],
      json: true,
    })
    expect(liftJson(["chats", "list", "--", "--json=title"], target).argv).toEqual([
      "chats",
      "list",
      "--",
      "--json=title",
    ])
  })

  it("refuses a field the answer does not have, naming the ones it has", () => {
    expect(() => checkJson(list, { json: true, fields: "title,unreadCount" }, false)).toThrow(
      /no field unreadCount here; the fields are ref, id/,
    )
    expect(() => checkJson(list, { json: true, fields: "title" }, false)).not.toThrow()
  })

  it("at a terminal, asks for the fields instead of printing them all; in a pipe, prints them all", () => {
    expect(() => checkJson(list, { json: true }, true)).toThrow(expect.objectContaining({ code: "validation_error" }))
    expect(() => checkJson(list, { json: true }, false)).not.toThrow()
    expect(() => checkJson(commandAt(root, "messages list") as Command, { json: true }, true)).not.toThrow()
  })
})

describe("--json [fields] through the program", () => {
  const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
  const definition = {
    app,
    commands: () => [
      new Command("chats").addCommand(
        annotate(
          new Command("show").action(function (this: Command) {
            renderAnswer(this, outputFor(this), itemOf({ ref: "chat:x/1", id: "1", title: "Synthetic", kind: "group" }))
          }),
          { output: { entity: "chat" } },
        ),
      ),
    ],
  }
  const call = async (argv: string[], tty = false) => {
    const streams = captureStreams()
    const code = await run([...argv, "--no-record"], definition, { streams, tty, env: process.env })
    return { code, stdout: streams.stdout, stderr: streams.stderr }
  }

  it.each([["--json=title"], ["--json", "title"]])(
    "%s %s keeps the item's title, and the envelope",
    async (...flags) => {
      const { code, stdout } = await call(["chats", "show", ...flags])
      expect(code).toBe(0)
      const printed = JSON.parse(stdout[0] ?? "")
      expect(printed.item).toEqual({ title: "Synthetic" })
      expect(printed.meta.run_id).toEqual(expect.any(String))
    },
  )

  it("prints every field in a pipe, and at a terminal names them instead", async () => {
    expect(JSON.parse((await call(["chats", "show", "--json"])).stdout[0] ?? "").item.kind).toBe("group")
    const asked = await call(["chats", "show", "--json"], true)
    expect(asked.code).toBe(2)
    expect(asked.stdout).toEqual([])
    expect(asked.stderr.join("\n")).toContain("the fields are ref, id")
  })

  it("has no --agent-json and no --fields any more", async () => {
    expect((await call(["chats", "show", "--agent-json"])).code).toBe(2)
    expect((await call(["chats", "show", "--fields", "title"])).code).toBe(2)
  })
})
