import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import * as v from "valibot"
import { expect, it, vi } from "vitest"
import type { Chat, GroupCard } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import { metadataCommand } from "./metadata-command.js"

it("declares actual missing, cached and partial-refresh metadata and projects its fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "metadata-cli-"))
  const env = {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "store.db"),
  }
  const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "0" }
  const chat: Chat = {
    id: "7",
    title: "Synthetic group",
    kind: "group",
    unreadCount: 0,
    lastMessageAt: null,
    participantsCount: null,
  }
  const card: GroupCard = {
    ...chat,
    description: "A synthetic description",
    link: null,
    settings: {
      allCanPin: null,
      onlyAdminsAdd: null,
      onlyAdminsCall: null,
      onlyOwnerEditsInfo: null,
      membersSeeLink: null,
    },
  }
  const group = vi.fn(async () => card)
  const close = vi.fn(async () => {})
  const connect = vi.fn(async () => ({ self: () => "500", group, close }) as unknown as MessengerAdapter)
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    chatArgument: "chat",
    connect,
  }
  rememberAccount(app, "default", "500", env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.chats.saveChats({ provider: "chat", account: "500" }, [chat])
  await store.close()
  const call = async (...argv: string[]) => {
    const streams = captureStreams()
    const code = await run(
      ["metadata", ...argv],
      { app, commands: () => [metadataCommand(messenger)] },
      { env, streams, tty: false },
    )
    return {
      code,
      body: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined,
      stderr: streams.stderr.join("\n"),
    }
  }
  const missing = await call("show", "--chat", "7", "--json")
  expect(missing.code, missing.stderr).toBe(0)
  expect(v.parse(ENTITIES.chat_metadata, missing.body.item)).toEqual({ chat_id: "7", metadata: null })
  expect(connect).not.toHaveBeenCalled()
  const refreshed = await call("sync", "--chat", "7", "--chat", "missing", "--json")
  expect(refreshed.code, refreshed.stderr).toBe(0)
  v.parse(ENTITIES.chat_metadata_refresh, refreshed.body.item)
  expect(refreshed.body.item).toMatchObject({
    chats: [
      { chat_id: "7", description: card.description },
      { chat_id: "missing", error: { code: "not_found" } },
    ],
    has_more: false,
  })
  expect(close).toHaveBeenCalled()
  const cached = await call("show", "--chat", "7", "--json")
  v.parse(ENTITIES.chat_metadata, cached.body.item)
  expect(cached.body.item.metadata).toEqual(refreshed.body.item.chats[0])
  const projected = await call("show", "--chat", "7", "--json=metadata.description")
  expect(projected.code, projected.stderr).toBe(0)
  expect(projected.body.item).toEqual({ metadata: { description: card.description } })
  const limited = await call("sync", "--chat", "7", "--chat", "missing", "--limit", "1", "--json")
  expect(v.parse(ENTITIES.chat_metadata_refresh, limited.body.item).has_more).toBe(true)
  const connections = connect.mock.calls.length
  const refused = await call("show", "--chat", "7", "--json=unknown_field")
  expect(refused.code).not.toBe(0)
  expect(JSON.parse(refused.stderr).error.reason).toBe("output.unknown-field")
  expect(connect).toHaveBeenCalledTimes(connections)
})
