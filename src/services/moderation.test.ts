import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { rememberAccount } from "../cli/messenger/accounts.js"
import { ModerationRules, moderationPathFor } from "../moderation/rules.js"
import type { ServiceDeps } from "./deps.js"
import { moderationService } from "./moderation.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "0" }

const depsWith = (profile?: string) => {
  const env = { CHAT_STATE_DIR: mkdtempSync(join(tmpdir(), "moderation-")) }
  const connection = async () => ({ resolve: async () => ({ id: "7", title: "Synthetic group" }) })
  return {
    env,
    deps: {
      messenger: { app, provider: "chat" },
      offline: false,
      env,
      connection,
      ...(profile === undefined ? {} : { profile }),
    } as unknown as ServiceDeps,
  }
}

describe("moderation rules", () => {
  it("keeps the rules of the profile named", async () => {
    const { deps, env } = depsWith("work")
    expect((await moderationService(deps).rules("7")).file).toBe(moderationPathFor(app, "work", env))
  })

  it("never falls back to a default profile, and names the profiles here", async () => {
    const { deps, env } = depsWith()
    await expect(moderationService(deps).rules("7")).rejects.toThrow(
      "name a profile: moderation rules are kept per profile — there is none on this computer yet",
    )
    rememberAccount(app, "personal", "500", env)
    new ModerationRules(moderationPathFor(app, "work", env)).set("7", "Synthetic group", "flood.messages", "5")
    await expect(moderationService(deps).set("7", "flood.messages", "3")).rejects.toThrow(
      "profiles here: personal, work",
    )
  })
})
