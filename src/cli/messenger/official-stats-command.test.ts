import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { OfficialChatStats } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"
import { statsCommand } from "./stats-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }

const channel: OfficialChatStats = {
  version: 1,
  kind: "channel",
  chat: { id: "-1007", title: "Synthetic channel" },
  period: { since: "2026-09-07T00:00:00.000Z", until: "2026-10-06T00:00:00.000Z" },
  totals: {
    followers: { current: 120, previous: 110 },
    viewsPerPost: { current: 40, previous: 35 },
    sharesPerPost: { current: 1, previous: 0 },
    reactionsPerPost: { current: 3, previous: 2 },
    viewsPerStory: { current: 0, previous: 0 },
    sharesPerStory: { current: 0, previous: 0 },
    reactionsPerStory: { current: 0, previous: 0 },
  },
  notifications: { enabled: 30, total: 120 },
  recentPosts: [{ kind: "message", id: "9", views: 41, forwards: 1, reactions: 2 }],
  graphs: {
    growth: {
      kind: "line",
      x: { type: "date", values: ["2026-10-05", "2026-10-06"] },
      series: [{ key: "y0", name: "Total followers", kind: "line", values: [119, 120] }],
    },
    languages: { error: "Not enough data to display" },
  },
}

const setup = (adapter: Partial<MessengerAdapter>, officialStats = true) => {
  const root = mkdtempSync(join(tmpdir(), "official-stats-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    NO_COLOR: "1",
  }
  rememberAccount(app, "default", "500", env)
  const connect = vi.fn(
    async () => ({ self: () => "500", close: async () => {}, ...adapter }) as unknown as MessengerAdapter,
  )
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    officialStats,
  }
  return async (args: string[], tty = false) => {
    const streams = captureStreams()
    const code = await run(
      ["stats", "chats", "official", ...args],
      { app, commands: () => [statsCommand(messenger)] },
      { streams, tty, env },
    )
    return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
  }
}

describe("stats chats official", () => {
  it("prints the messenger's object on stdout and names a missing graph on stderr", async () => {
    const officialChatStats = vi.fn(async () => channel)
    const result = await setup({ officialChatStats })(["@synthetic", "--json"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(channel)
    expect(result.stderr).toContain("graphs not given: languages")
    expect(officialChatStats).toHaveBeenCalledWith("@synthetic")
  })

  it("summarises totals, posts and graphs in pretty output", async () => {
    const result = await setup({ officialChatStats: async () => channel })(["@synthetic"], true)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("followers 120 (before 110)")
    expect(result.stdout).toContain("message 9  41 views")
    expect(result.stdout).toContain("growth  2 points")
  })

  it("refuses --jsonl before connecting", async () => {
    const officialChatStats = vi.fn(async () => channel)
    const result = await setup({ officialChatStats })(["@synthetic", "--jsonl"])
    expect(result.code).toBe(2)
    expect(officialChatStats).not.toHaveBeenCalled()
  })

  it("refuses on an adapter without the capability", async () => {
    const result = await setup({})(["@synthetic", "--json"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("cannot read its own statistics")
  })

  it("is not mounted for a messenger that has no statistics of its own", async () => {
    const result = await setup({}, false)(["@synthetic", "--json"])
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe("")
  })
})
