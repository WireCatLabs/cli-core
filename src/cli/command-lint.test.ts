import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { expect, it } from "vitest"
import { sharedProgram } from "../testing/shared-program.js"
import { run } from "./program.js"

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
