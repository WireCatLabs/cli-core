import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PRESETS } from "../dist/search/lucene/presets.js"
import { QUERY_FIELDS, QUERY_OPERATORS } from "../dist/search/lucene/registry.js"
import { QUERY_LIMITS } from "../dist/search/lucene/types.js"
import { withGenerated } from "./generated-blocks.ts"

const root = join(import.meta.dirname, "..")
const guide = join(root, "docs/search/query-language.md")
const text = readFileSync(guide, "utf8")
const fields = [
  "| Поле | Тип | Значения / нормализация | Пример | Поддержка |",
  "|---|---|---|---|---|",
  ...QUERY_FIELDS.map(
    (field) =>
      `| \`${field.name}\` | ${field.type} | ${"values" in field ? field.values.join(", ") : field.normalization} | \`${field.example}\` | ${field.operators.join(", ")} |`,
  ),
].join("\n")
const operators = [
  "| Оператор | Пример | Семантика / поддержка |",
  "|---|---|---|",
  ...QUERY_OPERATORS.map(
    (entry) =>
      `| ${entry.name.replaceAll("|", "\\|")} | \`${entry.example.replaceAll("|", "\\|")}\` | ${entry.semantics.replaceAll("|", "\\|")} |`,
  ),
].join("\n")
const presets = [
  "| Preset | Что считается кандидатом (version 1) |",
  "|---|---|",
  ...Object.entries(PRESETS).map(([name, entry]) => `| \`${name}\` | ${entry.explanation} |`),
].join("\n")
const limits = [
  "| Ограничение | Значение |",
  "|---|---|",
  ...Object.entries(QUERY_LIMITS).map(([name, value]) => `| \`${name}\` | ${value} |`),
].join("\n")
interface Recipe {
  title: string
  query: string
  ids: string[]
}
const recipes: { recipes: Recipe[] } = JSON.parse(readFileSync(join(root, "docs/search/recipes.json"), "utf8"))
const examples = recipes.recipes
  .map(
    (recipe) =>
      `### ${recipe.title}\n\n\`\`\`sh\ntg search messages '${recipe.query.replaceAll("'", "'\\''")}' --timezone UTC\n\`\`\`\n\nНа synthetic fixture: ${recipe.ids.length ? `ids ${recipe.ids.join(", ")}` : "ничего"}. В MAX замените первый аргумент \`tg\` на \`max\`.`,
  )
  .join("\n\n")
const result = withGenerated(text, [
  ["fields", fields],
  ["operators", operators],
  ["presets", presets],
  ["limits", limits],
  ["recipes", examples],
])
if (process.argv.includes("--check")) {
  if (result !== text) throw new Error("search reference drift — run pnpm search:docs")
} else writeFileSync(guide, result)
