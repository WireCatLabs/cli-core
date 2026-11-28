import { parse } from "yaml"

export interface LockedPackage {
  name: string
  version: string
  integrity: string
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

interface Lockfile {
  importers: Record<string, Record<string, Record<string, { version: string }> | undefined>>
  packages: Record<string, { resolution: { integrity?: string }; os?: string[]; cpu?: string[]; libc?: string[] }>
  snapshots: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>
}

const plain = (version: string) => version.replace(/\(.*$/, "")

/**
 * The package `root` that cli-core itself depends on, and everything it needs, at the versions pnpm resolved. An
 * engine is unpacked into one flat `node_modules`, so a closure needing two versions of one package is refused.
 */
export const lockedClosure = (lockText: string, root: string): LockedPackage[] => {
  const lock = parse(lockText) as Lockfile
  const own = lock.importers["."] ?? {}
  const direct = (["dependencies", "devDependencies", "optionalDependencies"] as const)
    .map((group) => own[group]?.[root]?.version)
    .find((version) => version !== undefined)
  if (!direct) throw new Error(`${root} is not a dependency of cli-core in pnpm-lock.yaml`)
  const found = new Map<string, LockedPackage>()
  const visit = (name: string, version: string) => {
    const exact = plain(version)
    const seen = found.get(name)
    if (seen) {
      if (seen.version !== exact)
        throw new Error(`${root} needs ${name} at ${seen.version} and ${exact}; an engine holds one version of each`)
      return
    }
    const key = `${name}@${exact}`
    const entry = lock.packages[key]
    const integrity = entry?.resolution.integrity
    if (!entry || !integrity) throw new Error(`${key} has no integrity in pnpm-lock.yaml`)
    found.set(name, {
      name,
      version: exact,
      integrity,
      ...(entry.os ? { os: entry.os } : {}),
      ...(entry.cpu ? { cpu: entry.cpu } : {}),
      ...(entry.libc ? { libc: entry.libc } : {}),
    })
    const snapshot = lock.snapshots[`${name}@${version}`] ?? lock.snapshots[key] ?? {}
    for (const [dependency, at] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies }))
      visit(dependency, at)
  }
  visit(root, direct)
  return [...found.values()]
}
