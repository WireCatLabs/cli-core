import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { queryWordsAfterOptions } from "../meetings/cli/index.js"
import { run } from "./program.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.2.3" }

const call = async (argv: string[]) => {
  let query: string[] | undefined
  const list = queryWordsAfterOptions(new Command("list"))
    .argument("[query...]")
    .option("--limit <n>")
    .action((words: string[]) => {
      query = words
    })
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [new Command("chats").addCommand(list)] },
    {
      streams,
      tty: false,
      env: process.env,
    },
  )
  return { code, query, error: streams.stderr[0] ? JSON.parse(streams.stderr[0]).error.message : undefined }
}

describe("a command that takes a query", () => {
  it("**refuses a mistyped option** as any command does, with the option it meant", async () => {
    const { code, query, error } = await call(["work", "chats", "list", "kind:group", "--limt", "5"])

    expect([code, query]).toEqual([2, undefined])
    expect(error).toBe("unknown option '--limt' (Did you mean --limit?)")
  })

  it("**prints its help for `--help`**, as a command without a query does", async () => {
    const out: string[] = []
    const list = queryWordsAfterOptions(new Command("list")).argument("[query...]").option("--limit <n>")
    list.exitOverride().configureOutput({ writeOut: (text) => out.push(text) })

    await expect(list.parseAsync(["kind:group", "--help"], { from: "user" })).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    })
    expect(out.join("")).toContain("Usage: list [options] [query...]")
  })

  it("reads a negated term as query", async () => {
    expect((await call(["work", "chats", "list", "-kind:channel", "--limit", "5"])).query).toEqual(["-kind:channel"])
  })

  it("**reads every word after `--` as query**, an option-looking one too", async () => {
    expect((await call(["work", "chats", "list", "--", "--foo"])).query).toEqual(["--foo"])
    expect((await call(["work", "chats", "list", "-kind:channel", "--", "--foo"])).query).toEqual([
      "-kind:channel",
      "--foo",
    ])
  })
})
