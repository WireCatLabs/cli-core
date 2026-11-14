import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { expect, it } from "vitest"
import { ENTITIES } from "../entities/index.js"
import { sharedProgram } from "../testing/shared-program.js"
import { addCallStatsCommand } from "./call-stats-command.js"
import { commandPathOf } from "./command-contract.js"
import { commandsCommand } from "./commands-command.js"
import { addMeetingCombinedSearchCommand, addMeetingEmbeddingCommand } from "./meeting-meaning-command.js"
import { addMeetingTagsCommand } from "./meeting-tags-command.js"
import { createProgram, type ProgramDefinition, run } from "./program.js"
import { runsCommand } from "./runs/command.js"

/** `cli-dev lint` over a program's `commands --json`, with no overrides. */
const lintOf = async (definition: ProgramDefinition, ...more: string[]) => {
  const streams = captureStreams()
  expect(await run(["commands", "--json"], definition, { streams, tty: false, env: {} })).toBe(0)
  const folder = mkdtempSync(join(tmpdir(), "command-lint-"))
  const document = join(folder, "commands.json")
  writeFileSync(document, streams.stdout.join(""))
  const noOverrides = join(folder, "overrides.json")
  writeFileSync(noOverrides, "[]")
  return spawnSync("node_modules/.bin/cli-dev", ["lint", "--commands", document, "--overrides", noOverrides, ...more], {
    encoding: "utf8",
  })
}

// Every CLI runs `cli-dev lint` on its tree, and a shared command's violation lands in all of them at once. An override
// here would hide it from this repository alone, so a new word goes into cli-base's vocabulary first.
it("the shared commands pass the command lint with no overrides, apart from the baseline", async () => {
  const lint = await lintOf(sharedProgram)

  expect(`${lint.stdout}${lint.stderr}`).toMatch(/lint: ok/)
  expect(lint.status).toBe(0)
})

// pbx and beeline mount these over their calls, zoom the search; a messenger never does, so the shared program above leaves them out.
it("a calls host's shared commands pass the command lint with no overrides", async () => {
  const refuse = async (): Promise<never> => {
    throw new Error("not read in a lint")
  }
  const app = { command: "pbx", appName: "pbx-cli", envPrefix: "PBX", description: "synthetic", version: "1.0.0" }
  const lint = await lintOf(
    {
      app,
      commands: () => {
        const holder = new Command("pbx").addCommand(commandsCommand(app))
        addCallStatsCommand(holder, { read: refuse, examples: ["pbx office stats calls show --since-time 30d --json"] })
        holder.command("meetings").description("stored calls")
        addMeetingCombinedSearchCommand(holder, {
          words: refuse,
          meaning: refuse,
          signal: () => undefined,
          pagingOf: () => ({ limit: 100 }),
          output: () => undefined,
          examples: ['pbx office search meetings "what did they say about the refund" --model e5-small --json'],
        })
        addMeetingEmbeddingCommand(holder, {
          meaning: refuse,
          defaultModel: () => "e5-small",
          signal: () => undefined,
          output: () => undefined,
          examples: ["pbx office meetings embed --yes --json"],
        })
        addMeetingTagsCommand(holder, {
          read: refuse,
          examples: {
            add: ['pbx office tags add complaint --matching "refund OR complaint" --json'],
            remove: ["pbx office tags remove complaint --meeting 12 --json"],
            list: ["pbx office tags list tag:complaint --json"],
          },
        })
        return [...holder.commands, runsCommand(app)]
      },
    },
    // The baseline is the messenger program's: here its entries are stale, and only a new violation fails.
    "--allow-stale",
  )

  expect(`${lint.stdout}${lint.stderr}`).toMatch(/lint: ok/)
  expect(lint.status).toBe(0)
})

it("every declared output of a shared command names an entity cli-core has", () => {
  const all = (command: Command): Command[] => [command, ...command.commands.flatMap(all)]
  const unknown = all(createProgram(sharedProgram)).flatMap((command) => {
    const output = metaOf(command).output
    const name = output && (output.view ? `${output.entity}.${output.view}` : output.entity)
    return name === undefined || name in ENTITIES ? [] : [`${commandPathOf(command).join(" ")}: ${name}`]
  })

  expect(unknown).toEqual([])
})

// commander reads `-1001` as an option once any command defines a digit short option, and every negative chat id breaks.
it("no shared command defines a digit short option", () => {
  const all = (command: Command): Command[] => [command, ...command.commands.flatMap(all)]
  const digits = all(createProgram(sharedProgram)).flatMap((command) =>
    command.options.filter((option) => /^-\d$/.test(option.short ?? "")).map((option) => option.flags),
  )

  expect(digits).toEqual([])
})
