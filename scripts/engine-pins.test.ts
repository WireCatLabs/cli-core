import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ENGINE_PINS } from "../src/engines/pins.js"
import { lockedClosure } from "./engine-lock.ts"

const lock = readFileSync(join(import.meta.dirname, "..", "pnpm-lock.yaml"), "utf8")

describe("the engine pins", () => {
  for (const [name, pin] of Object.entries(ENGINE_PINS))
    it(`**${name} pins what pnpm-lock.yaml resolved** (else run node scripts/engine-pins.ts)`, () => {
      expect(pin.name).toBe(name)
      expect(pin.packages.map(({ name, version, integrity }) => ({ name, version, integrity }))).toEqual(
        lockedClosure(lock, name).map(({ name, version, integrity }) => ({ name, version, integrity })),
      )
      expect(pin.version).toBe(pin.packages[0]?.version)
      for (const pkg of pin.packages) {
        expect(pkg.url).toBe(`https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/").pop()}-${pkg.version}.tgz`)
        expect(pkg.bytes).toBeGreaterThan(0)
      }
    })

  it("**refuses a closure that needs two versions of one package**", () => {
    const twice = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      a:
        specifier: 1.0.0
        version: 1.0.0
packages:
  a@1.0.0:
    resolution: {integrity: sha512-a}
  b@1.0.0:
    resolution: {integrity: sha512-b1}
  b@2.0.0:
    resolution: {integrity: sha512-b2}
  c@1.0.0:
    resolution: {integrity: sha512-c}
snapshots:
  a@1.0.0:
    dependencies:
      b: 1.0.0
      c: 1.0.0
  b@1.0.0: {}
  b@2.0.0: {}
  c@1.0.0:
    dependencies:
      b: 2.0.0
`
    expect(() => lockedClosure(twice, "a")).toThrow("a needs b at 1.0.0 and 2.0.0")
    expect(() => lockedClosure(twice, "missing")).toThrow("missing is not a dependency of cli-core")
  })

  it("**keeps each platform package's os, cpu and libc**", () => {
    const native = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      native:
        specifier: 1.0.0
        version: 1.0.0
packages:
  native@1.0.0:
    resolution: {integrity: sha512-n}
  native-linux-x64@1.0.0:
    resolution: {integrity: sha512-l}
    cpu: [x64]
    os: [linux]
    libc: [glibc]
snapshots:
  native@1.0.0:
    optionalDependencies:
      native-linux-x64: 1.0.0
  native-linux-x64@1.0.0:
    optional: true
`
    expect(lockedClosure(native, "native")).toEqual([
      { name: "native", version: "1.0.0", integrity: "sha512-n" },
      {
        name: "native-linux-x64",
        version: "1.0.0",
        integrity: "sha512-l",
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
    ])
  })
})
