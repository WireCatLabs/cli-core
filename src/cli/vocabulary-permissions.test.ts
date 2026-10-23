import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { sharedProgram } from "../testing/shared-program.js"
import { run } from "./program.js"

const cases = [
  ["contacts.alias", ["contacts", "aliases", "set", "11", "Synthetic"]],
  ["tasks.plan", ["tasks", "update", "DOC-1", "--title", "Synthetic"]],
  ["metadata.refresh", ["metadata", "sync", "--chat", "7"]],
  ["tags.auto", ["tags", "rebuild"]],
] as const

describe("saved permission paths after command renames", () => {
  it.each(cases)("refuses moved path %s before the canonical command runs", async (permission, ...spellings) => {
    const root = mkdtempSync(join(tmpdir(), "vocabulary-permissions-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_CONFIG_DIR: join(root, "config"),
      CHAT_STATE_DIR: join(root, "state"),
      MESSAGING_STORE: join(root, "store.sqlite"),
    }
    mkdirSync(env.CHAT_CONFIG_DIR)
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { [permission]: "readonly" } } } }),
    )
    for (const argv of spellings) {
      const streams = captureStreams()
      expect(await run([...argv, "--json"], sharedProgram, { streams, tty: false, env })).toBe(3)
      expect(streams.stdout).toEqual([])
      expect(JSON.parse(streams.stderr.at(-1) ?? "{}").error.code).toBe("configuration_error")
      expect(streams.stderr.join("")).toContain(`rename permissions.${permission} to permissions.`)
      expect(existsSync(env.MESSAGING_STORE)).toBe(false)
    }
  })

  it.each(["tasks duplicates", "conversations embeddings", "models", "doctor reports"])(
    "a bare group reads no store: %s",
    async (path) => {
      const root = mkdtempSync(join(tmpdir(), "vocabulary-group-"))
      const env = {
        CHAT_PROFILE: "default",
        CHAT_CONFIG_DIR: join(root, "config"),
        CHAT_STATE_DIR: join(root, "state"),
        MESSAGING_STORE: join(root, "store.sqlite"),
      }
      const streams = captureStreams()
      expect(await run([...path.split(" "), "--json"], sharedProgram, { streams, tty: false, env })).toBe(2)
      expect(streams.stdout).toEqual([])
      expect(existsSync(env.MESSAGING_STORE)).toBe(false)
    },
  )
})
