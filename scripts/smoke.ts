/**
 * The second runtime, actually executed. A type check proves nothing about a runtime that lacks a
 * module, and `bun test` cannot run the Vitest suite, so this exercises the real exports with
 * plain assertions and runs identically under Node and Bun.
 *
 * Node needs no counterpart: the Vitest suite already runs every one of these paths under Node.
 * This exists because Bun cannot run that suite, and "it works under Bun" is a ruling, not a hope.
 *
 *   bun run scripts/smoke.ts
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import * as v from "valibot"
import { annotate, describeProgram, flatten } from "../src/commands/index.js"
import { suggest } from "../src/completion/index.js"
import { main as cliDev } from "../src/dev/main.js"
import {
  backoffMs,
  CliError,
  Credentials,
  captureStreams,
  createFileLogger,
  createRenderer,
  DEFAULT_RETRY,
  exitCodeFor,
  loadConfigFile,
  memoryKeyring,
  realSleep,
  resolvePaths,
  saveConfigFile,
} from "../src/index.js"
import { setupArguments } from "../src/mcp/index.js"
import { fakeClock } from "../src/testing/index.js"
import { installerOf, isNewer } from "../src/update/index.js"

const ESCAPE = String.fromCharCode(27)
checkMcpImport()
function checkMcpImport() {
  const args = setupArguments("codex", "smoke", { type: "stdio", command: "/bin/node", args: ["mcp"] })
  if (args.join(" ") !== "mcp add smoke -- /bin/node mcp") throw new Error("MCP setup export failed")
}
const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun"
const failures: string[] = []

const check = (what: string, condition: boolean) => {
  if (!condition) failures.push(what)
}

const streams = captureStreams()
const renderer = createRenderer({ format: "json", color: false, streams })
renderer.result({ chats: 2 })
renderer.warn("something worth saying")

check("json output is one value on stdout", streams.stdout.length === 1 && streams.stdout[0] === '{"chats":2}')
check("diagnostics stay off stdout", streams.stderr.length === 1)
check("no ANSI reaches stdout", !streams.stdout.join("").includes(ESCAPE))

const pretty = captureStreams()
createRenderer({ format: "pretty", color: false, streams: pretty }).result([{ id: 1, title: "Family" }])
check("pretty renders a table", pretty.stdout.join("").includes("Family"))

const error = new CliError("rate_limited", "slow down", { retryAfterMs: 1200 })
check("error carries its code", error.code === "rate_limited")
check("exit code is stable", exitCodeFor("cancelled") === 130)

const keyring = memoryKeyring()
keyring.set("cli-core-smoke", "default", "secret")
check("keyring round-trips", keyring.get("cli-core-smoke", "default") === "secret")

const time = fakeClock()
await time.sleep(250, undefined, "retry")
check("fake clock records without waiting", time.waits.length === 1 && time.clock() === 250)

await realSleep(1)

// Loads the native keyring module without touching the real keychain — no entry is read, written
// or constructed. Whether a native addon loads at all is exactly the Bun question worth asking.
const keyringModule = await import("@napi-rs/keyring").then(
  (module) => typeof (module as { Entry?: unknown }).Entry,
  () => "unavailable",
)
check(`native keyring module loads (saw: ${keyringModule})`, keyringModule === "function")

const paths = resolvePaths({ appName: "cli-core-smoke", env: { CLI_CORE_SMOKE_CONFIG_DIR: "/tmp/smoke" } })
check("paths honour the environment override", paths.config === "/tmp/smoke")

const dir = mkdtempSync(join(tmpdir(), "cli-core-smoke-"))
const configPath = join(dir, "config.json")
saveConfigFile(configPath, { version: 1 })
const Schema = v.object({ version: v.literal(1) })
check("config round-trips", loadConfigFile(configPath, Schema, () => ({ version: 1 as const })).version === 1)

const credentials = new Credentials({
  configDir: dir,
  service: "cli-core-smoke",
  keyring: memoryKeyring(),
  env: {},
  warn: () => {},
})
credentials.write("default", "s3cret")
check("credentials round-trip through the keyring seam", credentials.read("default")?.secret === "s3cret")

// Pino is the dependency most likely to behave differently on a second runtime, and redaction is
// the one behaviour that must not silently stop working.
const logPath = join(dir, "events.jsonl")
const logger = createFileLogger({ path: logPath })
logger.info({ event: "smoke", token: "t0ken", nested: { password: "hunter2" } })
await logger.close()
const logged = readFileSync(logPath, "utf8")
check("the log file is written", logged.includes("smoke"))
check("secrets are redacted in the log", !logged.includes("t0ken") && !logged.includes("hunter2"))

check("backoff stays under its ceiling", backoffMs(3, DEFAULT_RETRY, () => 1) <= DEFAULT_RETRY.maxDelayMs)

const aborted = await realSleep(10_000, AbortSignal.abort()).then(
  () => "resolved",
  (reason: unknown) => (reason as Error).name,
)
check("an aborted sleep rejects with AbortError", aborted === "AbortError")

const tool = new Command("tool")
annotate(tool.command("send").argument("<chat>"), { mutates: true })
const described = flatten(describeProgram(tool))
check(
  "the registry sees a command and its label",
  described[0]?.usage === "tool send <chat>" && described[0]?.mutates === true,
)

check("completion suggests a command", suggest({ commands: describeProgram(tool), words: ["se"] })[0]?.value === "send")

check(
  "update reads an installer and compares versions",
  installerOf("/x/lib/node_modules/p/dist/bin/p.js") === "npm" && isNewer("0.10.0", "0.9.0"),
)

const dev: string[] = []
check(
  "cli-dev picks the next free version",
  (await cliDev(["next-version", "1.2.0", "1.2.0", '["1.2.0"]'], {
    cwd: ".",
    out: (t) => dev.push(t),
    err: () => {},
  })) === 0 && dev[0] === "1.3.0",
)

if (failures.length > 0) {
  console.error(`cli-core smoke FAILED under ${runtime}:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`cli-core smoke passed under ${runtime}`)
