import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type EnginePin, engineFolder, isEngineInstalled, markerOf } from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"

export type EngineName = keyof typeof ENGINE_PINS

/**
 * The pinned engines in `env`'s data folder, as an install leaves them, each linked to the copy in `from`'s
 * node_modules: a CLI's tests of what voice, a reader or a chart does, not of how it installs, keep the packages as development
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
    const own = (pkg: string) => join(from, "node_modules", ...pkg.split("/"))
    if (!existsSync(own(name)))
      throw new Error(`${name} is not in ${join(from, "node_modules")}: add ${name}@${pin.version} to devDependencies`)
    const folder = engineFolder(pin, env)
    // Every package the engine's own code is loaded by, such as linkedom beside defuddle; the package manager's
    // layout finds the rest from them.
    for (const pkg of pin.packages) {
      if ("path" in pkg || !existsSync(own(pkg.name))) continue
      const link = join(folder, "node_modules", ...pkg.name.split("/"))
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(realpathSync(own(pkg.name)), link, "junction")
    }
    writeFileSync(join(folder, "engine.json"), markerOf(pin))
    if (!isEngineInstalled(pin, env)) throw new Error(`${name}: the placed engine is not what the installer reads`)
  }
}
