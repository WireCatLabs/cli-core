import { readFileSync } from "node:fs"
import { Ajv } from "ajv"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { setupProblems } from "./define.js"
import { setupDocumentSchema, setupJsonSchema } from "./document.js"

const EXAMPLES = ["pbx", "oauth-or-token", "tg"] as const
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/setup-v1/${name}.json`, import.meta.url), "utf8"))
const ajv = new Ajv({ allErrors: true, strict: false })
const desktopAccepts = ajv.compile(setupJsonSchema())

type Node = Record<string | number, unknown>

/** The example with one value set (or pushed, for a list) at a path of keys. */
const changed = (name: string, path: (string | number)[], value: unknown, push = false) => {
  const copy = read(name)
  const parent = path.slice(0, -1).reduce<Node>((at, key) => at[key] as Node, copy)
  const last = path.at(-1) as string | number
  if (push) (parent[last] as unknown[]).push(value)
  else parent[last] = value
  return copy
}

describe("the v1 setup format, as the shared fixture states it", () => {
  // Desktop copies this folder with its sha and checks every description against schema.json; `vitest -u` rewrites it.
  it("**the JSON Schema in the fixture is the one the valibot schema gives**", async () => {
    await expect(`${JSON.stringify(setupJsonSchema(), null, 2)}\n`).toMatchFileSnapshot(
      "../../test/fixtures/setup-v1/schema.json",
    )
  })

  it.each(EXAMPLES)("**%s is a whole, valid document** for valibot and for the JSON Schema alike", (name) => {
    const document = read(name)
    expect(setupProblems(document)).toEqual([])
    expect(desktopAccepts(document), JSON.stringify(desktopAccepts.errors)).toBe(true)
  })

  it("**a block type from a newer format passes with its fallback**; a known type written wrongly passes neither", () => {
    const newer = changed(
      "pbx",
      ["steps", "source", "blocks"],
      { type: "diagram", nodes: [], fallback: "source.intro" },
      true,
    )
    expect(v.safeParse(setupDocumentSchema, newer).success).toBe(true)
    expect(desktopAccepts(newer)).toBe(true)
    expect(setupProblems(newer, { v1: true })).toContain(
      "steps.source.blocks (diagram): diagram is no block type of v1",
    )

    const broken = changed("pbx", ["steps", "source", "blocks"], { type: "input", id: "x", label: 3 }, true)
    expect(v.safeParse(setupDocumentSchema, broken).success).toBe(false)
    expect(desktopAccepts(broken)).toBe(false)
  })

  it("**conditions are closed**, while other objects take unknown keys", () => {
    const extraKey = changed("pbx", ["steps", "source", "next", 0, "when", "or"], "csv")
    expect(v.safeParse(setupDocumentSchema, extraKey).success).toBe(false)
    expect(desktopAccepts(extraKey)).toBe(false)
    const looseStep = changed("pbx", ["steps", "source", "x-hint"], true)
    expect(desktopAccepts(looseStep)).toBe(true)
  })

  it.each([
    ["an SVG", "setup/logo.svg"],
    ["a path out of the package", "setup/../../secret.png"],
    ["an absolute path", "/etc/hosts.png"],
  ])("**an asset file that is %s is refused**", (_, file) => {
    const pbx = changed("pbx", ["assets", "freepbx-cdr", "file"], file)
    expect(v.safeParse(setupDocumentSchema, pbx).success).toBe(false)
    expect(desktopAccepts(pbx)).toBe(false)
  })

  it("**a link is https only**", () => {
    const pbx = changed("pbx", ["steps", "check-failed", "blocks", 1, "href"], "javascript:alert(1)")
    expect(desktopAccepts(pbx)).toBe(false)
  })
})
