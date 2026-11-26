import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { ENTITIES } from "../../entities/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { messengerSessionCommands } from "../shared-command-exports.js"
import { accountCommand } from "./account-command.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "session-"))
  return {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

const owner = { id: "500", name: "Owner", username: "owner", phone: "+34600000000" }
const adapter = (me: () => Promise<typeof owner>) =>
  ({ self: () => "500", me, close: async () => {} }) as unknown as MessengerAdapter

const call = async (argv: string[], env: NodeJS.ProcessEnv, me: () => Promise<typeof owner>, own = {}) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => adapter(me),
    chatArgument: "a chat",
    ...own,
  }
  const streams = captureStreams()
  const session = new Command("session").addCommand(new Command("start").action(() => {}))
  for (const command of messengerSessionCommands(messenger)) session.addCommand(command)
  const code = await run(
    argv,
    { app, commands: () => [session, accountCommand(messenger)] },
    { streams, tty: false, env },
  )
  const body = code === 0 ? JSON.parse(streams.stdout[0] ?? "null") : undefined
  return { code, body: body?.item ?? body, stderr: streams.stderr.join("\n") }
}

const asked = async () => owner
const never = async (): Promise<typeof owner> => {
  throw new Error("must not ask the messenger")
}

describe("messenger session status and list", () => {
  it("**lists the profiles with no profile named**, asking the messenger nothing", async () => {
    const env = sandbox()
    await call(["work", "account", "show", "--json"], env, asked)
    rememberAccount(app, "work", "500", env)
    rememberAccount(app, "old", "502", env)

    const listed = await call(["session", "list", "--json"], env, never, {
      profileState: (profile: string) => (profile === "old" ? "signed-out" : "signed-in"),
    })

    expect(listed.code).toBe(0)
    expect(listed.body.items).toEqual([
      { profile: "old", current: false, account: "502", name: null, signed_in: false },
      { profile: "work", current: false, account: "500", name: "Owner", signed_in: true },
    ])
    expect((await call(["account", "list", "--json"], env, never)).code).not.toBe(0)
    for (const item of listed.body.items) expect(v.safeParse(ENTITIES.account_profile, item).success).toBe(true)
  })

  it("**says whether a profile is logged in, and as whom**, from this computer alone", async () => {
    const env = sandbox()
    await call(["work", "account", "show", "--json"], env, asked)
    rememberAccount(app, "work", "500", env)

    const work = await call(["work", "session", "status", "--json"], env, never)
    const fresh = await call(["fresh", "session", "status", "--check", "--json"], env, never)

    expect(work.body).toEqual({ profile: "work", signed_in: true, account: "500", name: "Owner", verified: false })
    expect(fresh.body).toEqual({ profile: "fresh", signed_in: false, account: null, name: null, verified: false })
  })

  it("**asks the messenger with --check**, and leaves the phone number out", async () => {
    const env = sandbox()
    rememberAccount(app, "work", "500", env)

    const checked = await call(["work", "session", "status", "--check", "--json"], env, asked)

    expect(checked.body).toEqual({
      profile: "work",
      signed_in: true,
      account: "500",
      provider: "chat",
      name: "Owner",
      username: "owner",
      verified: true,
    })
  })

  it("**needs a profile for status**, and says which to name", async () => {
    const env = sandbox()
    rememberAccount(app, "work", "500", env)

    const unnamed = await call(["session", "status", "--json"], env, never)

    expect(unnamed.code).toBe(2)
    expect(unnamed.stderr).toContain("profiles here: work")
  })
})
