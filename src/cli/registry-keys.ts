import { Credentials, pathsAreOverridden, resolvePaths } from "@wirecat/cli-base"
import { type AppIdentity, envName } from "../ports/app.js"

/**
 * Combot's key for CAS, where the owner keeps one: the keyring account `registries:cas` under the
 * app's own service, `<PREFIX>_CAS_API_KEY`, or a 0600 file — as the AI providers' keys are. CAS
 * answers without one for now; never printed, never in an error.
 */
export const casKey = (app: AppIdentity, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const where = { appName: app.appName, prefix: app.envPrefix, env }
  return new Credentials({
    configDir: resolvePaths(where).config,
    service: app.appName,
    envVar: envName(app, "CAS_API_KEY"),
    isolated: pathsAreOverridden(where),
    env,
    warn: (message) => process.stderr.write(`${message}\n`),
  }).read("registries:cas")?.secret
}
