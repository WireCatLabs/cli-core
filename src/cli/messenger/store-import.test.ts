import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { ENTITIES } from "../../entities/index.js"
import { contractSeed } from "../../kit/seed.js"
import { openCache } from "../../store/open.js"
import { inOwnerFolder, wirecatDirectory } from "../../store/path.js"
import { openStore } from "../../store/store.js"
import { configCommand } from "../config-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountFileFor } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("store import never connects")
  },
  chatArgument: "a chat",
}

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "store-import-"))
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  return { root, env }
}

const call = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [storeCommand(messenger), configCommand(app, settingsFor(app))] },
    { streams, tty: false, env },
  )
  const body = JSON.parse(streams.stdout[0] ?? "null")
  if (code === 0 && argv.includes("import")) v.parse(ENTITIES.store_import as v.GenericSchema, body.item)
  const stderr = streams.stderr.join("")
  const refusal = code === 0 ? "" : (JSON.parse(stderr) as { error: { message: string } }).error.message
  return { code, body, stderr, refusal }
}

const seedFile = (root: string, change: (file: Record<string, unknown>) => void = () => {}) => {
  const { account, people, chats, members, messages } = contractSeed()
  const file: Record<string, unknown> = { synthetic: true, account, people, chats, members, messages }
  change(file)
  const path = join(root, `seed-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, JSON.stringify(file))
  return path
}

const withProfile = async (env: NodeJS.ProcessEnv) => {
  expect((await call(["personal", "config", "set", "limit", "5", "--json"], env)).code).toBe(0)
}

const rows = async (env: NodeJS.ProcessEnv) => {
  const database = await openCache(String(env.MESSAGING_STORE))
  try {
    const count = (table: string) => Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)
    return { chats: count("chats"), messages: count("messages"), revisions: count("message_revisions") }
  } finally {
    database.close()
  }
}

describe("store import", () => {
  it("loads the seed into the profile's account, as a sync saves it, and remembers the account", async () => {
    const { root, env } = sandbox()
    await withProfile(env)
    const seed = contractSeed()
    const imported = await call(["personal", "store", "import", seedFile(root), "--yes", "--json"], env)

    expect(imported.code, imported.stderr).toBe(0)
    expect(imported.body.item).toMatchObject({
      imported: true,
      account: "person-1",
      file: { chats: 4, messages: seed.messages.length },
      added: { chats: 4, messages: seed.messages.length },
    })
    expect(JSON.parse(readFileSync(accountFileFor(app, "personal", env), "utf8"))).toEqual({ account: "person-1" })
    const store = await openStore({ env, command: "chat" })
    try {
      const key = { provider: "chat", account: "person-1" }
      const busy = (await store.chats.chatStats(key)).find((chat) => chat.chatId === seed.busy)
      expect(busy).toMatchObject({ title: "Book club", messages: 10 })
      expect((await store.roster.members(key, seed.dialog)).map((one) => one.name)).toEqual(
        expect.arrayContaining(["Owner", "Ann Lee"]),
      )
      expect(await store.accounts.profiles()).toMatchObject({ chat: { personal: key } })
    } finally {
      await store.close()
    }
  })

  it("adds nothing the second time, and updates a changed message in place", async () => {
    const { root, env } = sandbox()
    await withProfile(env)
    const file = seedFile(root)
    await call(["personal", "store", "import", file, "--yes", "--json"], env)
    const first = await rows(env)

    const again = await call(["personal", "store", "import", file, "--yes", "--json"], env)
    expect(again.body.item.added).toEqual({ chats: 0, messages: 0 })
    expect(await rows(env)).toEqual(first)

    const changed = seedFile(root, (seed) => {
      const [message] = seed.messages as { text: string }[]
      if (message) message.text = "hello again"
    })
    await call(["personal", "store", "import", changed, "--yes", "--json"], env)
    expect(await rows(env)).toEqual({ ...first, revisions: first.revisions + 1 })
  })

  it("without --yes says what it would load and writes nothing", async () => {
    const { root, env } = sandbox()
    await withProfile(env)
    const preview = await call(["personal", "store", "import", seedFile(root), "--json"], env)

    expect(preview.code, preview.stderr).toBe(0)
    expect(preview.body.item).toMatchObject({ imported: false, file: { chats: 4 } })
    expect(preview.body.item.added).toBeUndefined()
    expect(existsSync(accountFileFor(app, "personal", env))).toBe(false)
    expect(existsSync(String(env.MESSAGING_STORE))).toBe(false)
  })

  it("refuses a file that does not say it is synthetic", async () => {
    const { root, env } = sandbox()
    await withProfile(env)
    const refused = await call(
      ["personal", "store", "import", seedFile(root, (seed) => delete seed.synthetic), "--yes", "--json"],
      env,
    )
    expect(refused.code).not.toBe(0)
    expect(refused.refusal).toContain('"synthetic": true')
  })

  it("refuses the owner's real store, and tells the real folder apart whatever HOME says", async () => {
    const { root, env } = sandbox()
    const real = join(wirecatDirectory({ HOME: userInfo().homedir }), "wirecat.db")
    expect(inOwnerFolder(real)).toBe(true)
    expect(inOwnerFolder(String(env.MESSAGING_STORE))).toBe(false)
    expect(inOwnerFolder("/home/someone/.local/share/WireCat/wirecat.db", "/home/someone")).toBe(true)
    expect(inOwnerFolder("/tmp/sandbox/home/.local/share/WireCat/wirecat.db", "/home/someone")).toBe(false)

    await withProfile(env)
    const refused = await call(["personal", "store", "import", seedFile(root), "--yes", "--json"], {
      ...env,
      MESSAGING_STORE: real,
    })
    expect(refused.code).not.toBe(0)
    expect(refused.refusal).toContain("is the owner's real one")
  })

  it("refuses a profile that is another account, and a profile that does not exist", async () => {
    const { root, env } = sandbox()
    await withProfile(env)
    await call(["personal", "store", "import", seedFile(root), "--yes", "--json"], env)
    const other = seedFile(root, (seed) => {
      seed.account = { id: "person-99", name: "Someone else", username: null }
    })

    const mismatch = await call(["personal", "store", "import", other, "--yes", "--json"], env)
    expect(mismatch.code).not.toBe(0)
    expect(mismatch.refusal).toContain("is account person-1")

    rmSync(accountFileFor(app, "personal", env))
    const remapped = await call(["personal", "store", "import", other, "--yes", "--json"], env)
    expect(remapped.code).not.toBe(0)
    expect(remapped.refusal).toContain("the store has profile personal as account person-1")

    const unknown = await call(["nobody", "store", "import", other, "--yes", "--json"], env)
    expect(unknown.code).not.toBe(0)
    expect(unknown.refusal).toContain('no profile named "nobody"')
  })
})
