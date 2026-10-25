import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { MOVED_TO_MEMO, movedCommandError, movedPath, movedPointer } from "./moved.js"
import { run } from "./program.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "1.0.0" }
const commands = () => {
  const search = new Command("search")
  search.addCommand(new Command("messages").action(() => {}))
  return [search]
}

const callWith = async (program: () => Command[], ...argv: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "moved-"))
  const streams = captureStreams()
  const env = { ...process.env, APP_STATE_DIR: join(root, "state"), APP_CONFIG_DIR: join(root, "config") }
  const code = await run([...argv, "--json", "--no-record"], { app, commands: program }, { streams, tty: false, env })
  return { code, error: JSON.parse(streams.stdout[0] ?? streams.stderr[0] ?? "null")?.error }
}

describe("a command that moved to memo", () => {
  it.each([[["search", "mail", "invoice"]], [["personal", "search", "mail", "invoice"]]])(
    "`app %j` answers with the pointer, not unknown command",
    async (argv) => {
      const { code, error } = await callWith(commands, ...argv)

      expect(code).toBe(2)
      expect(error).toMatchObject({ code: "validation_error" })
      expect(error.message).toBe(`\`app search mail\` is not here — ${movedPointer("search mail")}`)
    },
  )

  it("leaves a command the program still has, and a word a command's argument holds", async () => {
    expect(movedPath(["search", "mail"], (path) => path === "search mail")).toBeUndefined()
    const bareSearch = () => [new Command("search").argument("[words...]").action(() => {})]
    expect((await callWith(bareSearch, "search", "mail", "hands")).code).toBe(0)
  })

  it("names a memo command for every entry", () => {
    for (const path of Object.keys(MOVED_TO_MEMO)) expect(movedPointer(path)).toMatch(/then `memo [a-z]/)
  })
})

describe("movedCommandError, for a CLI that parses without run", () => {
  it("names the new path for a renamed one, and nothing for a path the program has", () => {
    const program = new Command("drive")
    program
      .command("models")
      .command("download")
      .action(() => {})

    expect(movedCommandError(program, ["models", "text", "download", "--json"])?.message).toBe(
      "`drive models text download` is not here — use `models download`",
    )
    expect(movedCommandError(program, ["models", "download"])).toBeUndefined()
  })
})
