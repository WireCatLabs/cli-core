import { enginesDirectory, installedEngines } from "./install.js"
import { ENGINE_PINS } from "./pins.js"

/** `doctor`'s `engines`: where they go and each one installed there. Never throws: doctor answers when all is broken. */
export const enginesReport = (env: NodeJS.ProcessEnv = process.env) => {
  try {
    return { directory: enginesDirectory(env), installed: installedEngines(ENGINE_PINS, env) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
