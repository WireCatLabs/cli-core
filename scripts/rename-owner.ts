// Moves a repository's text from the old owner to WireCatLabs, in two passes that land at different
// times: `github` right after the repositories are transferred, `npm` once the upstream @wirecat
// packages exist (imports would not resolve before). Tracked files only; the diff is left for review.
//
//   node <cli-core>/scripts/rename-owner.ts --pass github|npm [--dry-run]
//   node <cli-core>/scripts/rename-owner.ts --report
//
// The report lists every `leemour` still in the repository, by the rule that kept it — the owner reads
// that, not the files.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

export const REPOS = [
  "cli-core",
  "cli-tasks",
  "cli-messaging",
  "tg-cli",
  "max-cli",
  "cli-memo",
  "cli-docs",
  "cli-private",
]
export const PACKAGES = [
  "cli-core",
  "cli-tasks",
  "cli-messaging",
  "cli-messaging-sqlite",
  "cli-messaging-onnx",
  "tg-cli",
  "max-cli",
  "cli-memo",
]

// Longest first, so `cli-messaging` never takes the front of `cli-messaging-sqlite`.
const alternation = (names: string[]) => [...names].sort((a, b) => b.length - a.length).join("|")
const repo = alternation(REPOS)
const pkg = alternation(PACKAGES)
const END = String.raw`(?![\w-])`

export interface Rule {
  name: string
  pattern: RegExp
  replace: string
}

export const RULES: Record<"github" | "npm", Rule[]> = {
  github: [
    {
      name: "repo path",
      pattern: new RegExp(String.raw`(?<![@\w.-])leemour/(${repo})${END}`, "g"),
      replace: "WireCatLabs/$1",
    },
    {
      name: "escaped repo path",
      pattern: new RegExp(String.raw`github\\\.com\\/leemour\\/(${repo})${END}`, "g"),
      replace: String.raw`github\.com\/WireCatLabs\/$1`,
    },
    { name: "templated repo path", pattern: /(?<![@\w.-])leemour\/(?=\$\{|<repo>)/g, replace: "WireCatLabs/" },
    {
      name: "trusted publisher owner",
      pattern: new RegExp(String.raw`\`leemour\`(?= / \`(?:${repo})\`)`, "g"),
      replace: "`WireCatLabs`",
    },
  ],
  npm: [
    { name: "package", pattern: new RegExp(`@leemour/(${pkg})${END}`, "g"), replace: "@wirecat/$1" },
    { name: "templated package", pattern: /@leemour\/(?=\$|<)/g, replace: "@wirecat/" },
    { name: "package in a regex", pattern: /@leemour\\\/(?=\()/g, replace: String.raw`@wirecat\/` },
    { name: "scope prefix", pattern: /@leemour\/(?=["'`])/g, replace: "@wirecat/" },
    { name: "scope name", pattern: /`@leemour`/g, replace: "`@wirecat`" },
    { name: "scope glob", pattern: /@leemour\/\*/g, replace: "@wirecat/*" },
    {
      name: "registry url",
      pattern: new RegExp(`@leemour%2([fF])(${pkg})${END}`, "g"),
      replace: "@wirecat%2$1$2",
    },
    {
      name: "tarball",
      pattern: new RegExp(String.raw`(?<![\w.@-])leemour-(${pkg})(?=-[\d*$])`, "g"),
      replace: "wirecat-$1",
    },
    {
      name: "windows path",
      pattern: new RegExp(String.raw`@leemour(\\+)(${pkg})${END}`, "g"),
      replace: "@wirecat$1$2",
    },
    {
      name: "escaped package",
      pattern: new RegExp(String.raw`@leemour\\/(${pkg})${END}`, "g"),
      replace: String.raw`@wirecat\/$1`,
    },
    {
      name: "path segment",
      pattern: new RegExp(String.raw`(["'])@leemour\1(\s*,\s*["'](?:${pkg})["'])`, "g"),
      replace: "$1@wirecat$1$2",
    },
    { name: "scope folder", pattern: /node_modules\/@leemour(?=["'`/])/g, replace: "node_modules/@wirecat" },
  ],
}

// Kept on purpose; the report names them so nothing is dropped silently.
export const KEPT: Rule[] = [
  { name: "home path", pattern: /\/home\/leemour\b|-home-leemour-/g, replace: "" },
  { name: "spelling word", pattern: /^\s*"leemour",$/g, replace: "" },
  { name: "npm account page", pattern: /npmjs\.com\/settings\/leemour\//g, replace: "" },
  { name: "cloudflare account", pattern: /ModelRow leemour/g, replace: "" },
  { name: "test fixture package", pattern: /@leemour\/tool\b/g, replace: "" },
  { name: "keyring account", pattern: /account[ =`]+leemour\b/g, replace: "" },
  { name: "release lock", pattern: /leemour-release\.lock/g, replace: "" },
  { name: "author email", pattern: /leemour@gmail\.com/g, replace: "" },
  {
    name: "repo not moving",
    pattern: /leemour\/(?:brazecli|selectel|tgcli|zoom-searcher|agents_config)\b/g,
    replace: "",
  },
  { name: "package not moving", pattern: /@leemour\/brazecli\b/g, replace: "" },
]

// History stays as it was written; its links still redirect.
export const SKIPPED_FILES = [
  /(^|\/)CHANGELOG\.md$/,
  /(^|\/)(pnpm-lock\.yaml|bun\.lockb?|package-lock\.json)$/,
  /(^|\/)(journal|plans|research|decisions|captures|releases|evaluations)\//,
  /(^|\/)agent-evals\/runs\//,
]

export const rewrite = (text: string, rules: Rule[]): { text: string; counts: Map<string, number> } => {
  const counts = new Map<string, number>()
  let out = text
  for (const rule of rules) {
    out = out.replace(rule.pattern, (...match) => {
      counts.set(rule.name, (counts.get(rule.name) ?? 0) + 1)
      return rule.replace.replace(/\$(\d)/g, (_, n) => match[Number(n)] ?? "")
    })
  }
  return { text: out, counts }
}

/** Every `leemour` left in a line, each named by the rule that kept it, or `unexplained`. */
export const leftovers = (line: string): string[] => {
  let rest = line
  const found: string[] = []
  for (const rule of KEPT) {
    rest = rest.replace(rule.pattern, () => {
      found.push(rule.name)
      return ""
    })
  }
  for (const _ of rest.matchAll(/leemour/gi)) found.push("unexplained")
  return found
}

const trackedFiles = (): string[] =>
  execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0")
    .filter((path) => path && !SKIPPED_FILES.some((skip) => skip.test(path)))

const readText = (path: string): string | undefined => {
  try {
    const bytes = readFileSync(path)
    return bytes.includes(0) ? undefined : bytes.toString("utf8")
  } catch {
    return undefined
  }
}

const add = (into: Map<string, number>, from: Map<string, number>) => {
  for (const [name, n] of from) into.set(name, (into.get(name) ?? 0) + n)
}

const runPass = (pass: "github" | "npm", dryRun: boolean) => {
  const total = new Map<string, number>()
  let files = 0
  for (const path of trackedFiles()) {
    const text = readText(path)
    if (text === undefined || !text.includes("leemour")) continue
    const result = rewrite(text, RULES[pass])
    if (result.text === text) continue
    files += 1
    add(total, result.counts)
    if (!dryRun) writeFileSync(path, result.text)
  }
  console.log(`${dryRun ? "would change" : "changed"} ${files} files`)
  for (const [name, n] of total) console.log(`  ${name}: ${n}`)
}

const report = () => {
  const kept = new Map<string, number>()
  const unexplained: string[] = []
  for (const path of trackedFiles()) {
    const text = readText(path)
    if (text === undefined || !/leemour/i.test(text)) continue
    text.split("\n").forEach((line, index) => {
      for (const name of leftovers(line)) {
        if (name === "unexplained") unexplained.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`)
        else kept.set(name, (kept.get(name) ?? 0) + 1)
      }
    })
  }
  console.log(`kept on purpose (skipped files: ${SKIPPED_FILES.map(String).join(" ")}):`)
  for (const [name, n] of kept) console.log(`  ${name}: ${n}`)
  console.log(`unexplained: ${unexplained.length}`)
  for (const line of [...new Set(unexplained)]) console.log(`  ${line}`)
}

if (process.argv[1]?.endsWith("rename-owner.ts")) {
  const args = process.argv.slice(2)
  const pass = args[args.indexOf("--pass") + 1]
  if (args.includes("--report")) report()
  else if (args.includes("--pass") && (pass === "github" || pass === "npm")) runPass(pass, args.includes("--dry-run"))
  else {
    console.error("usage: rename-owner.ts --pass github|npm [--dry-run] | --report")
    process.exit(2)
  }
}
