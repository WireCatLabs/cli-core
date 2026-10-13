import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import { openStore } from "../../store/store.js"
import { commandsCommand } from "../commands-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import { statsCommand } from "./stats-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const setup = async (permissions?: object) => {
  const root = mkdtempSync(join(tmpdir(), "observation-cli-")),
    env = {
      ...process.env,
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "store.db"),
      NO_COLOR: "1",
    }
  if (permissions) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ defaults: { permissions } }))
  }
  const account = { provider: "chat", account: "500" }
  rememberAccount(app, "default", account.account, env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.saveChats(account, [
    { id: "7", title: "Synthetic", kind: "group", unreadCount: null, lastMessageAt: null, participantsCount: 1 },
  ])
  const joined = Date.now() - 10 * 86_400_000
  await store.saveRoster(account, "7", {
    members: [{ id: "2", name: "Synthetic", username: null, role: "member", joinedAt: new Date(joined).toISOString() }],
    complete: true,
    participants: 1,
    observation: { observedAt: new Date(joined + 86_400_000).toISOString(), source: "remote_fetch" },
  })
  await store.saveMessages(
    account,
    "7",
    [
      {
        id: "1",
        chatId: "7",
        senderId: "2",
        senderName: "Synthetic",
        timestamp: new Date(joined + 1000).toISOString(),
        text: "Synthetic",
        editedAt: null,
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
        outgoing: false,
        attachments: [],
        providerMetadata: { views: 10 },
      },
    ],
    { via: "history" },
  )
  await store.close()
  const connect = vi.fn(async () => {
    throw new Error("unexpected remote connection")
  })
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    counterFields: ["views"],
  }
  const call = async (...args: string[]) => {
    const streams = captureStreams(),
      code = await run(
        args,
        { app, commands: () => [statsCommand(messenger), commandsCommand(app)] },
        { streams, tty: false, env },
      )
    return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
  }
  return { call, connect }
}
describe("observation CLI", () => {
  it("declares counter refresh as a local write in command discovery", async () => {
    const { call } = await setup()
    const discovery = await call("commands", "stats", "messages", "counters", "refresh", "--json")
    expect(discovery.code, discovery.stderr).toBe(0)
    const commands = JSON.parse(discovery.stdout).commands as { path: string[]; mutates?: boolean; local?: boolean }[]
    expect(commands.find((command) => command.path.join(" ") === "stats messages counters refresh")).toMatchObject({
      mutates: true,
      local: true,
    })
    const shown = await call("commands", "stats", "messages", "counters", "show", "--json")
    expect(JSON.parse(shown.stdout).commands[0]?.mutates).not.toBe(true)
  })

  it("shows counter freshness and exact dry-run targets without connecting", async () => {
    const { call, connect } = await setup()
    const shown = await call("stats", "messages", "counters", "show", "--chat", "7", "--counters", "views", "--json")
    expect(shown.code, shown.stderr).toBe(0)
    const found = JSON.parse(shown.stdout)
    expect(found.items[0]).toMatchObject({
      locator: "msg:chat/500/7/1",
      counters: [{ value: 10, freshness: "unknown" }],
    })
    const preview = await call(
      "stats",
      "messages",
      "counters",
      "refresh",
      "--selection",
      JSON.stringify(found.selection),
      "--dry-run",
      "--json",
    )
    expect(preview.code, preview.stderr).toBe(0)
    expect(JSON.parse(preview.stdout)).toMatchObject({
      dryRun: true,
      targets: ["msg:chat/500/7/1"],
      supported: ["views"],
      unsupported: ["reactions", "comments"],
    })
    expect(connect).not.toHaveBeenCalled()
  })
  it("returns retention cohorts and replayable bounded member evidence", async () => {
    const { call, connect } = await setup()
    const report = await call("stats", "chats", "retention", "7", "--timezone", "UTC", "--json")
    expect(report.code, report.stderr).toBe(0)
    const found = JSON.parse(report.stdout),
      item = found.items[0]
    expect(item).toMatchObject({
      stays: 1,
      checkpoints: [{ present: 1, observable: 1 }, { unknown: 1 }, { pending: 1 }],
    })
    const evidence = await call(
      "stats",
      "messages",
      "evidence",
      item.cohort,
      "--selection",
      JSON.stringify(item.drilldown.arguments.selection),
      "--component",
      "report",
      "--json",
    )
    expect(evidence.code, evidence.stderr).toBe(0)
    expect(JSON.parse(evidence.stdout)).toMatchObject({
      items: [{ person: "2", activity: { state: "observed-message", archiveCovered: false } }],
      included: 1,
    })
    expect(connect).not.toHaveBeenCalled()
  })
  it("rechecks retention read permissions when a cohort selection is replayed through message evidence", async () => {
    const allowed = await setup()
    const result = await allowed.call("stats", "chats", "retention", "7", "--json")
    const row = JSON.parse(result.stdout).items[0]
    const denied = await setup({ "stats.chats.retention": "deny" })
    const replay = await denied.call(
      "stats",
      "messages",
      "evidence",
      row.cohort,
      "--selection",
      JSON.stringify(row.drilldown.arguments.selection),
      "--component",
      "report",
      "--json",
    )
    expect(replay.code).not.toBe(0)
    expect(replay.stderr).toContain("stats.chats.retention")
    expect(denied.connect).not.toHaveBeenCalled()
  })

  it("emits JSONL and refuses unscoped refresh before any connection", async () => {
    const { call, connect } = await setup()
    const shown = await call("stats", "messages", "counters", "show", "--chat", "7", "--jsonl")
    expect(shown.code, shown.stderr).toBe(0)
    expect(JSON.parse(shown.stdout)).toMatchObject({ messageId: "1" })
    const refused = await call("stats", "messages", "counters", "refresh", "--json")
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain("explicit")
    expect(connect).not.toHaveBeenCalled()
  })
})
