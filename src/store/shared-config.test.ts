import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_TASK_CATEGORIES } from "../domain/task-categories.js"
import { storePath } from "./path.js"
import {
  applyTaskCategoryEdits,
  editsFrom,
  readTaskCategoryEdits,
  sharedConfigPath,
  writeTaskCategoryEdits,
} from "./shared-config.js"

const folder = () => mkdtempSync(join(tmpdir(), "shared-config-"))
const names = (list: readonly { name: string }[]) => list.map(({ name }) => name)

describe("sharedConfigPath", () => {
  it("is the WireCat config folder for the default store, the store's own folder for a moved one", () => {
    const env = { HOME: "/home/alice", XDG_CONFIG_HOME: "/home/alice/.config", XDG_DATA_HOME: "/home/alice/.data" }
    expect(sharedConfigPath(storePath(env), env)).toBe("/home/alice/.config/WireCat/config.json")
    expect(sharedConfigPath("/tmp/run/m.db", { ...env, MESSAGING_STORE: "/tmp/run/m.db" })).toBe("/tmp/run/config.json")
    expect(sharedConfigPath("/tmp/run/m.db", { ...env, WIRECAT_CONFIG_DIR: "/etc/wirecat" })).toBe(
      "/etc/wirecat/config.json",
    )
  })

  it("**never points a test at the owner's real file**", () => {
    const path = sharedConfigPath(storePath(process.env), process.env)
    expect(path.startsWith(join(userInfo().homedir, ".config"))).toBe(false)
  })
})

describe("task category edits", () => {
  it("adds before other, replaces, and drops a default; dropping an unknown name is a no-op", () => {
    const list = applyTaskCategoryEdits(
      DEFAULT_TASK_CATEGORIES,
      { garden: "plants | seedling, es:planta", pets: "animals | dog", religion: null, unheard: null },
      "f.json",
    )
    expect(names(list).slice(-2)).toEqual(["garden", "other"])
    expect(names(list)).not.toContain("religion")
    expect(list.find(({ name }) => name === "pets")).toMatchObject({ meaning: "animals", triggers: { en: ["dog"] } })
  })

  it("refuses to drop other, naming the file", () => {
    expect(() => applyTaskCategoryEdits(DEFAULT_TASK_CATEGORIES, { other: null }, "/x/config.json")).toThrow(
      /\/x\/config\.json: other stays/,
    )
  })

  it("names the file when it is not JSON or the section has the wrong shape; a missing file has no edits", () => {
    const dir = folder()
    const file = join(dir, "config.json")
    expect(readTaskCategoryEdits(file)).toBeUndefined()
    writeFileSync(file, "{ task_categories: ")
    expect(() => readTaskCategoryEdits(file)).toThrow(new RegExp(`${file} is not valid JSON`))
    writeFileSync(file, JSON.stringify({ task_categories: { garden: 3 } }))
    expect(() => readTaskCategoryEdits(file)).toThrow(/task_categories\.garden takes/)
  })

  it("writes the section and keeps every other key; no edits drops the section", () => {
    const file = join(folder(), "config.json")
    writeFileSync(file, JSON.stringify({ theme: "dark" }))
    writeTaskCategoryEdits(file, { garden: "plants | seedling" })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      theme: "dark",
      task_categories: { garden: "plants | seedling" },
    })
    writeTaskCategoryEdits(file, undefined)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "dark" })
  })

  it("turns a list an older build saved into edits that give the same list back", () => {
    const saved = applyTaskCategoryEdits(DEFAULT_TASK_CATEGORIES, { garden: "plants | seedling", food: null }, "f")
    const edits = editsFrom(saved)
    expect(edits).toEqual({ food: null, garden: "plants | en:seedling" })
    expect(names(applyTaskCategoryEdits(DEFAULT_TASK_CATEGORIES, edits, "f"))).toEqual(names(saved))
  })
})
