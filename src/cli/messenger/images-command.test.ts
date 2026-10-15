import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { imagesCommand } from "./images-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "image-command-"))
  const embed = vi.fn(async (_options: { chat?: string; limit?: number; signal?: AbortSignal }) => ({
    embedded: 2,
    skipped: 1,
    failed: 1,
    more: true,
    model: "synthetic-model",
  }))
  const messenger: Messenger = {
    app,
    provider: "chat",
    chatArgument: "a chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("image command test must not connect")
    },
    services: (base) => ({ pictures: { ...base.pictures, embed } }),
  }
  const call = async (argv: string[], tty = false) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      { app, commands: () => [imagesCommand(messenger)] },
      {
        streams,
        tty,
        env: {
          ...process.env,
          CHAT_PROFILE: "synthetic",
          CHAT_STATE_DIR: join(root, "state"),
          CHAT_CONFIG_DIR: join(root, "config"),
          MESSAGING_STORE: join(root, "store.db"),
          NO_COLOR: "1",
        },
      },
    )
    return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }
  return { call, embed }
}

describe("images embed CLI", () => {
  it("passes explicit scope and limit to the service, emits JSON and cancels its tracked work", async () => {
    const { call, embed } = fixture()
    const answer = await call(["images", "embed", "--chat", "7", "--limit", "3", "--json"])
    expect(answer.code).toBe(0)
    expect(JSON.parse(answer.stdout)).toMatchObject({ item: { embedded: 2, skipped: 1, failed: 1, more: true } })
    expect(embed).toHaveBeenCalledOnce()
    expect(embed.mock.calls[0]?.[0]).toMatchObject({ chat: "7", limit: 3 })
    expect(embed.mock.calls[0]?.[0].signal?.aborted).toBe(true)
  })

  it("renders progress and continuation in pretty output with the default batch bound", async () => {
    const { call, embed } = fixture()
    const answer = await call(["images", "embed"], true)
    expect(answer.code).toBe(0)
    expect(answer.stdout).toContain("2 pictures embedded with synthetic-model, 1 not readable, 1 failed")
    expect(answer.stderr).toContain("more pictures are left")
    expect(embed.mock.calls[0]?.[0].limit).toBe(100)
    expect(embed.mock.calls[0]?.[0]).not.toHaveProperty("chat")
  })

  it("refuses read-only mutations and invalid limits before invoking the service", async () => {
    const { call, embed } = fixture()
    expect((await call(["--read-only", "images", "embed", "--json"])).code).not.toBe(0)
    expect((await call(["images", "embed", "--limit", "0", "--json"])).code).not.toBe(0)
    expect(embed).not.toHaveBeenCalled()
  })
})
