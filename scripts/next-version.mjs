// The version bin/release publishes: the one in package.json when npm has not taken it and it is
// above npm's latest, else the next free one at the same bump level (x.y.0 → minor, x.y.z → patch).
// With the repository's root, the version is then raised to the level its changelog section needs, the changes/
// fragments included (cli-base's levelledVersion): a stable break after 1.0.0 makes it a major.
//
//   node scripts/next-version.mjs <package.json version> <npm latest> <npm versions --json> [<root>]
//
// npm's answers are arguments, not calls, so CI and a shell test can hand it any registry state.
import { readFileSync } from "node:fs"
import { join } from "node:path"

const parse = (version) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number)
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
// A levelled x.0.0 that is taken stays a major: 2.0.0 taken goes to 3.0.0, never to 2.1.0.
const stepOf = (version) =>
  version[1] === 0 && version[2] === 0 && version[0] >= 1
    ? ([major]) => [major + 1, 0, 0]
    : version[2] === 0
      ? ([major, minor]) => [major, minor + 1, 0]
      : ([major, minor, patch]) => [major, minor, patch + 1]

const freeVersion = (wanted, latest, taken) => {
  const want = parse(wanted)
  const top = parse(latest)
  if (!top) {
    if (taken.has(wanted))
      throw new Error(`${wanted} is on npm, and npm's latest "${latest}" is not a plain x.y.z version`)
    return wanted
  }
  if (!taken.has(wanted) && compare(want, top) > 0) return wanted
  // A taken x.y.0 steps the minor even after 1.0.0: package.json keeps the last release's number, and a taken 1.0.0
  // stepped as a major would make every later release one.
  const step =
    want[2] === 0 ? ([major, minor]) => [major, minor + 1, 0] : ([major, minor, patch]) => [major, minor, patch + 1]
  let next = step(top)
  while (taken.has(next.join("."))) next = step(next)
  return next.join(".")
}

// The section the release will publish: the fragments collected into the version's own unpublished section, or into a
// new one above the last release.
const wouldBe = (changelog, wanted, version, taken, fragments, collectFragments) => {
  const own = !taken.has(wanted) && changelog.includes(`\n## ${wanted} — `) ? wanted : undefined
  const target = own ?? version
  const text = own ? changelog : changelog.replace(/\n## /, `\n## ${version} — 01.01.1970\n\n## `)
  return fragments.length > 0 ? collectFragments(text, target, fragments) : text
}

export const nextVersion = async (wanted, latest, versionsJson, root) => {
  // A pre-release is picked by hand; bin/release still refuses it if npm has it.
  if (!parse(wanted)) return wanted
  let published = []
  try {
    published = [JSON.parse(versionsJson || "[]")].flat()
  } catch {}
  const taken = new Set(published)
  const version = freeVersion(wanted, latest, taken)
  if (!root) return version
  const { levelledVersion } = await import("@wirecat/cli-base/release")
  const { collectFragments, readFragments } = await import("./changelog-fragments.ts")
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8")
  const text = wouldBe(changelog, wanted, version, taken, readFragments(root), collectFragments)
  let levelled = parse(levelledVersion(text, version))
  const step = stepOf(levelled)
  while (taken.has(levelled.join("."))) levelled = step(levelled)
  return levelled.join(".")
}

if (import.meta.main) {
  const [wanted = "", latest = "", versionsJson = "", root] = process.argv.slice(2)
  try {
    console.log(await nextVersion(wanted, latest, versionsJson, root))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
