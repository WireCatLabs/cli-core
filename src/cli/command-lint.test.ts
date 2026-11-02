import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { expect, it } from "vitest"
import { ENTITIES } from "../entities/index.js"
import { sharedProgram } from "../testing/shared-program.js"
import { commandPathOf } from "./command-contract.js"
import { createProgram, run } from "./program.js"

// Every CLI runs `cli-dev lint` on its tree, and a shared command's violation lands in all of them at once.
it("the shared commands pass the command lint, apart from the baseline", async () => {
  const streams = captureStreams()
  expect(await run(["commands", "--json"], sharedProgram, { streams, tty: false, env: {} })).toBe(0)
  const document = join(mkdtempSync(join(tmpdir(), "command-lint-")), "commands.json")
  writeFileSync(document, streams.stdout.join(""))

  const lint = spawnSync("node_modules/.bin/cli-dev", ["lint", "--commands", document], { encoding: "utf8" })

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
