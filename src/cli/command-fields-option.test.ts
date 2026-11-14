import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import type { AppIdentity } from "../ports/app.js"
import { baseContext, outputFor } from "./context.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { type ProgramDefinition, run } from "./program.js"
import { settingsFor } from "./settings.js"

const app: AppIdentity = {
  command: "masked",
  appName: "masked-cli",
  envPrefix: "MASKED",
  description: "synthetic",
  version: "1.0.0",
  messenger: false,
}

const MASK = "items(id,organizer/self)"

const env = () => {
  const home = mkdtempSync(join(tmpdir(), "fields-option-"))
  return {
    HOME: home,
    XDG_DATA_HOME: home,
    XDG_STATE_HOME: home,
    WIRECAT_STATE_DIR: home,
    MESSAGING_STORE: join(home, "store.db"),
    MASKED_CONFIG_DIR: join(home, "config"),
  }
}

const program = (seen: (string | undefined)[], render: "outputFor" | "baseContext"): ProgramDefinition => {
  const configuration = settingsFor(app)
  return {
    app,
    configuration,
    commands: () => [
      new Command("call").option("--fields <mask>", "the provider's partial-response mask").action(function (
        this: Command,
        options: { fields?: string },
      ) {
        seen.push(options.fields)
        const output = render === "outputFor" ? outputFor(this) : baseContext(this, configuration.resolveSettings)
        renderAnswer(this, output, itemOf({ id: "evt-1", mask: options.fields ?? null }))
      }),
    ],
  }
}

const answer = async (argv: string[], render: "outputFor" | "baseContext") => {
  const seen: (string | undefined)[] = []
  const streams = captureStreams()
  const code = await run(argv, program(seen, render), { streams, env: env(), tty: false })
  return { code, seen, out: streams.stdout.join(""), err: streams.stderr.join("") }
}

// BUG-755: a generated Google command's --fields was read as --json's field list and refused.
describe("a command's own --fields under --json", () => {
  for (const render of ["outputFor", "baseContext"] as const)
    it(`**stays the command's, and --json prints the whole answer** (${render})`, async () => {
      const { code, seen, out, err } = await answer(["work", "call", "--fields", MASK, "--json"], render)

      expect(err).toBe("")
      expect(code).toBe(0)
      expect(seen).toEqual([MASK])
      expect(JSON.parse(out).item).toEqual({ id: "evt-1", mask: MASK })
    })

  it("**--json=id still picks the answer's fields** beside the command's own --fields", async () => {
    const { code, seen, out } = await answer(["work", "call", "--fields", MASK, "--json=id"], "outputFor")

    expect(code).toBe(0)
    expect(seen).toEqual([MASK])
    expect(JSON.parse(out).item).toEqual({ id: "evt-1" })
  })
})
