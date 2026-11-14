import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_TASK_CATEGORIES } from "../domain/task-categories.js"
import { storePath } from "./path.js"
import {
  applyTaskCategoryEdits,
  editsFrom,
  readSharedSection,
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

describe("a shared config with a slip in its JSON (owner, 2026-11-14)", () => {
  const broken = (text: string) => {
    const dir = folder()
    const file = join(dir, "config.json")
    writeFileSync(file, text)
    const backups = () => readdirSync(dir).filter((name) => name.startsWith("config.json.bak-"))
    return { dir, file, backups }
  }

  it.each([
    ["a byte-order mark", '\uFEFF{"setup": {"permissions": "allow"}}'],
    ["a trailing comma", '{\n  "setup": {"permissions": "allow",},\n}'],
    ["a // comment", '{\n  // chosen at setup\n  "setup": {"permissions": "allow"}\n}'],
    ["a /* */ comment", '{\n  /* chosen\n     at setup */\n  "setup": {"permissions": "allow"}\n}'],
    ["Windows line ends and a trailing comma", '{\r\n  "setup": {"permissions": "allow"},\r\n}\r\n'],
    ["a missing comma between two lines", '{\n  "setup": {"permissions": "allow"}\n  "theme": "dark"\n}'],
  ])("**mends %s**: reads the file, writes it back as JSON and keeps the old one beside it", (_, text) => {
    const { file, dir, backups } = broken(text)

    expect(readSharedSection(file, "setup")).toEqual({ permissions: "allow" })

    expect(JSON.parse(readFileSync(file, "utf8")).setup).toEqual({ permissions: "allow" })
    expect(backups()).toHaveLength(1)
    expect(readFileSync(join(dir, backups()[0] as string), "utf8")).toBe(text)
  })

  it("keeps every key when it mends one", () => {
    const { file } = broken('{\n  "setup": {"permissions": "readonly"}\n  "theme": "dark",\n}')
    expect(readSharedSection(file, "setup")).toEqual({ permissions: "readonly" })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ setup: { permissions: "readonly" }, theme: "dark" })
  })

  it("leaves a valid file with Windows line ends as it is", () => {
    const text = '{\r\n  "setup": {"permissions": "allow"}\r\n}\r\n'
    const { file, backups } = broken(text)
    expect(readSharedSection(file, "setup")).toEqual({ permissions: "allow" })
    expect(readFileSync(file, "utf8")).toBe(text)
    expect(backups()).toEqual([])
  })

  it.each([
    [
      "two entries on one line",
      '{\n  "setup": {\n    "languages": ["en"],\n    "tools": true "permissions": "allow"\n  }\n}',
      /line 4, column 19: two entries on one line .*likely fix: add a comma after `"tools": true` on line 4/,
    ],
    [
      "a key without quotes",
      '{\n  setup: {"permissions": "allow"}\n}',
      /line 2 has a key without double quotes.*line 2/,
    ],
    ["a file cut short", '{"setup": {"permissions": "allow"', /add the closing \} or \]/],
  ])("**refuses %s** with the line and the likely fix, and changes nothing", (_, text, why) => {
    const { file, backups } = broken(text)
    expect(() => readSharedSection(file, "setup")).toThrow(
      expect.objectContaining({ code: "configuration_error", message: expect.stringMatching(why) }),
    )
    expect(readFileSync(file, "utf8")).toBe(text)
    expect(backups()).toEqual([])
  })

  it.each([
    ["in double quotes", '{\n  "token": "sk-secret-1" "setup": {}\n}', /add a comma after `"token": "…"` on line 2/],
    ["in single quotes", '{\n  "token": \'sk-secret-1\',\n  "pin": 4321\n}', /use double quotes .* line 2/],
    ["with no quotes", '{\n  "token": sk-secret-1,\n  "pin": 4321\n}', /put the value on line 2 in double quotes/],
  ])("**never shows a value %s** in the refusal: it may be a secret", (_, text, fix) => {
    const { file } = broken(text)
    for (const secret of ["sk-secret-1", "4321"])
      expect(() => readSharedSection(file, "setup")).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(secret) }),
      )
    expect(() => readSharedSection(file, "setup")).toThrow(fix)
  })

  it("names a key written twice, which JSON alone would let the last one win", () => {
    const { file } = broken('{"setup": {}, "setup": {"permissions": "allow"},}')
    expect(() => readSharedSection(file, "setup")).toThrow(/keep one of the two keys named on line 1/)
  })

  it("counts the column from the text a person sees, after a byte-order mark", () => {
    const { file } = broken('\uFEFF{"tools": true "setup": {}}')
    expect(() => readSharedSection(file, "setup")).toThrow(/line 1, column 16: .*add a comma after `"tools": true`/)
  })
})
