import { readFileSync } from "node:fs"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { validateSkill } from "./validate.js"

const source = (front = "name: fixture\ndescription: A focused synthetic skill", body = "") =>
  `---\n${front}\n---\n${body}`

describe("portable skill validation", () => {
  it("reads folded YAML and rejects malformed continuation, duplicate keys and nonobjects", () => {
    expect(validateSkill(source("name: fixture\ndescription: >-\n  A focused\n  synthetic skill"))).toEqual([])
    for (const front of [
      "name: fixture\ndescription: first\nsecond",
      "name: one\nname: two\ndescription: test",
      "- name",
      "null",
    ])
      expect(validateSkill(source(front))).not.toEqual([])
    expect(validateSkill("no frontmatter")).not.toEqual([])
  })
  it("checks naming, lengths, supported fields and emitted version", () => {
    expect(
      validateSkill(source("name: fixture\ndescription: test\nmetadata:\n  version: '1.2.3'"), {
        folder: "fixture",
        version: "1.2.3",
      }),
    ).toEqual([])
    for (const front of [
      "name: Bad--Name\ndescription: test",
      `name: fixture\ndescription: '${"x".repeat(1025)}'`,
      "name: fixture\ndescription: ''",
      "name: fixture\ndescription: test\nversion: 1",
      "name: fixture\ndescription: test\nmetadata:\n  version: 123",
      "name: fixture\ndescription: test\ncompatibility: 123",
    ])
      expect(validateSkill(source(front))).not.toEqual([])
    expect(validateSkill(source(), { folder: "other", version: "1.2.3" })).toHaveLength(2)
  })
  it("accepts OpenClaw's declarations as a mapping at metadata.openclaw, and only there", () => {
    const openclaw =
      "metadata:\n  version: '1.2.3'\n  openclaw:\n    requires:\n      bins: [fixture]\n    install:\n" +
      "      - kind: node\n        package: '@wirecat/fixture'\n        bins: [fixture]"
    expect(validateSkill(source(`name: fixture\ndescription: test\n${openclaw}`), { version: "1.2.3" })).toEqual([])
    for (const metadata of ["  author: [a]", "  openclaw: []", "  openclaw: '{}'", "  openclaw: null"])
      expect(validateSkill(source(`name: fixture\ndescription: test\nmetadata:\n${metadata}`))).not.toEqual([])
  })
  it("checks local references and real command paths without executing examples", () => {
    const root = new Command("fixture").addCommand(
      new Command("stats").addCommand(new Command("messages").addCommand(new Command("show").argument("[text]"))),
    )
    expect(validateSkill(source(undefined, "`fixture stats messages show synthetic`"), { program: root })).toEqual([])
    expect(
      validateSkill(source(undefined, "```sh\nfixture personal stats messages show --json\n```"), { program: root }),
    ).toEqual([])
    expect(validateSkill(source(undefined, "`fixture stats absent`"), { program: root })).toEqual([
      "unknown skill command path: fixture stats absent",
    ])
    expect(validateSkill(source(undefined, "`fixture absent`"), { program: root })).not.toEqual([])
    expect(validateSkill(source(undefined, "[missing](references/absent.md)"), { file: import.meta.filename })).toEqual(
      ["missing skill reference: references/absent.md"],
    )
    expect(
      validateSkill(source(undefined, "[remote](https://example.test) [local](validate.ts)"), {
        file: import.meta.filename,
      }),
    ).toEqual([])
  })
  it("validates the task skill shipped by the shared package", () => {
    const file = new URL("../../skills/link-conversations/SKILL.md", import.meta.url)
    expect(validateSkill(readFileSync(file, "utf8"), { folder: "link-conversations", file: file.pathname })).toEqual([])
  })
})
