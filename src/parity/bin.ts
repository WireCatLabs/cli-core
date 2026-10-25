#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { text } from "node:stream/consumers"
import { type Manifest, parityProblems } from "./manifest.js"
import { pageProblems } from "./pages.js"
import { wordingProblems } from "./wording.js"

const [cli = "", flag, ...pages] = process.argv.slice(2)
const manifest: Manifest = JSON.parse(readFileSync(new URL("../../parity.json", import.meta.url), "utf8"))
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"))
const names = manifest.clis.join("|")
const usage = () => {
  console.error(
    `usage: <tool> commands --json | cli-core-parity <${names}> [--pages <file...>]\n` +
      "       cli-core-parity wording <commands.json> <commands.json...>",
  )
  process.exit(2)
}

if (cli === "wording" && flag !== undefined && pages.length > 0) {
  const programs = [flag, ...pages].map(read)
  const strangers = programs.filter((program) => !manifest.clis.includes(program.cli))
  if (strangers.length > 0) {
    console.error(`not a CLI of the parity manifest (${names}): ${strangers.map((program) => program.cli).join(", ")}`)
    usage()
  }
  const problems = wordingProblems(manifest, programs)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) {
    console.error(`${problems.length} shared option(s) worded differently — STANDARD.md, Help text rule 4`)
    process.exit(1)
  }
  process.exit(0)
}
if (!manifest.clis.includes(cli) || (flag !== undefined && (flag !== "--pages" || pages.length === 0))) usage()

// Loading node:process makes a piped stdin non-blocking, so readFileSync(0) throws EAGAIN on a large pipe.
const program = JSON.parse(await text(process.stdin))

if (flag === "--pages") {
  const problems = pages.flatMap((page) =>
    pageProblems(readFileSync(page, "utf8"), cli, manifest, program).map(
      (found) => `${page}: ${found} — no such option, and the parity manifest plans none for ${cli}`,
    ),
  )
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
} else {
  const problems = parityProblems(manifest, cli, program)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) {
    console.error(`${problems.length} difference(s) from @wirecat/cli-core parity.json — see docs/dev/STANDARD.md`)
    process.exit(1)
  }
}
