import {
  type CredentialSource,
  Credentials,
  type KeyringStore,
  pathsAreOverridden,
  resolvePaths,
} from "@wirecat/cli-base"
import { type AppIdentity, envName } from "../ports/app.js"

export const endpointKeyName = (baseUrl: string): string => {
  const host = new URL(baseUrl).host
  return ["openai", "anthropic"].includes(host) ? `endpoint:${host}` : host
}

/**
 * An AI provider's API key (phase 5 E11), kept as bot tokens are: the keyring account
 * `embeddings:<provider>` under the app's own service, then `<PREFIX>_OPENAI_API_KEY` or OpenAI's own
 * `OPENAI_API_KEY` for `openai`, or the corresponding Anthropic variable, then a 0600 file. Never printed, never in an error.
 */
export const embeddingKeys = (app: AppIdentity, env: NodeJS.ProcessEnv = process.env, keyring?: KeyringStore) => {
  const where = { appName: app.appName, prefix: app.envPrefix, env }
  const credentials = (provider: string) =>
    new Credentials({
      configDir: resolvePaths(where).config,
      service: app.appName,
      ...(["openai", "anthropic"].includes(provider)
        ? { envVar: envName(app, `${provider.toUpperCase()}_API_KEY`) }
        : {}),
      isolated: pathsAreOverridden(where),
      env,
      ...(keyring ? { keyring } : {}),
      warn: (message) => process.stderr.write(`${message}\n`),
    })
  const account = (provider: string) => `embeddings:${provider}`
  return {
    read: (provider: string): { key: string; source: CredentialSource | "env" } | undefined => {
      const stored = credentials(provider).read(account(provider))
      if (stored) return { key: stored.secret, source: stored.source }
      const shared = ["openai", "anthropic"].includes(provider)
        ? env[`${provider.toUpperCase()}_API_KEY`]?.trim()
        : undefined
      return shared ? { key: shared, source: "env" } : undefined
    },
    write: (provider: string, key: string): CredentialSource =>
      credentials(provider).write(account(provider), key, { signIn: true }),
    remove: (provider: string): CredentialSource[] => credentials(provider).remove(account(provider)),
  }
}
