import { parse } from "yaml"

export interface LockedPackage {
  name: string
  version: string
  integrity: string
  os?: string[]
  cpu?: string[]
  libc?: string[]
  /** Where it goes under the engine's `node_modules` when not at the top, such as `htmlparser2/node_modules/entities`. */
  path?: string
}

interface Lockfile {
  importers: Record<string, Record<string, Record<string, { version: string }> | undefined>>
  packages: Record<
    string,
    {
      resolution: { integrity?: string }
      os?: string[]
      cpu?: string[]
      libc?: string[]
      peerDependencies?: Record<string, string>
    }
  >
  snapshots: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>
}

const plain = (version: string) => version.replace(/\(.*$/, "")

/**
 * The package `root` that cli-core itself depends on, and everything it needs, at the versions pnpm resolved, each at
 * the place in the engine's `node_modules` where Node finds it: the first version met of a package at the top, and
 * another version a package needs under that package's own `node_modules` (`path`), as npm lays them out.
 */
export const lockedClosure = (lockText: string, root: string): LockedPackage[] => {
  const lock = parse(lockText) as Lockfile
  const own = lock.importers["."] ?? {}
  const direct = (["dependencies", "devDependencies", "optionalDependencies"] as const)
    .map((group) => own[group]?.[root]?.version)
    .find((version) => version !== undefined)
  if (!direct) throw new Error(`${root} is not a dependency of cli-core in pnpm-lock.yaml`)
  const placed = new Map<string, LockedPackage>()
  /** The folders Node looks in for a dependency of the package at `path`, nearest first. */
  const lookups = (path: string | undefined, name: string) => {
    const found: string[] = []
    for (let at = path; at !== undefined; ) {
      found.push(`${at}/node_modules/${name}`)
      const up = at.lastIndexOf("/node_modules/")
      at = up < 0 ? undefined : at.slice(0, up)
    }
    return [...found, name]
  }
  const visit = (name: string, version: string, parent: string | undefined) => {
    const exact = plain(version)
    const nearest = lookups(parent, name).find((path) => placed.has(path))
    if (nearest && placed.get(nearest)?.version === exact) return
    const path = nearest === undefined ? name : `${parent}/node_modules/${name}`
    if (placed.has(path))
      throw new Error(`${root} needs ${name} at ${placed.get(path)?.version} and ${exact} in ${path}`)
    const key = `${name}@${exact}`
    const entry = lock.packages[key]
    const integrity = entry?.resolution.integrity
    if (!entry || !integrity) throw new Error(`${key} has no integrity in pnpm-lock.yaml`)
    placed.set(path, {
      name,
      version: exact,
      integrity,
      ...(path === name ? {} : { path }),
      ...(entry.os ? { os: entry.os } : {}),
      ...(entry.cpu ? { cpu: entry.cpu } : {}),
      ...(entry.libc ? { libc: entry.libc } : {}),
    })
    const snapshot = lock.snapshots[`${name}@${version}`] ?? lock.snapshots[key] ?? {}
    // A peer is the caller's to bring, as unpdf's optional @napi-rs/canvas: never part of the engine.
    for (const [dependency, at] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies }))
      if (!entry.peerDependencies?.[dependency]) visit(dependency, at, path)
  }
  visit(root, direct, undefined)
  return [...placed.values()]
}
