/**
 * Writes `src/engines/pins.ts`, the engines cli-core installs on first use, from pnpm-lock.yaml and the npm registry:
 * the versions are the lockfile's, so the pins are what the tests ran; the integrity is checked against the
 * registry's and each tarball is downloaded once to check it and learn its size. Run it after any bump of an engine's
 * package (the engines test fails until then):
 *
 *   node scripts/engine-pins.ts
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { lockedClosure } from "./engine-lock.ts"

/** The package each engine is named after; its dependencies come with it. */
export const ENGINE_ROOTS = ["sherpa-onnx", "ogg-opus-decoder"]

const REGISTRY = "https://registry.npmjs.org"
const root = join(import.meta.dirname, "..")
const OUT = join(root, "src/engines/pins.ts")
const SCRIPTS = ["preinstall", "install", "postinstall"]

interface Manifest {
  dist: { tarball: string; integrity: string }
  scripts?: Record<string, string>
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

const manifestOf = async (name: string, version: string): Promise<Manifest> => {
  const response = await fetch(`${REGISTRY}/${name}/${version}`)
  if (!response.ok) throw new Error(`${name}@${version}: the registry answered ${response.status}`)
  return (await response.json()) as Manifest
}

const sizeOf = async (name: string, url: string, integrity: string): Promise<number> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity)
    throw new Error(`${name}: the tarball does not match its integrity`)
  return bytes.length
}

const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")
const engines: Record<string, unknown> = {}
for (const engine of ENGINE_ROOTS) {
  const packages = []
  for (const locked of lockedClosure(lock, engine)) {
    const manifest = await manifestOf(locked.name, locked.version)
    if (manifest.dist.integrity !== locked.integrity)
      throw new Error(`${locked.name}@${locked.version}: the lockfile and the registry disagree on its integrity`)
    const scripts = SCRIPTS.filter((script) => manifest.scripts?.[script])
    if (scripts.length > 0)
      throw new Error(`${locked.name}@${locked.version} needs ${scripts.join(", ")}; engines never run package scripts`)
    packages.push({
      name: locked.name,
      version: locked.version,
      url: manifest.dist.tarball,
      integrity: locked.integrity,
      bytes: await sizeOf(locked.name, manifest.dist.tarball, locked.integrity),
      ...((manifest.os ?? locked.os) ? { os: manifest.os ?? locked.os } : {}),
      ...((manifest.cpu ?? locked.cpu) ? { cpu: manifest.cpu ?? locked.cpu } : {}),
      ...((manifest.libc ?? locked.libc) ? { libc: manifest.libc ?? locked.libc } : {}),
    })
    console.error(`${engine}: ${locked.name}@${locked.version}`)
  }
  engines[engine] = { name: engine, version: packages[0]?.version, packages }
}

writeFileSync(
  OUT,
  `// Written by scripts/engine-pins.ts from pnpm-lock.yaml and the npm registry: run it again, never edit by hand.
import type { EnginePin } from "./install.js"

export const ENGINE_PINS = ${JSON.stringify(engines, null, 2)} as const satisfies Record<string, EnginePin>
`,
)
execFileSync(join(root, "node_modules/.bin/biome"), ["format", "--write", OUT], { cwd: root, stdio: "inherit" })
console.error(`wrote ${OUT}`)
