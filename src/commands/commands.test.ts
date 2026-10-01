import { Command, Option } from "commander"
import { describe, expect, it } from "vitest"
import {
  annotate,
  COMMANDS_PAGE_LABELS,
  commandsPage,
  describeOptions,
  describeProgram,
  flatten,
  metaOf,
} from "./index.js"

const program = (): Command => {
  const root = new Command("tool").description("a tool").option("--json", "print JSON")

  const messages = root.command("messages").description("messages in a chat")
  messages
    .command("list")
    .summary("list messages")
    .description("list the messages of one chat")
    .argument("<chat>", "chat id or name")
    .option("--limit <n>", "how many", "20")
    .addOption(new Option("--sort <order>", "order").choices(["new", "old"]))
    .addOption(new Option("--token <token>", "who you are").env("TOOL_TOKEN").makeOptionMandatory())
    .addOption(new Option("--offline", "read the cache only").conflicts("online"))
    .addOption(new Option("--online", "always ask the server").implies({ refresh: true }))
    .addOption(new Option("--debug-wire", "dump frames").hideHelp())
  annotate(messages.command("send").argument("<chat>").argument("[text...]"), {
    mutates: true,
    examples: ["tool messages send 42 hello"],
  })

  const catalog = root.command("campaigns").description("generated from the catalog")
  for (const id of ["campaigns.list", "campaigns.details"]) {
    annotate(catalog.command(id.split(".")[1] as string), { origin: "generated", operationId: id })
  }

  annotate(root.command("legacy"), { state: "deprecated" })
  return root
}

describe("describeProgram", () => {
  it("lists every command, nested, with the argv path already split", () => {
    const paths = flatten(describeProgram(program())).map(({ path }) => path.join(" "))
    expect(paths).toEqual([
      "messages",
      "messages list",
      "messages send",
      "campaigns",
      "campaigns list",
      "campaigns details",
      "legacy",
    ])
  })

  it("shows a command built in a loop exactly like a handwritten one, and says where each came from", () => {
    const commands = flatten(describeProgram(program()))
    const list = commands.find(({ path }) => path.join(" ") === "campaigns list")
    const handwritten = commands.find(({ path }) => path.join(" ") === "messages list")

    expect(list).toMatchObject({ origin: "generated", operationId: "campaigns.list", usage: "tool campaigns list" })
    expect(handwritten?.origin).toBe("handwritten")
    expect(handwritten).not.toHaveProperty("operationId")
  })

  it("builds the usage line from the arguments", () => {
    const send = flatten(describeProgram(program())).find(({ name }) => name === "send")
    expect(send?.usage).toBe("tool messages send <chat> [text]")
    expect(send?.arguments.map(({ name, variadic }) => [name, variadic])).toEqual([
      ["chat", false],
      ["text", true],
    ])
  })

  it("carries the labels: mutates, state, examples, summary", () => {
    const commands = flatten(describeProgram(program()))
    const byName = (name: string) => commands.find((command) => command.name === name)

    expect(byName("send")).toMatchObject({ mutates: true, examples: ["tool messages send 42 hello"] })
    expect(byName("legacy")?.state).toBe("deprecated")
    expect(byName("list")?.summary).toBe("list messages")
    expect(byName("list")).not.toHaveProperty("mutates")
  })
})

describe("options", () => {
  const options = () => {
    const list = flatten(describeProgram(program())).find(({ path }) => path.join(" ") === "messages list")
    return new Map(list?.options.map((option) => [option.flags.split(" ")[0], option]))
  }

  it("says which options take a value, and separately which must be given", () => {
    expect(options().get("--limit")).toMatchObject({ takesValue: true, mandatory: false, default: "20" })
    expect(options().get("--token")).toMatchObject({ takesValue: true, mandatory: true, env: "TOOL_TOKEN" })
    expect(options().get("--offline")).toMatchObject({ takesValue: false, mandatory: false })
  })

  it("carries choices, conflicts and implied values", () => {
    expect(options().get("--sort")?.choices).toEqual(["new", "old"])
    expect(options().get("--offline")?.conflicts).toEqual(["online"])
    expect(options().get("--online")?.implies).toEqual({ refresh: true })
  })

  it("leaves hidden options out", () => {
    expect(options().has("--debug-wire")).toBe(false)
  })

  it("describes the global options of the root", () => {
    expect(describeOptions(program()).map(({ flags }) => flags)).toEqual(["--json"])
  })
})

describe("annotate", () => {
  it("merges repeated labels and returns the command for chaining", () => {
    const command = new Command("x")
    expect(annotate(command, { mutates: true })).toBe(command)
    annotate(command, { state: "beta" })
    expect(metaOf(command)).toEqual({ mutates: true, state: "beta" })
  })

  it("answers an empty label for a command nobody annotated", () => {
    expect(metaOf(new Command("y"))).toEqual({})
  })
})

describe("hidden commands", () => {
  it("are not in the registry", () => {
    const root = new Command("tool")
    root.command("shown")
    root.addCommand(new Command("secret"), { hidden: true })
    expect(describeProgram(root).map(({ name }) => name)).toEqual(["shown"])
  })
})

describe("commandsPage", () => {
  const page = () =>
    commandsPage({
      cli: "tool",
      commands: describeProgram(program()),
      options: describeOptions(program()),
      labels: COMMANDS_PAGE_LABELS.en,
      text: {
        banner: "<!-- generated -->",
        title: "Commands",
        intro: "Every command.",
        globalHeading: "Global options",
        globalIntro: "On any command.",
        mutates: "**Changes something.**",
        exitHeading: "Exit codes",
        exitIntro: "Branch on the code.",
        outro: "",
      },
    })

  it("writes every command at its depth, with usage, arguments, options and defaults", () => {
    const text = page()
    expect(text.startsWith("<!-- generated -->\n\n# Commands\n\nEvery command.\n\n## Global options")).toBe(true)
    expect(text).toContain("| `--json` | print JSON. |")
    expect(text).toContain(
      "### `tool messages list`\n\nlist the messages of one chat\n\n```sh\ntool messages list <chat> [options]\n```",
    )
    expect(text).toContain("| `chat` | required | chat id or name. |")
    expect(text).toContain("| `--limit <n>` | how many. Default: `20`. |")
    expect(text).toContain("### `tool messages send`\n\n\n\n**Changes something.**")
    expect(text).not.toContain("--debug-wire")
    expect(text.endsWith("| `1` | anything else |\n")).toBe(true)
  })

  it("keeps a pipe or a tilde from breaking its row, and lists the allowed values", () => {
    expect(page()).toContain("| `--sort <order>` | order. One of: `new`, `old`. |")
    const piped = commandsPage({
      cli: "t",
      commands: [],
      options: [{ flags: "--order <recent|name>", description: "a|b ~~x~~", takesValue: true, mandatory: false }],
      labels: COMMANDS_PAGE_LABELS.ru,
      text: {
        banner: "",
        title: "Команды",
        intro: "",
        globalHeading: "Общие опции",
        globalIntro: "",
        mutates: "",
        exitHeading: "Коды",
        exitIntro: "",
        outro: "",
      },
    })
    expect(piped).toContain("| `--order <recent\\|name>` | a\\|b \\~\\~x\\~\\~. |")
    expect(piped).toContain("| `0` | получилось |")
  })
})
