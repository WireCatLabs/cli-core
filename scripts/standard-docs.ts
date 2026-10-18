/**
 * Writes STANDARD.md's vocabulary and lint-rule tables from cli-base's registries, between their markers.
 *
 *   pnpm standard:docs          write them
 *   node scripts/standard-docs.ts --check   fail when the page and the registries disagree (in docs:check)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { LINT_RULES, VOCABULARY } from "@wirecat/cli-base/standards/tables"
import { cell, withGenerated } from "./generated-blocks.ts"

const page = join(import.meta.dirname, "..", "docs/dev/STANDARD.md")
const text = readFileSync(page, "utf8")

const table = (header: string[], rows: string[][]) =>
  [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n")
const code = (word: string) => `\`${word}\``
const words = (list: string[] | undefined) => (list ?? []).map(code).join(", ")

const result = withGenerated(text, [
  [
    "verbs",
    table(
      ["Verb", "Meaning", "Not"],
      VOCABULARY.verbs.map((verb) => [code(verb.word), verb.meaning, words(verb.replaces)]),
    ),
  ],
  [
    "views",
    table(
      ["View", "Meaning"],
      VOCABULARY.views.map((view) => [code(view.word), view.meaning]),
    ),
  ],
  [
    "resources",
    table(
      ["Resource", "Kind", "Meaning", "Not"],
      VOCABULARY.nouns.map((noun) => [code(noun.word), noun.kind, noun.meaning, words(noun.replaces)]),
    ),
  ],
  [
    "root words",
    table(
      ["Root word", "Meaning"],
      VOCABULARY.roots.map((root) => [code(root.word), root.meaning]),
    ),
  ],
  [
    "flags",
    table(
      ["Flag", "Value", "Kind", "Meaning", "Unit"],
      VOCABULARY.flags.map((flag) => [
        code(flag.name),
        flag.value ? code(flag.value) : "",
        flag.type,
        flag.meaning,
        flag.unit ?? "",
      ]),
    ),
  ],
  [
    "lint rules",
    table(
      ["Rule", "Severity", "Applies to", "Holds when"],
      LINT_RULES.map((rule) => [code(rule.id), rule.severity, rule.scope, rule.summary]),
    ),
  ],
])

if (process.argv.includes("--check")) {
  if (result !== text)
    throw new Error("STANDARD.md tables drift from @wirecat/cli-base/standards — run pnpm standard:docs")
} else writeFileSync(page, result)
