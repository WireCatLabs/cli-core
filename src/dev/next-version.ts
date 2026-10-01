/**
 * The version `bin/release` publishes: the one in package.json when npm has not taken it and it is
 * above npm's latest, else the next free one at the same bump level (x.y.0 → minor, x.y.z → patch).
 * npm's answers are arguments, not calls, so CI and a test can hand it any registry state.
 */
export const nextVersion = (
  wanted: string,
  latest: string,
  versionsJson: string,
): { version: string } | { error: string } => {
  const parse = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number)
  const compare = (a: number[], b: number[]) =>
    (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0)

  const want = parse(wanted)
  // A pre-release is picked by hand; bin/release still refuses it if npm has it.
  if (!want) return { version: wanted }

  let published: unknown[] = []
  try {
    published = [JSON.parse(versionsJson || "[]")].flat()
  } catch {}
  const taken = new Set(published)

  const top = parse(latest)
  if (!top) {
    if (taken.has(wanted))
      return { error: `${wanted} is on npm, and npm's latest "${latest}" is not a plain x.y.z version` }
    return { version: wanted }
  }

  if (!taken.has(wanted) && compare(want, top) > 0) return { version: wanted }

  const step = ([major = 0, minor = 0, patch = 0]: number[]) =>
    want[2] === 0 ? [major, minor + 1, 0] : [major, minor, patch + 1]
  let next = step(top)
  while (taken.has(next.join("."))) next = step(next)
  return { version: next.join(".") }
}
