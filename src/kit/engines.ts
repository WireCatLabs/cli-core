import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type EnginePin, engineFolder, isEngineInstalled, packagesFor } from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"

export type EngineName = keyof typeof ENGINE_PINS

/**
 * The pinned engines in `env`'s data folder, as an install leaves them, each linked to the copy in `from`'s
 * node_modules: a CLI's tests of what voice does, not of how it installs, keep the packages as development
 * dependencies. A first-use test starts from an empty folder instead.
 * @experimental
 */
export const placeEngines = (
  env: NodeJS.ProcessEnv = process.env,
  names: readonly EngineName[] = Object.keys(ENGINE_PINS) as EngineName[],
  from: string = process.cwd(),
): void => {
  for (const name of names) {
    const pin: EnginePin = ENGINE_PINS[name]
    if (isEngineInstalled(pin, env)) continue
    const own = join(from, "node_modules", ...name.split("/"))
    if (!existsSync(own))
      throw new Error(`${name} is not in ${join(from, "node_modules")}: add ${name}@${pin.version} to devDependencies`)
    const folder = engineFolder(pin, env)
    const link = join(folder, "node_modules", ...name.split("/"))
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(realpathSync(own), link, "junction")
    const packages = packagesFor(pin).map(({ name, version, integrity }) => ({ name, version, integrity }))
    writeFileSync(join(folder, "engine.json"), JSON.stringify({ engine: pin.name, version: pin.version, packages }))
    if (!isEngineInstalled(pin, env)) throw new Error(`${name}: the placed engine is not what the installer reads`)
  }
}
