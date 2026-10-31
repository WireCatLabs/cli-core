import {
  CliError,
  type CredentialSource,
  Credentials,
  type KeyringStore,
  pathsAreOverridden,
  resolvePaths,
} from "@wirecat/cli-base"
import { type AppIdentity, envName } from "../../ports/app.js"

export interface BotTokenStoreOptions {
  app: AppIdentity
  profile: string
  env?: NodeJS.ProcessEnv
  keyring?: KeyringStore
  configDir?: string
}

/**
 * A bot token per profile, beside — never inside — the personal session: keyring account
 * `bot:<profile>` under the app's own service, `<PREFIX>_BOT_TOKEN`, then a 0600 file. A secret the
 * messenger's bot needs beside it lives the same way: `bot:<profile>:<name>`, `<PREFIX>_BOT_<NAME>`.
 */
export class BotTokenStore {
  readonly profile: string
  readonly #account: string
  readonly #credentials: Credentials
  readonly #keyringCredentials: Credentials
  readonly #secretOf: (name: string) => Credentials

  constructor({ app, profile, env = process.env, keyring, configDir }: BotTokenStoreOptions) {
    const where = { appName: app.appName, prefix: app.envPrefix, env }
    this.profile = profile
    this.#account = `bot:${profile}`
    const credentialsFor = (variable: string) =>
      new Credentials({
        configDir: configDir ?? resolvePaths(where).config,
        service: app.appName,
        envVar: envName(app, variable),
        isolated: pathsAreOverridden(where),
        ...(keyring ? { keyring } : {}),
        env,
        warn: (message) => process.stderr.write(`${message}\n`),
      })
    this.#credentials = credentialsFor("BOT_TOKEN")
    this.#secretOf = (name) => credentialsFor(`BOT_${name.toUpperCase().replaceAll("-", "_")}`)
    this.#keyringCredentials = new Credentials({
      configDir: configDir ?? resolvePaths(where).config,
      service: app.appName,
      isolated: pathsAreOverridden(where),
      storage: "keyring",
      ...(keyring ? { keyring } : {}),
      env,
    })
  }

  read(): { token: string; source: CredentialSource } | undefined {
    const stored = this.#credentials.read(this.#account)
    return stored ? { token: stored.secret, source: stored.source } : undefined
  }

  write(token: string): CredentialSource {
    return this.#credentials.write(this.#account, token, { signIn: true })
  }

  readKeyring(): string | undefined {
    const stored = this.readStored()
    return stored?.source === "keyring" ? stored.secret : undefined
  }

  readStored(): { secret: string; source: CredentialSource } | undefined {
    try {
      return this.#keyringCredentials.read(this.#account)
    } catch {
      throw new CliError("configuration_error", "the OS keyring is unavailable for the destination bot profile")
    }
  }

  writeKeyring(token: string): void {
    try {
      this.#keyringCredentials.write(this.#account, token)
    } catch {
      throw new CliError("configuration_error", "the returned bot credential could not be stored in the OS keyring")
    }
  }

  remove(): CredentialSource[] {
    return this.#credentials.remove(this.#account)
  }

  readSecret(name: string): { secret: string; source: CredentialSource } | undefined {
    return this.#secretOf(name).read(`${this.#account}:${name}`)
  }

  writeSecret(name: string, secret: string): CredentialSource {
    return this.#secretOf(name).write(`${this.#account}:${name}`, secret, { signIn: true })
  }

  removeSecret(name: string): CredentialSource[] {
    return this.#secretOf(name).remove(`${this.#account}:${name}`)
  }
}
