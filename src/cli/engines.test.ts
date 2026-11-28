import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { engineFolder, engineRequire } from "../engines/install.js"
import type { AppIdentity } from "../ports/app.js"
import type { Fetch } from "../speech/install.js"
import { fakeRegistry, fixtureEngine, packageFiles } from "../testing/engine-fixtures.js"
import { outputFor } from "./context.js"
import { engineFor } from "./engines.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { type ProgramDefinition, run } from "./program.js"
import { settingsFor } from "./settings.js"

const app: AppIdentity = {
  command: "hearer",
  appName: "hearer-cli",
  envPrefix: "HEARER",
  description: "synthetic",
  version: "1.0.0",
  messenger: false,
}

const { pin, bodies } = fixtureEngine("https://registry.test", "voice-engine", "1.0.0", [
  { name: "voice-engine", version: "1.0.0", files: packageFiles("voice-engine", "1.0.0", "heard") },
])

/** A command that does part of its work with no engine, then needs one for the rest, as `transcribe` will. */
const program = (): ProgramDefinition => ({
  app,
  configuration: settingsFor(app),
  commands: () => [
    new Command("hear").action(async function (this: Command) {
      const state = await engineFor(this, pin, "hearer speech install")
      const heard = state.status === "ready" ? engineRequire(state.folder)("voice-engine").answer : null
      renderAnswer(this, outputFor(this), itemOf({ counted: 3, heard, engine: state }))
    }),
  ],
})

const env = () => {
  const home = mkdtempSync(join(tmpdir(), "engine-command-"))
  return { HOME: home, WIRECAT_STATE_DIR: home, HEARER_CONFIG_DIR: join(home, "config") }
}

const hear = async (argv: string[], fetch: Fetch, extra: Record<string, unknown> = {}) => {
  const streams = captureStreams()
  const environment = env()
  const code = await run(["hear", ...argv], program(), { streams, env: environment, tty: true, fetch, ...extra })
  return { code, out: streams.stdout.join(""), err: streams.stderr.join(""), environment }
}

describe("a command that needs an engine", () => {
  it("**installs it with no question and goes on; a person at a terminal sees progress, on stderr only**", async () => {
    const { code, out, err, environment } = await hear([], fakeRegistry(bodies).fetch)

    expect(code).toBe(0)
    expect(err).toContain("installing voice-engine 1.0.0")
    expect(out).toContain("heard")
    expect(out).not.toContain("installing")
    expect(existsSync(engineFolder(pin, environment))).toBe(true)
  })

  it("**under --json, stdout is one JSON value and nothing else is printed**", async () => {
    const { code, out, err } = await hear(["--json"], fakeRegistry(bodies).fetch)

    expect(code).toBe(0)
    expect(err).toBe("")
    expect(JSON.parse(out).item).toMatchObject({
      counted: 3,
      heard: "heard",
      engine: { status: "ready", installed: true },
    })
  })

  it("**an MCP call gets the answer and nothing extra**", async () => {
    let result: unknown
    const { code, out, err } = await hear([], fakeRegistry(bodies).fetch, {
      tty: false,
      agent: {
        result: (value: unknown) => {
          result = value
        },
        failure: () => {},
      },
    })

    expect(code).toBe(0)
    expect(err).toBe("")
    expect(out).toBe("")
    expect(result).toMatchObject({ item: { heard: "heard", engine: { status: "ready", installed: true } } })
  })

  it("**offline: engine-missing with the exact command to retry, and the rest of the command still runs**", async () => {
    const offline: Fetch = async () => {
      throw new TypeError("fetch failed")
    }
    const { code, out, err } = await hear(["--json"], offline)

    expect(code).toBe(0)
    expect(err).toBe("")
    expect(JSON.parse(out).item).toEqual({
      counted: 3,
      heard: null,
      engine: {
        status: "engine-missing",
        engine: "voice-engine",
        version: "1.0.0",
        reason: "fetch failed",
        retry: "hearer speech install",
      },
    })
  })
})
