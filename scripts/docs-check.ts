/**
 * Every relative link and anchor in every Markdown file resolves, and the changelog keeps its shape —
 * on every pull request, so a stale link fails the change that made it.
 *
 *   pnpm docs:check
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { changelogProblems, docsProblems, JOURNAL_IDS, markdownFiles } from "../dist/release/index.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const ids = [...JOURNAL_IDS, "CLI", "MAX", "OPS", "CORE", "SPEC", "DOC"]

const problems = [
  ...changelogProblems(readFileSync(join(root, "CHANGELOG.md"), "utf8"), {
    headings: ["Added", "Changed — may break callers", "Fixed", "Security", "Removed"],
    unreleased: "Unreleased",
    ids,
    release: false,
  }),
  ...docsProblems(root, {
    files: markdownFiles(root, new Set(["node_modules", "dist", "coverage", ".git", "docs_ai"])),
    ids,
  }),
]
for (const problem of problems) console.error(problem)
if (problems.length > 0) process.exit(1)
console.log("docs: ok")
