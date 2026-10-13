import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { expect, it, vi } from "vitest"
import { fakeAdapter } from "../../kit/fake.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { type Messenger, messengerContext } from "./context.js"

it("parallel service calls share initialization and close their connection once", async () => {
  const root = mkdtempSync(join(tmpdir(), "messenger-lifecycle-"))
  const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "1.0.0" }
  const adapter = fakeAdapter()
  const close = vi.fn(async () => {})
  const connect = vi.fn(async () => ({ ...adapter, close }))
  const messenger: Messenger = {
    app,
    provider: "chat",
    chatArgument: "a chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
  }
  let calls = 0
  const code = await run(
    ["probe"],
    {
      app,
      commands: () => [
        new Command("probe").action(async function (this: Command) {
          await messengerContext(this, messenger).withServices(async (_services, connected) => {
            if (!connected) throw new Error("missing read connection")
            await Promise.all(
              [1, 2].map(() =>
                connected(async (held) => {
                  await held.me()
                  calls++
                }),
              ),
            )
          })
        }),
      ],
    },
    {
      streams: captureStreams(),
      tty: false,
      env: {
        CHAT_PROFILE: "default",
        CHAT_STATE_DIR: join(root, "state"),
        CHAT_CONFIG_DIR: join(root, "config"),
        MESSAGING_STORE: join(root, "messages.db"),
      },
    },
  )
  expect(code).toBe(0)
  expect(calls).toBe(2)
  expect(connect).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
})
