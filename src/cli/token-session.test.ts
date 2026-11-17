import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { afterEach, expect, it } from "vitest"
import { accountFileFor } from "./messenger/accounts.js"
import { run } from "./program.js"
import { settingsFor } from "./settings.js"
import { type TokenSessionOptions, tokenSessionCommand } from "./token-session.js"

const app = { command: "pages", appName: "pages-cli", envPrefix: "PAGES", description: "synthetic", version: "1.0.0" }
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "token-session-"))
  roots.push(root)
  mkdirSync(join(root, "config"), { recursive: true })
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
    PAGES_STATE_DIR: join(root, "state"),
    PAGES_CONFIG_DIR: join(root, "config"),
    PAGES_CACHE_DIR: join(root, "cache"),
  }
  const keyring = memoryKeyring()
  const checked: string[] = []
  const cli = async (argv: string[], stdin?: string, claim?: TokenSessionOptions["claim"]) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      {
        app,
        commands: () => [
          tokenSessionCommand({
            app,
            service: "Pages",
            resolveSettings: settingsFor(app).resolveSettings,
            ...(claim ? { claim } : {}),
            verify: async (_command, token) => {
              checked.push(token)
              if (token !== "good-token") throw new CliError("authentication_error", "Pages refused the token")
              return { id: "workspace-1", account: { user: { id: "u1", name: "Synthetic" } } }
            },
          }),
        ],
      },
      { streams, tty: false, env, keyring, ...(stdin === undefined ? {} : { stdin: Readable.from([stdin]) }) },
    )
    const out = streams.stdout.join("")
    const err = streams.stderr.join("")
    return {
      code,
      json: out ? JSON.parse(out) : undefined,
      error: err.startsWith("{") ? JSON.parse(err).error : undefined,
    }
  }
  return { env, cli, checked }
}

it("session start checks the token before keeping it; status, list and end", async () => {
  const { env, cli, checked } = setup()
  const started = await cli(["personal", "session", "start", "--json"], "good-token\n")
  expect(started.json.item).toMatchObject({ profile: "personal", state: "saved", verified: true, user: { id: "u1" } })
  expect(JSON.stringify(started.json)).not.toContain("good-token")
  expect(JSON.parse(readFileSync(accountFileFor(app, "personal", env), "utf8"))).toEqual({ account: "workspace-1" })

  expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({
    state: "saved",
    verified: false,
  })
  const status = await cli(["personal", "session", "status", "--check", "--json"])
  expect(status.json.item).toMatchObject({ state: "saved", verified: true, user: { name: "Synthetic" } })
  expect(checked).toEqual(["good-token", "good-token"])

  expect((await cli(["session", "list", "--json"])).json.items).toContainEqual(
    expect.objectContaining({ profile: "personal", signed_in: true }),
  )
  expect((await cli(["personal", "session", "end", "--json"])).code).toBe(0)
  expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "missing" })
})

it("session start keeps nothing when the service refuses the token, or when none is given", async () => {
  const { cli } = setup()
  const refused = await cli(["personal", "session", "start", "--json"], "wrong-token\n")
  expect(refused.error).toMatchObject({ code: "authentication_error" })
  expect((await cli(["personal", "session", "status", "--json"])).json.item).toMatchObject({ state: "missing" })
  const empty = await cli(["personal", "session", "start", "--json"], "\n")
  expect(empty.error).toMatchObject({ code: "validation_error" })
  const storage = await cli(["personal", "session", "start", "--credential-storage", "vault", "--json"], "good-token\n")
  expect(storage.error).toMatchObject({ code: "validation_error" })
})

it("session start refuses --offline and a taken account before keeping anything", async () => {
  const { cli, checked } = setup()
  const offline = await cli(["--offline", "personal", "session", "start", "--json"], "good-token\n")
  expect(offline.error).toMatchObject({ code: "permission_error" })
  expect(checked).toEqual([])
  const taken = await cli(["work", "session", "start", "--json"], "good-token\n", () => {
    throw new CliError("conflict", "profile personal already uses this account")
  })
  expect(taken.error).toMatchObject({ code: "conflict" })
  expect((await cli(["work", "session", "status", "--json"])).json.item).toMatchObject({ state: "missing" })
})

it("session status --check checks a token from the environment variable, and never prints it", async () => {
  const { env, cli, checked } = setup()
  env.PAGES_TOKEN = "good-token"
  const status = await cli(["personal", "session", "status", "--check", "--json"])
  expect(status.json.item).toMatchObject({ state: "saved", token_from: "environment", verified: true })
  expect(checked).toEqual(["good-token"])
  expect(JSON.stringify(status.json)).not.toContain("good-token")
})
