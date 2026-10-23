import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import type { Message } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", version: "1.0.0", description: "Synthetic" }
const account = { provider: "test", account: "500" }
const message = (id: number): Message => ({
  id: String(id),
  chatId: "7",
  senderId: "test",
  senderName: null,
  timestamp: new Date(id * 1000).toISOString(),
  editedAt: null,
  text: `synthetic ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "gaps-cli-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "fixture.db"),
  }
  rememberAccount(app, "default", account.account, env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.messages.saveMessages(account, "7", [message(1), message(3), message(7), message(9)], { via: "history" })
  await store.sync.markRange(account, "7", 1, 3)
  await store.sync.markRange(account, "7", 7, 9)
  await store.close()
  const connect = vi.fn(
    async () =>
      ({
        self: () => "500",
        close: async () => {},
        history: async (_chat: string, { before, limit }: { before?: string; limit: number }) => {
          const older = Array.from({ length: 9 }, (_, i) => message(i + 1)).filter(
            (one) => before === undefined || Number(one.id) < Number(before),
          )
          return { items: older.slice(-limit), hasMore: older.length > limit }
        },
      }) as unknown as MessengerAdapter,
  )
  const messenger: Messenger = {
    app,
    provider: "test",
    chatArgument: "a chat",
    connect,
    resolveSettings: settingsFor(app).resolveSettings,
  }
  const call = async (argv: string[], extra = {}) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      { app, commands: () => [storeCommand(messenger)] },
      { env, streams, tty: false, ...extra },
    )
    const answer = JSON.parse(streams.stdout.join("") || "null")
    if (code === 0 && answer?.item) {
      const schema =
        argv[1] === "gaps"
          ? argv[2] === "show"
            ? ENTITIES.store_gap_plan
            : ENTITIES.store_gap_repair
          : argv[1] === "jobs" && argv[2] === "show"
            ? ENTITIES.store_job_details
            : undefined
      if (schema) v.parse(schema as v.GenericSchema, answer.item)
    }

    return { code, body: answer?.item ?? answer, stderr: streams.stderr.join("") }
  }
  return { call, connect, env }
}

describe("gap plan and repair commands", () => {
  it("plans locally then repairs with explicit limits and rechecked coverage", async () => {
    const { call, connect } = await fixture()
    const plan = await call(["store", "gaps", "show", "7", "--json"])
    expect(plan).toMatchObject({ code: 0, body: { gaps: [{ from: 4, to: 6 }] } })
    expect(connect).not.toHaveBeenCalled()
    const repaired = await call([
      "store",
      "gaps",
      "repair",
      "7",
      "--fingerprint",
      plan.body.fingerprint,
      "--limit",
      "5",
      "--max-gaps",
      "1",
      "--page-size",
      "3",
      "--pause",
      "1ms",
      "--repair-time",
      "1s",
      "--catch-up",
      "--catch-up-chunks",
      "1",
      "--catch-up-messages",
      "1",
      "--catch-up-time",
      "1s",
      "--json",
    ])
    expect(repaired, repaired.stderr).toMatchObject({
      code: 0,
      body: { complete: true, after: { gaps: [] }, prepared: { reason: "message_bound" } },
    })
    expect(repaired.stderr).not.toContain("synthetic")
  })

  it("refuses writes in readonly mode and records a background job with its exact fingerprint", async () => {
    const { call, connect, env } = await fixture()
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ defaults: { permissions: { store: "readonly" } }, profiles: {} }),
    )
    const denied = await call(["store", "gaps", "repair", "7", "--json"])
    expect(denied.code, denied.stderr).toBe(5)
    expect(connect).not.toHaveBeenCalled()
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: {} }))
    const spawn = vi.fn((_argv: string[], _env: NodeJS.ProcessEnv, _log: string) => 999999)
    const job = await call(["store", "gaps", "repair", "7", "--background", "--json"], { spawnJob: spawn })
    expect(job).toMatchObject({ code: 0, body: { pid: 999999, job: expect.any(String) } })
    expect(spawn.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["store", "gaps", "repair", "--fingerprint", "--repair-time"]),
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it("runs the background job it starts to the end, bounded by its repair time", async () => {
    const { call, connect } = await fixture()
    const spawn = vi.fn((_argv: string[], _env: NodeJS.ProcessEnv, _log: string) => 999999)
    const started = await call(
      ["store", "gaps", "repair", "7", "--pause", "1ms", "--no-catch-up", "--background", "--json"],
      { spawnJob: spawn },
    )
    expect(started.code, started.stderr).toBe(0)
    const [argv = [], jobEnv = {}] = spawn.mock.calls[0] ?? []

    const ran = await call(argv, { env: jobEnv })
    expect(ran, ran.stderr).toMatchObject({ code: 0, body: { complete: true, after: { gaps: [] } } })
    expect(connect).toHaveBeenCalledOnce()
    const job = await call(["store", "jobs", "show", started.body.job, "--json"], { env: jobEnv })
    expect(job.body).toMatchObject({ state: "done" })
  })
})
