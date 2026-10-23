import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { commandsCommand } from "../commands-command.js"
import { createProgram, type ProgramDefinition, run } from "../program.js"
import { commandHelpMarkdown, exampleReport, nextUsually } from "./command-help.js"

const app = { command: "tg", appName: "tg-cli", envPrefix: "TG", description: "Telegram", version: "1.0.0" }
const READ = { remote: "read", local: "read" } as const
const WRITE = { remote: "write", local: "write" } as const

const tool: ProgramDefinition = {
  app,
  commands: () => [
    commandsCommand(app),
    new Command("messages")
      .addCommand(
        annotate(new Command("list"), {
          effects: READ,
          output: { entity: "message" },
          query: { entity: "message", backend: "sql", fields: [] },
        })
          .description("a chat's messages")
          .argument("<chat>")
          .argument("[query...]")
          .action(() => {}),
      )
      .addCommand(
        annotate(new Command("send"), { effects: WRITE })
          .description("send a message")
          .argument("<chat>")
          .argument("[text]")
          .action(() => {}),
      )
      .addCommand(
        annotate(new Command("link"), { effects: READ, examples: ["tg messages link Team 1234"] })
          .description("a message's permalink")
          .argument("<chat>")
          .argument("<message>")
          .action(() => {}),
      )
      .addCommand(
        annotate(new Command("delete"), { effects: WRITE })
          .description("delete a message")
          .argument("<chat>")
          .argument("<message>")
          .action(() => {}),
      ),
    new Command("search").addCommand(
      annotate(new Command("messages"), { effects: READ, output: { entity: "message", view: "hit" } })
        .description("search messages")
        .argument("[query...]")
        .requiredOption("--since <duration>", "from when")
        .action(() => {}),
    ),
  ],
}

const help = async (argv: string[]) => {
  const streams = captureStreams()
  const code = await run([...argv, "--help"], tool, { streams, tty: false, env: {} })
  return { code, stdout: streams.stdout.join("\n") }
}

describe("generated command help", () => {
  it("adds Returns from the output schema, Next from argument types and a generated Example", async () => {
    const { code, stdout } = await help(["messages", "list"])

    expect(code).toBe(0)
    expect(stdout.slice(stdout.indexOf("Returns:"))).toMatchInlineSnapshot(`
      "Returns:       message — ref, id, chat_id, sender_id, sender_name, timestamp, edited_at, text, and 29 more; every field: tg commands info messages list
      Next usually:  tg messages link <chat> <message>
                     tg messages delete <chat> <message>
      Example:       tg personal messages list Team
      "
    `)
  })

  it("takes the definition's example, and falls back to the description without an output schema", async () => {
    const link = (await help(["messages", "link"])).stdout
    expect(link).toContain("Example:       tg personal messages link Team 1234")
    expect(link).toContain("Returns:       a message's permalink")

    expect((await help(["messages", "send"])).stdout).toContain(
      'Example:       tg personal messages send Team "on my way"',
    )
  })

  it("puts search text and mandatory options into a generated example", async () => {
    expect((await help(["search", "messages"])).stdout).toContain(
      'Example:       tg personal search messages "invoice" --since 1d',
    )
  })

  it("names no profile in the example of a command that reads none", async () => {
    expect((await help(["commands", "info"])).stdout).toMatch(/Example: +tg commands info/)
  })

  it("keeps the profile a written example already names", () => {
    const program = createProgram({
      ...tool,
      configure: (root) => {
        const link = root.commands.find((one) => one.name() === "messages")?.commands[2]
        if (link) annotate(link, { examples: ["tg personal messages link Team 1234"] })
      },
    })

    expect(commandHelpMarkdown(program, ["messages", "link"])).toContain(
      "**Example:** `tg personal messages link Team 1234`",
    )
  })

  it("lets a definition pin and drop what comes next", async () => {
    const pinned: ProgramDefinition = {
      ...tool,
      configure: (program) => {
        const list = program.commands.find((one) => one.name() === "messages")?.commands[0]
        if (list) nextUsually(list, { pin: ["messages delete"], drop: ["messages link"] })
      },
    }
    const streams = captureStreams()
    await run(["messages", "list", "--help"], pinned, { streams, tty: false, env: {} })
    const stdout = streams.stdout.join("\n")

    expect(stdout).toContain("Next usually:  tg messages delete <chat> <message>")
    expect(stdout).not.toContain("tg messages link <chat>")
  })

  it("renders the same three as Markdown for docs/commands.md", () => {
    expect(commandHelpMarkdown(createProgram(tool), ["messages", "list"])).toEqual([
      "**Returns:** message — ref, id, chat_id, sender_id, sender_name, timestamp, edited_at, text, and 29 more; every field: tg commands info messages list",
      "**Next usually:** `tg messages link <chat> <message>`, `tg messages delete <chat> <message>`",
      "**Example:** `tg personal messages list Team`",
    ])
    expect(commandHelpMarkdown(createProgram(tool), ["messages"])).toEqual([])
  })

  it("reports the commands still on a generated example", () => {
    const report = exampleReport(createProgram(tool))

    expect(report.written).toEqual(["commands info", "messages link"])
    expect(report.generated).toEqual(["messages list", "messages send", "messages delete", "search messages"])
    expect(report.text).toMatch(/^tg: 2 of 6 commands have a written example; 4 show a generated one:/)
  })
})
