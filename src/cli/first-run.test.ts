import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openStore } from "../store/store.js"
import { askSetupQuestions, type FirstRun, systemLanguage } from "./first-run.js"
import { readSetupAnswers } from "./setup-answers.js"

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
    expect(asked.said).toContain("  ✓ max — MAX in the same local store: search, review and tasks offline")
    expect(asked.installs).toEqual([
      ["npm", "install", "-g", "@wirecat/whatsapp-cli@latest"],
      ["npm", "install", "-g", "@wirecat/drive-cli@latest"],
    ])
  })

  it("**writes the read-only answer**, and does not ask it while the process is locked read-only", async () => {
    const env = place()
    await run(env, ["", "", "1"]).done
    expect(readSetupAnswers(join(env.WIRECAT_CONFIG_DIR, "config.json")).permissions).toBe("readonly")
    const locked = place()
    expect(await run(locked, ["", ""], { readOnlyLock: "TG_READ_ONLY" }).done).toEqual(["languages", "tools"])
  })

  it("refuses a number outside the list", async () => {
    await expect(run(place(), ["7"]).done).rejects.toThrow(/numbers from 1 to 3/)
  })
})

describe("systemLanguage", () => {
  it("reads the first locale variable set, past C and POSIX", () => {
    expect(systemLanguage({ LC_ALL: "", LC_MESSAGES: "C", LANG: "ru_RU.UTF-8" })).toBe("ru")
    expect(systemLanguage({ LANGUAGE: "es:en" })).toBe("es")
  })
})
