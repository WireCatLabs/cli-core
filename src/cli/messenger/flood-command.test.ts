import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { expect, it } from "vitest"
import { FloodMemory } from "../../sends/flood.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { floodCommand } from "./flood-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  name: "Chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("flood clear never connects")
  },
  chatArgument: "a chat",
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, tty = false) => {
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [floodCommand(messenger)] }, { streams, tty, env })
  return { code, stdout: streams.stdout.join("\n") }
}

it("**flood clear forgets the profile's waits and lifts its hold, says what it cleared, and never connects**", async () => {
  const env = { CHAT_STATE_DIR: mkdtempSync(join(tmpdir(), "flood-clear-")) }
  const memory = new FloodMemory(join(env.CHAT_STATE_DIR, "flood", "work.json"))
  memory.remember({ operation: "history", chatId: "42", waitMs: 600_000 })
  memory.block({ state: "limited", hint: "spam" })
  const other = new FloodMemory(join(env.CHAT_STATE_DIR, "flood", "default.json"))
  other.remember({ operation: "send", waitMs: 600_000 })

  const text = await call(["work", "flood", "clear"], env, true)
  expect(text.code).toBe(0)
  expect(text.stdout).toMatch(
    /^Cleared for profile work:\n- the hold on writes \(limited\), until .+\n- the wait before history in chat 42, until .+$/,
  )
  expect(memory.read()).toEqual({ deadlines: [] })
  expect(other.read().deadlines).toHaveLength(1)

  const json = await call(["work", "flood", "clear", "--json"], env)
  expect(JSON.parse(json.stdout).item).toEqual({ profile: "work", cleared: { deadlines: [], send_block: null } })
  expect((await call(["work", "flood", "clear"], env, true)).stdout).toBe("Nothing to clear for profile work.")
})
