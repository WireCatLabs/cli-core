/**
 * Decides how much a merge-queue run must test. The pull request already passed the full validation on its own head,
 * and main passed the queue. A test whose imports (Vitest's module graph) miss every file one side changed since the
 * fork point has the inputs of one of those runs, so only the tests that reach both sides can turn out differently.
 * The tests that start a process are added, since no import graph reaches what they run. Anything it cannot judge
 * from imports means the full validation. QUEUE_SCOPE_SIDES=union takes the tests that reach either side instead.
 *
 *   node scripts/queue-scope.ts <fork point> <pull request head> <queue base> [queue commit]
 *
 * Writes `scope=related|full`, `why=` and `files=` (the test files, space-separated) to GITHUB_OUTPUT, or stdout.
 */
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// Files that every test, the test runner or a downstream CLI depends on: a change to one can change any result.
const everything: [RegExp, string][] = [
  [/^(pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/, "the dependencies"],
  [/^(tsconfig[^/]*\.json|vitest\.config\.[cm]?ts)$/, "the build or test config"],
  [/^test\/(?!shard-weights\.json$)/, "the test data in test/"],
  [/^src\/testing\//, "the test setup and shared test helpers in src/testing/"],
  [/^(drizzle|src\/store\/sqlite\/drizzle)\//, "a migration"],
  [/^src\/store\/sqlite\/schema\.ts$/, "the store schema"],
  [/^scripts\/(check-old-node|check-sqlite-restart|node22-[^/]+)\.mjs$/, "a check of the old runtimes"],
]
// Lint and the typecheck run on the whole repository, the workflows check themselves, the docs checks always run.
const ignored = /^(changes\/.*|.*\.md|biome\.jsonc?|test\/shard-weights\.json|\.github\/.*)$/
const source = /^(src|scripts)\/.*\.ts$/
// A test that starts a process runs the built CLI or a script, which its imports do not show.
const spawns = /child_process|execa|spawnSync|execFileSync|\bspawn\(|execFile\(/
// The checks a docs-only change runs (pr.yml's changelog-only job): they read the Markdown and the changelog.
const docs = [
  "scripts/changelog-shape.test.ts",
  "scripts/changelog-fragments.test.ts",
  "src/store/sqlite/schema.test.ts",
  "src/parity/catalogue.test.ts",
]
// Milliseconds summed over test/shard-weights.json, as one parallel run measured them: 800 s of them take about a
// third of a full validation's runner time, and 20 of the last 50 merges behind main stayed under it (2026-11-27).
const limitSeconds = Number(process.env.QUEUE_SCOPE_LIMIT_SECONDS ?? 800)

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
const out = (lines: Record<string, string>) => {
  const text = Object.entries(lines)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("")
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
  else process.stdout.write(text)
}
const withoutVersion = (commit: string) => {
  const { version: _, ...rest } = JSON.parse(git("show", `${commit}:package.json`))
  return JSON.stringify(rest)
}
const full = (why: string): never => {
  out({ scope: "full", why })
  process.exit(0)
}

type Side = { code: string[]; tests: Set<string> }

async function main() {
  const [fork, pull, queueBase, head = "HEAD"] = process.argv.slice(2)
  if (!fork || !pull || !queueBase)
    return full("usage: queue-scope.ts <fork point> <pull request head> <queue base> [commit]")
  const diff = (from: string, to: string) =>
    git("diff", "--name-only", "--no-renames", from, to).split("\n").filter(Boolean)
  const changed = { pull: diff(fork, pull), main: diff(fork, queueBase) }
  const all = [...new Set([...changed.pull, ...changed.main])]
  for (const file of all) {
    for (const [pattern, what] of everything) if (pattern.test(file)) full(`${file} changed: ${what}`)
  }
  if (all.includes("package.json") && withoutVersion(fork) !== withoutVersion(head)) {
    full("package.json changed beyond its version: the dependencies or the exports")
  }
  // api/ is the stable API report the downstream CLIs build against. A new export cannot break them; a changed or
  // removed one can, and only the full validation builds them (parity).
  const removed = git("diff", "--no-renames", "-U0", fork, head, "--", "api/")
    .split("\n")
    .find((line) => line.startsWith("-") && !line.startsWith("---"))
  if (removed) full(`the stable API changed or lost a line, so the downstream CLIs must build: ${removed.slice(1, 80)}`)

  const tests = git("ls-files", "src/**/*.test.ts", "scripts/**/*.test.ts").split("\n").filter(Boolean)
  const texts = new Map(tests.map((file) => [file, readFileSync(join(root, file), "utf8")]))
  const always = tests.filter((file) => spawns.test(texts.get(file) ?? ""))

  const { createVitest } = await import("vitest/node")
  const vitest = await createVitest("test", { watch: false, run: true, passWithNoTests: true })
  const reach = async (files: string[]): Promise<Side> => {
    const code = files.filter((file) => !ignored.test(file) && file !== "package.json" && !file.startsWith("api/"))
    const reached = new Set<string>()
    // A data file or a script is read or started by name, so the tests that name it are the ones that reach it.
    for (const file of code.filter((file) => !source.test(file))) {
      const naming = tests.filter((test) => texts.get(test)?.includes(basename(file)))
      if (!naming.length && file.startsWith("src/")) full(`${file} changed, and no test names it`)
      for (const test of naming) reached.add(test)
    }
    const sources = code.filter((file) => source.test(file))
    if (sources.length) {
      vitest.config.related = sources.map((file) => join(root, file))
      for (const spec of await vitest.getRelevantTestSpecifications()) {
        reached.add(relative(root, spec.moduleId).split("\\").join("/"))
      }
    }
    return { code, tests: reached }
  }
  let sides: { pull: Side; main: Side }
  try {
    sides = { pull: await reach(changed.pull), main: await reach(changed.main) }
  } finally {
    await vitest.close()
  }
  const both = [...sides.pull.tests].filter((test) => sides.main.tests.has(test))
  const picked = process.env.QUEUE_SCOPE_SIDES === "union" ? [...sides.pull.tests, ...sides.main.tests] : both
  const starting = sides.pull.code.length && sides.main.code.length ? always : []
  const files = [...new Set([...picked, ...starting, ...docs])].sort()
  if (files.length >= tests.length) full("every test file reaches a file both sides changed")

  const weights: Record<string, number> = JSON.parse(readFileSync(join(root, "test/shard-weights.json"), "utf8"))
  const known = Object.values(weights).sort((a, b) => a - b)
  const median = known[Math.floor(known.length / 2)] ?? 1
  const seconds = Math.round(files.reduce((sum, file) => sum + (weights[file] ?? median), 0) / 1000)
  if (seconds > limitSeconds) {
    full(`${files.length} related test files take about ${seconds} s, over the ${limitSeconds} s limit`)
  }
  out({
    scope: "related",
    why:
      `the pull request changed ${sides.pull.code.length} files and main ${sides.main.code.length} since ` +
      `${fork.slice(0, 10)}; ${both.length} test files reach both sides; with the ${starting.length} that start a ` +
      `process and the ${docs.length} docs checks, ${files.length} files, about ${seconds} s.`,
    seconds: String(seconds),
    files: files.join(" "),
  })
}

await main()
