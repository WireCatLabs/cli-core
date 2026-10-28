import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { commandsCommand } from "../commands-command.js"
import { NO_EFFECTS } from "../effects.js"
import { type ProgramDefinition, run } from "../program.js"
import { firstScreen, installHelp } from "./first-screen.js"

const app = { command: "tg", appName: "tg-cli", envPrefix: "TG", description: "Telegram for scripts", version: "1.0.0" }

const leaf = (name: string, description: string) =>
  annotate(new Command(name), { effects: NO_EFFECTS })
    .description(description)
    .action(() => {})

const fakeTool: ProgramDefinition = {
  app,
  firstScreen: {
    pitch: "your personal Telegram for agents and scripts. Reads go to a local store.",
    can: [
      { command: "review --since 1d", does: "who owes whom what, across every chat" },
      { command: 'search all "invoice"', does: "messages, files and voice notes as text, offline" },
    ],
  },
  commands: () => [
    leaf("setup", "guided first run"),
    new Command("account").description("the logged-in account").addCommand(leaf("list", "every profile")),
    new Command("chats").description("the account's chats").addCommand(leaf("list", "chats, newest first")),
    new Command("skill").description("agent instructions").addCommand(leaf("show", "print the skill")),
    commandsCommand(app),
  ],
}

const call = async (argv: string[], definition: ProgramDefinition = fakeTool, tty = false) => {
  const streams = captureStreams()
  const code = await run(argv, definition, { streams, tty, env: {} })
  return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
}

describe("the first screen", () => {
  it("shows the pitch, what the tool does, the other tools and where to go next on --help", async () => {
    const { code, stdout } = await call(["--help"])

    expect(code).toBe(0)
    expect(stdout).toMatchInlineSnapshot(`
      "tg — your personal Telegram for agents and scripts. Reads go to a local store.

      Usage: tg <profile> <command> [options]
      Account commands start with your profile, a name you choose; none is ever assumed.

      What you can do:
        review --since 1d       who owes whom what, across every chat
        search all "invoice"    messages, files and voice notes as text, offline

      Works with:
        max                     MAX in the same local store: search, review and tasks offline
        wa                      WhatsApp in the same local store: search, review and tasks offline
        zm                      Zoom meetings: transcripts and summaries, searchable with your other WireCat data
        drive                   Google Drive and Docs as local text, searchable with your other WireCat data
        memo context <person>   one person across messengers, mail, notes and meetings
        mail                    IMAP mail in the same local store: search your mailbox offline, next to your other WireCat data

      Start here:   tg personal setup  (any profile name works)
                    tg account list    your profiles and their logged-in accounts
      Next:         tg commands        every command, by section
                    tg help options    output, offline, timeouts, dry run
      For agents:   tg skill show      rules and the discovery loop"
    `)
  })

  it("says once that account commands start with the profile, and never lists every command", async () => {
    const { stdout } = await call(["help"])

    expect(stdout.match(/start with your profile/g)).toHaveLength(1)
    expect(stdout).not.toContain("chats list")
    expect(stdout).not.toContain("--offline")
  })

  it("still shows the screen on a bare run in a terminal, on stderr with a usage exit", async () => {
    const { code, stdout, stderr } = await call([], fakeTool, true)

    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toContain("What you can do:")
  })

  it("answers a bare piped run with a JSON error, as before", async () => {
    const { code, stderr } = await call([])

    expect(code).toBe(2)
    expect(JSON.parse(stderr).error.message).toContain("give a command")
  })

  it("leaves out what a tool has not supplied, and the pointers to commands it lacks", async () => {
    const bare: ProgramDefinition = { app, commands: () => [leaf("status", "how it is")] }
    const { stdout } = await call(["--help"], bare)

    expect(stdout).toMatch(/^tg — Telegram for scripts\n/)
    expect(stdout).not.toContain("What you can do")
    expect(stdout).not.toContain("Start here")
    expect(stdout).not.toContain("tg commands")
    expect(stdout).toContain("Next:         tg help options")
  })

  it("prints the options for every command on help options", async () => {
    const { code, stdout } = await call(["help", "options"])

    expect(code).toBe(0)
    expect(stdout).toMatch(/^Options for every tg command:/)
    expect(stdout).toContain("--offline")
    expect(stdout).toContain("--dry-run")
    expect(stdout).not.toContain("--help-all")
  })

  it("keeps the full commander help on --help-all", async () => {
    const { code, stdout } = await call(["--help-all"])

    expect(code).toBe(0)
    expect(stdout).toContain("Usage: tg [profile] [options] <command>")
    expect(stdout).toContain("chats")
    expect(stdout).toContain("--offline")
  })

  it("shows a command's own help on help <command>, and refuses an unknown one", async () => {
    expect((await call(["help", "chats", "list"])).stdout).toContain("chats, newest first")

    const unknown = await call(["help", "nothing"])
    expect(unknown.code).toBe(2)
    expect(JSON.parse(unknown.stderr).error.message).toContain('no command "nothing"')
  })

  it("leaves a subcommand's help and the commands document alone", async () => {
    expect((await call(["chats", "--help"])).stdout).toContain("Usage: tg <profile> chats")

    const { stdout } = await call(["commands", "--json"])
    const document = JSON.parse(stdout)
    expect(document.commands.map((command: { name: string }) => command.name)).not.toContain("help")
    expect(JSON.stringify(document.global_options)).not.toContain("help-all")
  })

  it("keeps a command's own help settings, such as the global options, beside the <profile> usage line", async () => {
    const setup = leaf("setup", "guided first run").configureHelp({ showGlobalOptions: true })
    const { stdout } = await call(["setup", "--help"], { ...fakeTool, commands: () => [setup] })

    expect(stdout).toContain("Usage: tg <profile> setup")
    expect(stdout).toContain("Global Options:")
  })

  it("installs on a program a tool builds itself, without the profile when it has none", async () => {
    const out: string[] = []
    const program = new Command("memo")
      .description("context about people")
      .exitOverride()
      .configureOutput({ writeOut: (text) => out.push(text) })
    program.addCommand(leaf("context", "one person"))
    installHelp(program, { profile: false, can: [{ command: "context Anna", does: "one person, everywhere" }] })

    await expect(program.parseAsync(["--help"], { from: "user" })).rejects.toMatchObject({ exitCode: 0 })
    expect(out.join("")).toContain("Usage: memo <command> [options]")
    expect(out.join("")).not.toContain("profile")
    expect(out.join("")).not.toContain("  memo context <person>")
    expect(out.join("")).toMatch(/memo help options\s+the options every command takes/)
  })

  it("names only the option topics the program has", () => {
    const program = new Command("memo").option("--json [fields]").option("--timeout <seconds>")
    program.addCommand(leaf("context", "one person"))

    expect(firstScreen(program, { profile: false })).toMatch(/memo help options\s+output, timeouts\n/)
  })
})
