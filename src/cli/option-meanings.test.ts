import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describeProgram, flatten } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import { sharedProgram } from "../testing/shared-program.js"
import { createProgram, run } from "./program.js"

const cases = [
  ["conversations", "build", "--analysis-provider", "openai", "--provider", "openai"],
  ["conversations", "embed", "--embedding-provider", "local", "--provider", "local"],
  ["conversations", "consents", "revoke", "--consent-provider", "synthetic", "--provider", "synthetic"],
  ["conversations", "links", "clear", "--chat", "7", "--answer-model", "synthetic", "--model", "synthetic"],
  ["tags", "remove", "synthetic", "--chat", "7", "--claim", "manual", "--source", "auto"],
  ["inbox", "kind:group", "--kind", "channel"],
  ["review", "kind:group", "--kind", "channel"],
]

describe("renamed option meanings", () => {
  it.each(cases)("refuses conflicting spellings before any store or provider work: %j", async (...argv) => {
    const root = mkdtempSync(join(tmpdir(), "option-meanings-"))
    const env = {
      CHAT_PROFILE: "default",
      CHAT_CONFIG_DIR: join(root, "config"),
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CACHE_DIR: join(root, "cache"),
      MESSAGING_STORE: join(root, "store.sqlite"),
    }
    const streams = captureStreams()
    expect(await run([...argv, "--json"], sharedProgram, { streams, tty: false, env })).toBe(2)
    expect(streams.stdout).toEqual([])
    const error = JSON.parse(streams.stderr.at(-1) ?? "{}").error
    expect(error.code).toBe("validation_error")
    expect(error.message).toMatch(/cannot be used|not both/)
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
  })

  it("advertises the distinct meanings and hides their compatibility spellings", () => {
    const commands = flatten(describeProgram(createProgram(sharedProgram)))
    for (const [path, canonical, legacy] of [
      ["conversations build", "--analysis-provider", "--provider"],
      ["conversations embed", "--embedding-provider", "--provider"],
      ["conversations consents revoke", "--consent-provider", "--provider"],
      ["conversations links clear", "--answer-model", "--model"],
      ["tags remove", "--claim", "--source"],
      ["replies edit", "--template-mode", "--model"],
    ]) {
      const flags = commands.find((one) => one.path.join(" ") === path)?.options.map(({ flags }) => flags)
      expect(
        flags?.some((flag) => flag.startsWith(`${canonical} `)),
        path,
      ).toBe(true)
      expect(
        flags?.some((flag) => flag.startsWith(`${legacy} `)),
        path,
      ).toBe(false)
    }
  })
})
