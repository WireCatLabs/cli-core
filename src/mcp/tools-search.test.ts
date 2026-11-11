import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { type McpCommand, search } from "./surface.js"

const command = (title: string, description: string, extra: Partial<McpCommand> = {}): McpCommand => ({
  title,
  description,
  writes: false,
  input: v.object({}),
  run: async () => ({ content: [] }),
  ...extra,
})

const catalogue: Record<string, McpCommand> = {
  me: command("who the bot is", "the bot's own account"),
  "messages list": command("list messages", "messages of one chat, newest first"),
  "relationships list": command("list relationships", "who works where and who reports to whom"),
  "relationships end": command("end a relationship", "mark a relationship as over; it stays in the history"),
  "groups add": command("add an account to a group", "memo <group> reads only the group's accounts", {
    keywords: ["memo", "groups", "add", "work", "telegram:300"],
  }),
  "people show": command("one person", "a person's identities", { aliases: ["contacts show"] }),
}

const names = (query: string) => search(catalogue, query).map(([name]) => name)

describe("tools search", () => {
  it("**ranks a task phrase by the words it matches**, not only when every word is there", () => {
    expect(names("say a relationship ended")[0]).toBe("relationships end")
    expect(names("put an account in a group")[0]).toBe("groups add")
    expect(names("who reports to whom")[0]).toBe("relationships list")
  })

  it("reads the words of the help's examples and the command's aliases", () => {
    expect(names("telegram")).toEqual(["groups add"])
    expect(names("contacts show")[0]).toBe("people show")
  })

  it("puts the command named exactly first, even when its name is part of others", () => {
    expect(names("me")[0]).toBe("me")
    expect(names("messages list")[0]).toBe("messages list")
  })

  it("finds nothing for words that carry no task, and lists everything for no words", () => {
    expect(names("of the to")).toEqual([])
    expect(names("zebra")).toEqual([])
    expect(names("")).toEqual(Object.keys(catalogue).sort())
  })
})
