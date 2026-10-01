import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { withoutCode } from "./markdown.js"

/** The pages every tool has — the shared page set in cli-docs' STRUCTURE.md. */
export const REQUIRED_PAGES = [
  "index",
  "installation",
  "usage",
  "commands",
  "configuration",
  "troubleshooting",
  "security",
] as const

// Fumadocs' own keys (fumadocs.dev/docs/page-conventions); the portal reads meta.json as it is.
const META_KEYS = new Set(["title", "icon", "pages", "defaultOpen", "collapsible", "pagesIndex", "root"])

export type StructureRules = {
  /** The docs folder, relative to `root`. */
  docs?: string
  required?: readonly string[]
  /** Pages in `meta.json` that are not files in the folder: `changelog` comes from the root. */
  external?: readonly string[]
}

/**
 * The docs folder against its `meta.json`: every listed page exists, every page is listed once,
 * the required ones are there, and each page has exactly one `# heading`, its title. `README.md`
 * is the contributors' index and stays out of the sidebar.
 */
export const structureProblems = (
  root: string,
  { docs = "docs", required = REQUIRED_PAGES, external = ["changelog"] }: StructureRules = {},
) => {
  const folder = join(root, docs)
  const metaPath = join(folder, "meta.json")
  if (!existsSync(metaPath)) return [`${docs}/meta.json: missing — it lists the pages in sidebar order`]

  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>
  } catch (error) {
    return [`${docs}/meta.json: not JSON — ${(error as Error).message}`]
  }

  const problems: string[] = []
  for (const key of Object.keys(meta))
    if (!META_KEYS.has(key)) problems.push(`${docs}/meta.json: "${key}" is not a Fumadocs key`)
  const listed = Array.isArray(meta.pages) ? meta.pages.filter((page): page is string => typeof page === "string") : []
  if (!Array.isArray(meta.pages)) problems.push(`${docs}/meta.json: "pages" must be a list`)

  const pages = listed.filter((page) => !/^---.*---$/.test(page) && !/^\[.*\]\(.*\)$/.test(page))
  const seen = new Set<string>()
  for (const page of pages) {
    if (seen.has(page)) problems.push(`${docs}/meta.json: "${page}" is listed twice`)
    seen.add(page)
    if (external.includes(page)) continue
    if (!existsSync(join(folder, `${page}.md`))) problems.push(`${docs}/meta.json: "${page}" — no ${docs}/${page}.md`)
  }
  for (const page of required)
    if (!seen.has(page)) problems.push(`${docs}/meta.json: "${page}" is required and not listed`)

  const files = readdirSync(folder).filter((name) => name.endsWith(".md") && name !== "README.md")
  for (const file of files) {
    const page = file.slice(0, -3)
    if (!seen.has(page))
      problems.push(`${docs}/${file}: not in meta.json — listed nowhere, so the portal never shows it`)
    const text = readFileSync(join(folder, file), "utf8")
    const titles = withoutCode(text)
      .split("\n")
      .filter((line) => /^# /.test(line)).length
    if (titles !== 1) problems.push(`${docs}/${file}: ${titles} "# " headings — a page has exactly one, its title`)
    const first = text
      .replace(/^(\s*<!--[\s\S]*?-->)*/, "")
      .split("\n")
      .find((line) => line.trim() !== "")
    if (titles === 1 && !first?.startsWith("# ")) problems.push(`${docs}/${file}: the "# " heading must come first`)
  }
  return problems
}
