import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openStore } from "../store/store.js"
import { askSetupQuestions, asksAtStart, type FirstRun, systemLanguage } from "./first-run.js"
import { permissionCeiling, readSetupAnswers, writeSetupAnswers } from "./setup-answers.js"

const place = () => {
  const folder = mkdtempSync(join(tmpdir(), "first-run-"))
  return { MESSAGING_STORE: join(folder, "wirecat.db"), WIRECAT_CONFIG_DIR: folder, LANG: "es_ES.UTF-8" }
}

const run = (env: NodeJS.ProcessEnv, answers: string[], extra: Partial<FirstRun> = {}) => {
  const said: string[] = []
  const installs: string[][] = []
  const done = askSetupQuestions({
    command: "tg",
    env,
    io: { ask: async () => answers.shift() ?? "", say: (text) => said.push(text) },
    installed: (command) => command === "max",
    installer: "npm",
    install: (argv) => installs.push(argv) > 0,
    ...extra,
  })
  return { done, said, installs }
}

const stemmers = async (env: NodeJS.ProcessEnv) => {
  const store = await openStore({ env })
  try {
    return await store.searchIndex.stemmers()
  } finally {
    await store.close()
  }
}

describe("the questions every WireCat tool shares", () => {
  it("**ticks English and the system's language on a new store**, and asks each question once for every tool", async () => {
    const env = place()
    const first = run(env, ["", "", ""])
    expect(await first.done).toEqual(["languages", "tools", "permissions"])
    expect(first.said).toContain("  2. English ✓")
    expect(first.said).toContain("  3. Spanish ✓")
    expect(await stemmers(env)).toEqual({ cyrillic: "none", latin: "english,spanish" })
    expect(readSetupAnswers(join(env.WIRECAT_CONFIG_DIR, "config.json"))).toEqual({
      languages: true,
      tools: true,
      permissions: "allow",
    })
    expect(await run(env, []).done).toEqual([])
  })

  it("**keeps a store's languages on Enter** once it is in use", async () => {
    const env = place()
    const store = await openStore({ env })
    await store.searchIndex.saveStemmers({ cyrillic: "russian", latin: "english,spanish" })
    await store.close()
    const asked = run(env, ["", "", ""])
    await asked.done
    expect(asked.said).toContain("  1. Russian ✓")
    expect(await stemmers(env)).toEqual({ cyrillic: "russian", latin: "english,spanish" })
    expect(asked.said.join("\n")).not.toMatch(/reindex/)
  })

  it("installs only the tools picked, with this tool's installer", async () => {
    const env = place()
    const asked = run(env, ["2", "1,3", ""])
    await asked.done
    expect(asked.said).toContain("  ✓  max — MAX in the same local store: search, review and tasks offline")
    expect(asked.said).toContain("  1. wa — WhatsApp in the same local store: search, review and tasks offline")
    expect(asked.installs).toEqual([
      ["npm", "install", "-g", "@wirecat/whatsapp-cli@latest"],
      ["npm", "install", "-g", "@wirecat/drive-cli@latest"],
    ])
  })

  it("**writes the read-only answer**, which caps every tool", async () => {
    const env = place()
    await run(env, ["", "", "1"]).done
    const path = join(env.WIRECAT_CONFIG_DIR, "config.json")
    expect(readSetupAnswers(path).permissions).toBe("readonly")
    expect(permissionCeiling(path)).toBe("readonly")
  })

  it("asks a wrong number again, then keeps what was ticked", async () => {
    const env = place()
    const asked = run(env, ["7", "2", "", ""])
    await asked.done
    expect(asked.said).toContain("Choose numbers from 1 to 3, separated by commas.")
    expect(await stemmers(env)).toEqual({ cyrillic: "none", latin: "english" })
  })

  it("**changes a store in use only after the owner agrees to rebuild its word forms**", async () => {
    const env = place()
    const store = await openStore({ env })
    await store.searchIndex.saveStemmers({ cyrillic: "russian", latin: "english,spanish" })
    await store.close()
    await run(env, ["1", "n", "", ""]).done
    expect(await stemmers(env)).toEqual({ cyrillic: "russian", latin: "english,spanish" })
    await run(env, ["1", "y"], { all: true }).done
    expect(await stemmers(env)).toEqual({ cyrillic: "russian", latin: "none" })
  })

  it("**keeps everything read-only while the answers cannot be read**, and setup writes them again", async () => {
    const env = place()
    const path = join(env.WIRECAT_CONFIG_DIR, "config.json")
    writeFileSync(path, JSON.stringify({ setup: { permissions: "everything" } }))
    expect(permissionCeiling(path)).toBe("readonly")
    writeSetupAnswers(path, { permissions: "allow" })
    expect(permissionCeiling(path)).toBeUndefined()
  })
})

describe("asksAtStart", () => {
  const start = { headless: false, terminal: true, env: {}, readOnlyLock: undefined, path: ["chats", "list"] }

  it("asks a person at a terminal, before any command but help, the store and the servers", () => {
    expect(asksAtStart(start)).toBe(true)
    expect(asksAtStart({ ...start, path: ["setup"] })).toBe(true)
    for (const path of [["store", "restore"], ["mcp"], ["serve"], ["help"]])
      expect(asksAtStart({ ...start, path })).toBe(false)
  })

  it("**never asks an agent, a script or a process locked read-only**", () => {
    expect(asksAtStart({ ...start, env: { CLAUDECODE: "1" } })).toBe(false)
    expect(asksAtStart({ ...start, env: { AI_AGENT: "codex" } })).toBe(false)
    expect(asksAtStart({ ...start, headless: true })).toBe(false)
    expect(asksAtStart({ ...start, terminal: false })).toBe(false)
    expect(asksAtStart({ ...start, readOnlyLock: "TG_READ_ONLY" })).toBe(false)
  })
})

describe("systemLanguage", () => {
  it("reads the first locale variable set, past C and POSIX", () => {
    expect(systemLanguage({ LC_ALL: "", LC_MESSAGES: "C", LANG: "ru_RU.UTF-8" })).toBe("ru")
    expect(systemLanguage({ LANGUAGE: "es:en" })).toBe("es")
  })
})
