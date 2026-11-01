import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Chat } from "../../domain/models.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { providerLogPathFor, writeProviderWarning } from "../../runs/provider-log.js"
import { FloodMemory } from "../../sends/flood.js"
import type { SendEntry } from "../../sends/journal.js"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { configCommand } from "../config-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"
import { CLOCK_SKEW_WARN_MS, doctorCommand } from "./doctor-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 2,
}
const connection = {
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat], hasMore: false }),
  close: async () => {},
} as unknown as MessengerAdapter

const refused = async (): Promise<MessengerAdapter> => {
  throw new CliError("authentication_error", "no session")
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-"))
  return {
    root,
    env: {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    },
  }
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, connect: Messenger["connect"]) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    diagnose: async () => ({ session: { exists: true } }),
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [doctorCommand(messenger), chatsCommand(messenger), configCommand(app, settingsFor(app))],
    },
    {
      streams,
      tty: false,
      env,
    },
  )
  const body = streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined
  return {
    code,
    answer: body?.item,
    next: body?.next,
    stdout: streams.stdout,
    stderr: streams.stderr,
  }
}

describe("doctor", () => {
  it("**answers on a fresh install without connecting**", async () => {
    const { env } = setup()
    const { code, answer } = await call(["doctor", "--json"], env, refused)

    expect(code).toBe(0)
    expect(answer).toMatchObject({
      cli: { command: "chat", version: "1.0.0" },
      account: { remembered: null },
      store: { exists: false },
      chat: { session: { exists: true } },
    })
  })

  it("**says the file readers are built in, and whether the optional OCR renderer is installed**", async () => {
    const { env } = setup()
    const { answer } = await call(["doctor", "--json"], env, refused)

    expect(answer.readers).toEqual({
      unpdf: "built in",
      mammoth: "built in",
      "word-extractor": "built in",
      linkedom: "built in",
      "defuddle/node": "built in",
      "@napi-rs/canvas": "installed",
    })
  })

  it("**never calls the login ok without --online**", async () => {
    const { env } = setup()
    const { answer, next } = await call(["doctor", "--json"], env, refused)

    expect(answer.login).toEqual({ state: "not checked" })
    expect(next).toEqual([
      expect.objectContaining({ step: "doctor.online", command: "doctor", args: { online: true } }),
    ])
    expect(answer.online).toBeUndefined()
  })

  it.skipIf(process.platform === "win32")(
    "names each private file anybody else can read, with the command that fixes it, and changes nothing",
    async () => {
      const { root, env } = setup()
      await call(["chats", "list"], env, async () => connection)
      expect((await call(["doctor", "--json"], env, refused)).answer.files).toEqual({
        checked: true,
        ok: true,
        problems: [],
      })

      const runs = join(root, "state", "runs")
      mkdirSync(runs, { recursive: true })
      chmodSync(env.MESSAGING_STORE, 0o644)
      chmodSync(runs, 0o755)
      const { answer, stderr } = await call(["doctor", "--json"], env, refused)

      expect(answer.files.ok).toBe(false)
      expect(answer.files.problems).toEqual([
        { path: env.MESSAGING_STORE, mode: "0644", want: "0600" },
        { path: runs, mode: "0755", want: "0700" },
      ])
      expect(stderr.join("\n")).toContain(`to make it private: chmod 600 '${env.MESSAGING_STORE}'`)
      expect(stderr.join("\n")).toContain(`to make it private: chmod 700 '${runs}'`)
      expect(statSync(env.MESSAGING_STORE).mode & 0o777).toBe(0o644)
    },
  )

  it.skipIf(process.platform === "win32")(
    "names a config file or config folder others can read, with or without a profile named",
    async () => {
      const { root, env } = setup()
      await call(["chats", "list"], env, async () => connection)
      const folder = join(root, "config")
      const file = join(folder, "config.json")
      chmodSync(file, 0o644)
      chmodSync(folder, 0o775)
      const wanted = [
        { path: file, mode: "0644", want: "0600" },
        { path: folder, mode: "0775", want: "0700" },
      ]

      const named = await call(["doctor", "--json"], env, refused)
      expect(named.answer.files.problems).toEqual(wanted)
      expect(named.stderr.join("\n")).toContain(`to make it private: chmod 600 '${file}'`)
      expect(named.stderr.join("\n")).toContain(`to make it private: chmod 700 '${folder}'`)

      const { CHAT_PROFILE: _, ...unnamed } = env
      const none = await call(["doctor", "--json"], unnamed, refused)
      expect(none.answer.profile).toBeNull()
      expect(none.answer.files.problems).toEqual(wanted)
      expect(none.stderr.join("\n")).toContain(`to make it private: chmod 600 '${file}'`)
    },
  )

  it("leaves alone the folder the owner chose for the store", async () => {
    const { root, env } = setup()
    await call(["chats", "list"], env, async () => connection)
    chmodSync(root, 0o755)
    const { answer } = await call(["doctor", "--json"], env, refused)
    expect(answer.files.problems ?? []).not.toContainEqual(expect.objectContaining({ path: root }))
  })

  it("**counts the messenger library's warnings of the last day, by kind**", async () => {
    const { env } = setup()
    const path = providerLogPathFor(app, "default", env)
    writeProviderWarning(path, "decrypt", "database is locked")
    writeProviderWarning(path, "decrypt", "database is locked")
    writeProviderWarning(path, "socket", "close failed")

    const { answer } = await call(["doctor", "--json"], env, refused)
    expect(answer.provider_log).toEqual({ path, last_day: { total: 3, kinds: { decrypt: 2, socket: 1 } } })
  })

  it("reads the store and the remembered account once something was read", async () => {
    const { env } = setup()
    await call(["chats", "list"], env, async () => connection)

    const { answer } = await call(["doctor", "--json"], env, refused)
    expect(answer).toMatchObject({
      account: { remembered: "500" },
      store: { exists: true, schema: MIGRATIONS.at(-1)?.version, chats: 1 },
    })
  })

  it("**answers on a file that is not JSON**, with the place it stopped and no command to run", async () => {
    const { root, env } = setup()
    mkdirSync(join(root, "config"), { recursive: true })
    const file = join(root, "config", "config.json")
    writeFileSync(file, '{\n  "profiles": {},\n  not json\n}\n')

    const { code, answer, stdout } = await call(["doctor", "--json"], env, refused)
    expect(code).toBe(0)
    expect(JSON.parse(stdout[0] ?? "")).not.toHaveProperty("error")
    expect(answer.config).toEqual({
      path: file,
      found: true,
      issues: [
        { kind: "invalid_json", file, line: 3, column: 3, what: "the file is not valid JSON at line 3, column 3" },
      ],
    })
    expect(answer.store).toBeDefined()
    expect(answer.profile).toBe("default")
  })

  it.each([
    ["a folder", (path: string) => mkdirSync(path), "the path is a folder, not a file"],
    ["a list", (path: string) => writeFileSync(path, "[]"), "the file must hold a JSON object"],
  ])(
    "**reports %s at the config path** as a whole-file problem, which other commands refuse",
    async (_, make, what) => {
      const { root, env } = setup()
      mkdirSync(join(root, "config"), { recursive: true })
      const file = join(root, "config", "config.json")
      make(file)

      const { code, answer } = await call(["doctor", "--json"], env, refused)
      expect(code).toBe(0)
      expect(answer.config.issues).toEqual([{ kind: "invalid_value", file, what }])
      const listed = await call(["chats", "list", "--json"], env, refused)
      expect(listed.code).toBe(3)
      expect(listed.stderr.join("\n")).toContain(`${file}: ${what}`)
    },
  )

  const configured = (env: NodeJS.ProcessEnv, root: string, contents: unknown) => {
    mkdirSync(join(root, "config"), { recursive: true })
    writeFileSync(join(root, "config", "config.json"), JSON.stringify(contents))
    return env
  }

  it.each([
    ["unknown_setting", { profiles: { work: { limitt: 5 } } }, "chat work config unset limitt"],
    ["unknown_setting", { default_profile: "work" }, "chat config unset default_profile"],
    ["unknown_setting", { bot: { defaults: { colour: true } } }, "chat config unset --defaults --bot colour"],
    [
      "unknown_permission",
      { profiles: { work: { permissions: { "bogus.thing": "deny" } } } },
      "chat work config unset permissions.bogus.thing",
    ],
    [
      "unknown_permission",
      { profiles: { work: { permissions: { "messages.bogus": "deny" } } } },
      "chat work config unset permissions.messages.bogus",
    ],
    [
      "unknown_permission",
      { personal: { profiles: { work: { permissions: { "bot.store.fetch": "deny" } } } } },
      "chat work config unset --personal permissions.bot.store.fetch",
    ],
    ["invalid_value", { profiles: { work: { limit: "20" } } }, "chat work config unset limit"],
    [
      "invalid_value",
      { profiles: { work: { permissions: { "messages.send": "yes" } } } },
      "chat work config unset permissions.messages.send",
    ],
  ])("**reports %s with a fix that removes it**: %j", async (kind, contents, fix) => {
    const { root, env } = setup()
    configured(env, root, contents)

    const before = (await call(["doctor", "--json"], env, refused)).answer.config.issues
    expect(before).toEqual([expect.objectContaining({ kind, fix })])
    const fields = ["file", "fix", "key", "kind", "what", ...(fix.startsWith("chat work") ? ["profile"] : [])]
    expect(Object.keys(before[0]).sort()).toEqual(fields.sort())
    expect(JSON.stringify(before)).not.toMatch(/"20"|yes/)

    const [, ...words] = fix.split(" ")
    expect((await call(words, env, refused)).code).toBe(0)
    expect((await call(["doctor", "--json"], env, refused)).answer.config.issues).toEqual([])
  })

  it("**reports every problem in every section at once**, a key the profile hides included", async () => {
    const { root, env } = setup()
    configured(env, root, {
      default_profile: "work",
      defaults: { permissions: { "messages.dlete": "deny" }, limitt: 1 },
      profiles: { work: { permissions: { messages: "allow", "bogus.x": "deny" }, color: "yes", other: 1 } },
      bot: { profiles: { sales: { permissions: { "bot.store.fetch": "deny" } } } },
    })

    const { code, answer } = await call(["work", "doctor", "--json"], env, refused)
    expect(code).toBe(0)
    const found = answer.config.issues.map((issue: { kind: string; key: string }) => `${issue.kind} ${issue.key}`)
    expect(found.sort()).toEqual([
      "invalid_value color",
      "unknown_permission permissions.bogus.x",
      "unknown_permission permissions.bot.store.fetch",
      "unknown_permission permissions.messages.dlete",
      "unknown_setting default_profile",
      "unknown_setting limitt",
      "unknown_setting other",
    ])
    expect((await call(["work", "chats", "list"], env, refused)).code).toBe(3)
  })

  it("answers with no profile named, reporting the file and what needs none", async () => {
    const { root, env } = setup()
    const { CHAT_PROFILE: _, ...unnamed } = configured(env, root, { profiles: { work: { limitt: 1 } } })

    const { code, answer } = await call(["doctor", "--json"], unnamed, refused)
    expect(code).toBe(0)
    expect(answer.profile).toBeNull()
    expect(answer.config.issues).toEqual([expect.objectContaining({ kind: "unknown_setting", profile: "work" })])
  })

  it("says a store from a newer version cannot be written, and leaves it as it was", async () => {
    const { env } = setup()
    const database = await openCache(env.MESSAGING_STORE)
    const latest = MIGRATIONS.at(-1)?.version ?? 0
    migrate(database, {
      migrations: [...MIGRATIONS, { version: latest + 1, minCompatible: latest + 1, statements: [] }],
    })
    database.close()

    const { answer } = await call(["doctor", "--json"], env, refused)
    expect(answer.store).toMatchObject({ schema: latest + 1, speaks: latest, writable: false })
  })

  it("with --online, connects once, and says a failure rather than failing", async () => {
    const { env } = setup()
    await call(["chats", "list"], env, async () => connection)

    expect((await call(["doctor", "--online", "--json"], env, async () => connection)).answer.online).toMatchObject({
      ok: true,
      matches_remembered: true,
    })
    const failed = await call(["doctor", "--online", "--json"], env, refused)
    expect(failed.code).toBe(0)
    expect(failed.answer.online).toMatchObject({ ok: false, error_code: "authentication_error" })
  })
})

describe("doctor --online", () => {
  const withHealth = (health: MessengerAdapter["health"]) => ({ ...connection, health }) as MessengerAdapter

  it("measures the clock against the messenger's and warns when it is far off", async () => {
    const { env } = setup()
    const fine = await call(["doctor", "--online", "--json"], env, async () =>
      withHealth(async () => ({ standingChecked: true, serverTime: Date.now(), serverTimeResolutionMs: 1000 })),
    )
    expect(fine.answer.online).toMatchObject({ ok: true, standing: { state: "active" }, clock: { ok: true } })
    expect(Math.abs(fine.answer.online.clock.skew_ms)).toBeLessThan(1000)
    expect(fine.answer.online.clock.uncertainty_ms).toBeGreaterThanOrEqual(1000)
    expect(fine.answer.login).toEqual({ state: "ok" })

    const ahead = await call(["doctor", "--online", "--json"], env, async () =>
      withHealth(async () => ({ standingChecked: true, serverTime: Date.now() - 2 * CLOCK_SKEW_WARN_MS })),
    )
    expect(ahead.answer.online.clock).toMatchObject({ ok: false, warn_above_ms: CLOCK_SKEW_WARN_MS })
    expect(ahead.answer.online.clock.skew_ms).toBeGreaterThanOrEqual(2 * CLOCK_SKEW_WARN_MS - 100)
  })

  it("says nothing about the clock for a messenger that cannot tell", async () => {
    const { env } = setup()
    const { answer } = await call(["doctor", "--online", "--json"], env, async () => connection)
    expect(answer.online).toMatchObject({ ok: true, clock: null, standing: { state: "active" } })
  })

  it("reports a frozen account with its dates and where to appeal", async () => {
    const { env } = setup()
    const frozen = {
      state: "frozen" as const,
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-10-01T00:00:00.000Z",
      appealUrl: "https://example.org/appeal",
      hint: "appeal before the account is deleted",
    }
    const { code, answer } = await call(["doctor", "--online", "--json"], env, async () =>
      withHealth(async () => ({ standingChecked: true, serverTime: Date.now(), standing: frozen })),
    )
    expect(code).toBe(0)
    const { appealUrl, ...rest } = frozen
    expect(answer.online).toMatchObject({ ok: true, standing: { ...rest, appeal_url: appealUrl } })
    expect(answer.login).toEqual({ state: "ok" })
  })

  it("**holds writes once it sees the account frozen, and lifts only that hold once it sees it active**", async () => {
    const { env } = setup()
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const frozen = { state: "frozen" as const, until, hint: "frozen until the appeal" }
    const first = await call(["doctor", "--online", "--json"], env, async () =>
      withHealth(async () => ({ standingChecked: true, serverTime: Date.now(), standing: frozen })),
    )
    expect(first.answer.flood).toMatchObject({ deadlines: [], send_block: { state: "frozen", until } })

    const active = async () => withHealth(async () => ({ standingChecked: true, serverTime: Date.now() }))
    expect((await call(["doctor", "--online", "--json"], env, active)).answer.flood.send_block).toBeNull()

    new FloodMemory(join(env.CHAT_STATE_DIR, "flood", "default.json")).block({ state: "limited", hint: "spam" })
    expect((await call(["doctor", "--online", "--json"], env, active)).answer.flood.send_block).toMatchObject({
      state: "limited",
    })
    expect((await call(["doctor", "--json"], env, refused)).answer.flood.send_block).toMatchObject({ state: "limited" })
  })

  it("reports a banned account as a state, from the refusal, and still reads the clock", async () => {
    const { env } = setup()
    const banned = async () =>
      ({
        ...withHealth(async () => ({ serverTime: Date.now(), standingChecked: true })),
        me: async () => {
          throw new CliError("authentication_error", "the messenger ended this account", {
            provider_error: "USER_DEACTIVATED_BAN",
            standing: { state: "banned", hint: "only the messenger can restore it" },
          })
        },
      }) as MessengerAdapter
    const { code, answer } = await call(["doctor", "--online", "--json"], env, banned)

    expect(code).toBe(0)
    expect(answer.online).toMatchObject({
      ok: false,
      error_code: "authentication_error",
      provider_error: "USER_DEACTIVATED_BAN",
      standing: { state: "banned" },
      clock: { ok: true },
    })
    expect(answer.login).toEqual({ state: "failed" })
    expect(answer.flood.send_block).toMatchObject({ state: "banned", until: null })

    const active = async () => withHealth(async () => ({ standingChecked: true, serverTime: Date.now() }))
    expect((await call(["doctor", "--online", "--json"], env, active)).answer.flood.send_block).toBeNull()
  })

  it("keeps answering when the health request itself fails", async () => {
    const { env } = setup()
    const { answer } = await call(["doctor", "--online", "--json"], env, async () =>
      withHealth(async () => {
        throw new CliError("network_error", "gone")
      }),
    )
    expect(answer.online).toMatchObject({
      ok: true,
      clock: null,
      health_error: "network_error",
      standing: { state: "unknown" },
    })
  })

  it("**never says active when the messenger could not check the account's standing**", async () => {
    const { env } = setup()
    const { answer } = await call(["doctor", "--online", "--json"], env, async () =>
      withHealth(async () => ({ serverTime: Date.now(), standingChecked: false })),
    )
    expect(answer.online).toMatchObject({ ok: true, standing: { state: "unknown" }, clock: { ok: true } })
  })
})

describe("doctor reports show", () => {
  const failedRun = (root: string) => {
    const dir = join(root, "state", "runs", "2026-09-29", "20260929T100000Z-chats-list-abc123")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({
        runId: "20260929T100000Z-chats-list-abc123",
        command: "chats list",
        profile: "default",
        startedAt: "2026-09-29T10:00:00.000Z",
        status: "failed",
        cliVersion: "1.0.0",
        errorCode: "provider_error",
      }),
    )
    writeFileSync(
      join(dir, "events.jsonl"),
      `${JSON.stringify({
        level: 30,
        hostname: "owners-laptop",
        msg: "Book club",
        event: "response",
        operation: "chats.show",
        ids: { chat: "-1001234567890" },
        outcome: "error",
        errorCode: "provider_error",
      })}\n`,
    )
  }

  it("**writes a file with no id, no title and no home folder in it**, and the same label for the same id", async () => {
    const { root, env } = setup()
    const home = join(root, "home")
    await call(["chats", "list", "--json"], env, async () => connection)
    failedRun(root)
    mkdirSync(join(root, "state", "sends"), { recursive: true })
    writeFileSync(
      join(root, "state", "sends", "default.jsonl"),
      `${JSON.stringify({ at: "2026-09-29T10:00:00.000Z", profile: "default", chatId: "-1001234567890", outcome: "sent", messageId: "42", length: 5 })}\n`,
    )
    const output = join(root, "report.json")

    const { code, answer } = await call(
      ["doctor", "reports", "create", "--output", output, "--json"],
      { ...env, HOME: root, CHAT_CONFIG_DIR: join(home, "config") },
      refused,
    )

    expect(code).toBe(0)
    expect(answer).toEqual({ path: output, run: "20260929T100000Z-chats-list-abc123" })
    const text = readFileSync(output, "utf8")
    for (const secret of ["-1001234567890", "Book club", "owners-laptop", root]) expect(text).not.toContain(secret)
    const report = JSON.parse(text)
    const label = report.run.events[0].ids.chat
    expect(label).toMatch(/^id:[0-9a-f]{12}$/)
    expect(report.sends[0]).toMatchObject({ chatId: label, outcome: "sent", length: 5 })
    expect(report.doctor.account.remembered).toMatch(/^id:/)
    expect(report.doctor.config.path).toBe("~/home/config/config.json")
    expect(Object.keys(report.run.events[0]).sort()).toEqual(["error_code", "event", "ids", "operation", "outcome"])
  })

  it("**labels every id a send journal line can hold**, and a send's operation id as its send id", async () => {
    const { root, env } = setup()
    const raw = {
      chatId: "-1001111111111",
      messageId: "2222222",
      replyTo: "3333333",
      threadId: "4444444",
      sendAs: "-1009999999999",
      resultChatId: "-1005555555555",
      sendId: "6666666666666666",
      operationId: "6666666666666666",
      parentOperationId: "7777777777777777",
      reservation: "8888888888888888",
    }
    const entry: Required<SendEntry> = {
      at: "2026-09-29T10:00:00.000Z",
      profile: "default",
      // Only a reserved line keeps its reservation once read back.
      outcome: "reserved",
      kind: "message",
      action: "join",
      people: 1,
      count: 1,
      forEveryone: false,
      length: 5,
      attachments: [],
      scheduledFor: "2026-09-29T11:00:00.000Z",
      notify: false,
      origin: "rule:away",
      errorCode: "none",
      key: "polls.create",
      ...raw,
    }
    mkdirSync(join(root, "state", "sends"), { recursive: true })
    writeFileSync(join(root, "state", "sends", "default.jsonl"), `${JSON.stringify(entry)}\n`)
    const output = join(root, "report.json")

    await call(["doctor", "reports", "create", "--output", output, "--json"], env, refused)

    const text = readFileSync(output, "utf8")
    for (const value of Object.values(raw)) expect(text).not.toContain(value)
    const [sent] = JSON.parse(text).sends
    for (const field of Object.keys(raw)) expect(sent[field]).toMatch(/^id:[0-9a-f]{12}$/)
    expect(sent.operationId).toBe(sent.sendId)
  })

  it("names a run that does not exist, and explains itself without writing", async () => {
    const { env } = setup()
    const missing = await call(["doctor", "reports", "create", "--run", "nope"], env, refused)
    expect(missing.code).not.toBe(0)
    expect(missing.stderr.join("\n")).toContain("chat runs list")

    const explained = await call(["doctor", "reports", "show", "--json"], env, refused)
    expect(explained.answer).not.toHaveProperty("create")
    expect(explained.next).toEqual([
      expect.objectContaining({ step: "doctor.report-create", command: "doctor reports create" }),
    ])
  })
})
