import { access, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { readMediaManifests } from "../../services/media-archive-manifest.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { attachmentsCommand } from "./attachments-command.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", version: "1.0.0", description: "Example" }
const chat: Chat = {
  id: "7",
  title: "Example group",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 2,
}
const message: Message = {
  id: "1",
  chatId: "7",
  senderId: "9",
  senderName: "Bob Example",
  text: "",
  timestamp: "2026-10-01T00:00:00.000Z",
  editedAt: null,
  outgoing: false,
  attachments: [{ kind: "file" }],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}
const fixture = async (kind = "file") => {
  const root = await mkdtemp(join(tmpdir(), "media-command-"))
  const env = {
    HOME: root,
    CHAT_PROFILE: "default",
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  rememberAccount(app, "default", "500", env)
  const close = vi.fn(async () => {})
  const adapter: MessengerAdapter = {
    send: async () => {
      throw new Error("archive tests must never send")
    },
    self: () => "500",
    me: async () => ({ id: "500", name: "Alice Example", username: null }),
    chats: async () => ({ items: [chat], hasMore: false }),
    resolve: async () => chat,
    chat: async () => ({ ...chat, members: [] }),
    history: async () => ({ items: [{ ...message, attachments: [{ kind }] }], hasMore: false }),
    download: async () => ({
      skipped: [],
      files: [
        {
          kind,
          position: 0,
          size: 3,
          bytes: async function* () {
            yield Buffer.from("abc")
          },
        },
      ],
    }),
    logout: async () => {},
    close,
  }
  const connect = vi.fn(async () => adapter)
  const messenger: Messenger = {
    app,
    provider: "chat",
    chatArgument: "a chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
  }
  const directory = join(root, "archive")
  const call = async (words: string[], extra = {}) => {
    const streams = captureStreams()
    const code = await run(
      words,
      { app, commands: () => [attachmentsCommand(messenger)] },
      { env, tty: false, streams, keyring: memoryKeyring(), ...extra },
    )
    if (words.includes("--json") && streams.stdout.length) {
      const names = {
        download: "media_archive",
        check: "media_archive_check",
        move: "media_archive_move",
        jobs: "media_archive_timer",
      } as const
      const entity = names[words[1] as keyof typeof names]
      const answer = JSON.parse(streams.stdout.join(""))
      if (entity && answer.item) v.parse(ENTITIES[entity] as v.GenericSchema, answer.item)
    }
    return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("") }
  }
  return { root, env, connect, close, directory, call }
}
describe("media archive commands", () => {
  it("previews and moves older images offline, honoring write denials without connecting", async () => {
    const f = await fixture("photo")
    expect((await f.call(["attachments", "download", f.directory, "--json"])).code).toBe(0)
    f.connect.mockClear()
    const destination = join(f.root, "old-images")
    const args = [
      "attachments",
      "move",
      f.directory,
      destination,
      "--before-time",
      "2026-10-10T00:00:00Z",
      "--offline",
      "--json",
    ]
    const preview = await f.call([...args, "--dry-run"])
    expect(preview.code, preview.stderr).toBe(0)
    expect(JSON.parse(preview.stdout).item).toMatchObject({ selected: 1, moved: 0, dry_run: true })
    const textPreview = await f.call([...args.filter((arg) => arg !== "--json"), "--dry-run"], { tty: true })
    expect(textPreview.code, textPreview.stderr).toBe(0)
    expect(textPreview.stdout).toContain("1 images selected (3 bytes)")
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" })
    const denied = await f.call([...args, "--permission", "attachments.move=readonly"])
    expect(denied.code).not.toBe(0)
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" })
    const moved = await f.call(args)
    expect(moved.code, moved.stderr).toBe(0)
    expect(JSON.parse(moved.stdout).item).toMatchObject({ moved: 1, complete: true })
    const checked = await f.call(["attachments", "check", f.directory, "--offline", "--json"])
    expect(checked.code).toBe(0)
    expect(JSON.parse(checked.stdout).item).toMatchObject({ valid: true })
    expect(f.connect).not.toHaveBeenCalled()
  })
  it("downloads through the service lifetime, checks entirely offline, and reports checksum failure with nonzero exit", async () => {
    const f = await fixture()
    const saved = await f.call([
      "attachments",
      "download",
      f.directory,
      "--chat",
      "Example group",
      "--pause",
      "1ms",
      "--json",
    ])
    expect(saved.code, saved.stderr).toBe(0)
    expect(JSON.parse(saved.stdout).item).toMatchObject({ saved: 1, existing: 0, complete: true })
    expect(f.close).toHaveBeenCalledTimes(1)
    f.connect.mockClear()
    const checked = await f.call(["attachments", "check", f.directory, "--offline", "--json"])
    expect(checked.code, checked.stderr).toBe(0)
    expect(JSON.parse(checked.stdout).item).toMatchObject({ checked: 1, valid: true })
    expect(f.connect).not.toHaveBeenCalled()
    const [entry] = await readMediaManifests(f.directory)
    if (!entry) throw new Error("missing entry")
    await writeFile(join(f.directory, entry.path), "xyz")
    const broken = await f.call(["attachments", "check", f.directory, "--json"])
    expect(broken.code).not.toBe(0)
    expect(JSON.parse(broken.stdout).item).toMatchObject({ valid: false })
    expect(f.connect).not.toHaveBeenCalled()
  })
  it("refuses offline download and protected destinations before connecting", async () => {
    const f = await fixture()
    expect((await f.call(["attachments", "download", f.directory, "--offline", "--json"])).code).not.toBe(0)
    expect((await f.call(["attachments", "download", f.env.CHAT_CONFIG_DIR, "--json"])).code).not.toBe(0)
    expect(
      (await f.call(["attachments", "download", f.directory, "--since-time", "yesterday", "--json"])).code,
    ).not.toBe(0)
    expect(f.connect).not.toHaveBeenCalled()
  })
  it("honors message and chat read denials before connecting", async () => {
    const f = await fixture()
    const denied = await f.call(["attachments", "download", f.directory, "--permission", "messages=deny", "--json"])
    expect(denied.code).not.toBe(0)
    expect(f.connect).not.toHaveBeenCalled()
    const deniedChats = await f.call(["attachments", "download", f.directory, "--permission", "chats=deny", "--json"])
    expect(deniedChats.code).not.toBe(0)
    expect(f.connect).not.toHaveBeenCalled()
  })
  it("installs a daily timer without connecting and starts only on an explicit start", async () => {
    const f = await fixture()
    const execute = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }))
    const system = { platform: "linux", entry: ["/usr/bin/node", "/example/chat.js"], run: execute }
    const installed = await f.call(
      ["attachments", "jobs", "install", f.directory, "--at", "04:00", "--timezone", "Europe/Madrid", "--json"],
      { system },
    )
    expect(installed.code, installed.stderr).toBe(0)
    expect(JSON.parse(installed.stdout).item).toMatchObject({ installed: true })
    expect(execute.mock.calls).toHaveLength(1)
    const started = await f.call(["attachments", "jobs", "start", f.directory, "--json"], { system })
    expect(started.code, started.stderr).toBe(0)
    expect(f.connect).not.toHaveBeenCalled()
  })
})
