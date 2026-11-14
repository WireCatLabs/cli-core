import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { addMeetingCommands } from "../meetings/cli/index.js"
import type { TranscriptLanguageFill } from "../meetings/index.js"
import { memoryMeetingStore } from "../meetings/testing/index.js"
import type { AppIdentity } from "../ports/app.js"
import { readHarderSetting, readHarderTimeout } from "../services/search-harder.js"
import { inCommandRun } from "./context.js"
import { modelCatalogueCommand } from "./model-catalogue-command.js"
import { type ProgramDefinition, run } from "./program.js"
import { settingsFor } from "./settings.js"

const app: AppIdentity = {
  command: "shadow",
  appName: "shadow-cli",
  envPrefix: "SHADOW",
  description: "synthetic",
  version: "1.0.0",
  messenger: false,
}

const folder = () => {
  const home = mkdtempSync(join(tmpdir(), "root-shadowed-"))
  return {
    HOME: home,
    XDG_DATA_HOME: home,
    XDG_STATE_HOME: home,
    WIRECAT_STATE_DIR: home,
    MESSAGING_STORE: join(home, "store.db"),
    SHADOW_CONFIG_DIR: join(home, "config"),
  }
}

// The root program declares --yes and --timeout too, and commander gives a flag both declare to the root.
describe("an option a command and the root program both declare", () => {
  it("**`meetings repair --yes` stores what it found**, not only a preview", async () => {
    const asked: boolean[] = []
    const store = {
      ...memoryMeetingStore(),
      fillTranscriptLanguages: async ({ accountId, apply }: { accountId: number; apply: boolean }) => {
        asked.push(apply)
        return { accountId, applied: apply, transcripts: 0, languages: [] } satisfies TranscriptLanguageFill
      },
    }
    const definition: ProgramDefinition = {
      app,
      configuration: settingsFor(app),
      commands: () => {
        const root = new Command(app.command)
        addMeetingCommands(root, { store, accountId: 1, write: () => undefined, inRun: inCommandRun })
        return [...root.commands]
      },
    }
    const env = folder()

    expect(await run(["work", "meetings", "repair", "--yes"], definition, { streams: captureStreams(), env })).toBe(0)
    expect(await run(["work", "meetings", "repair"], definition, { streams: captureStreams(), env })).toBe(0)

    expect(asked).toEqual([true, false])
  })

  it("**`models search-consents set --yes --timeout 2m` allows it and keeps the wait**, parsed by its own option", async () => {
    const env: NodeJS.ProcessEnv = folder()
    const definition: ProgramDefinition = {
      app,
      commands: () => [
        modelCatalogueCommand(app, {
          kinds: ["text"],
          enrichment: true,
          env: () => env,
          keyring: memoryKeyring(),
          output: () => undefined,
          diagnostic: () => undefined,
        }),
      ],
    }
    const argv = ["models", "search-consents", "set", "anthropic", "--yes", "--timeout", "2m"]

    expect(await run(argv, definition, { streams: captureStreams(), env })).toBe(0)

    expect(readHarderSetting(env)?.provider).toBe("anthropic")
    expect(readHarderTimeout(env)).toBe(120)
  })
})
