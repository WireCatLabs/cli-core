import {
  CliError,
  type CredentialSource,
  Credentials,
  type CredentialsOptions,
  isMovedRun,
  type KeyringStore,
  resolvePaths,
  type StoredCredential,
} from "@wirecat/cli-base"
import { type AppIdentity, envName } from "../ports/app.js"

export type TokenStorage = "keyring" | "file"

export interface ProfileTokenStoreOptions {
  app: AppIdentity
  env?: NodeJS.ProcessEnv
  keyring?: KeyringStore
  /** Where the one warning about an unreachable keyring goes; stderr when left out. */
  warn?: (message: string) => void
}

/**
 * One API token per profile for a CLI that is not a messenger: `<PREFIX>_TOKEN`, then the keyring entry
 * `token:<profile>` under the app's own service, then a 0600 file (WC-SECR-4). A run with moved folders reads the
 * owner's entry and never replaces or deletes it: it writes a temporary `<app>:<config folder>` entry instead
 * (WC-SECR-24, cli-base `Credentials`).
 */
export class ProfileTokenStore {
  readonly variable: string
  readonly #app: AppIdentity
  readonly #options: CredentialsOptions
  readonly #credentials: Credentials

  constructor({ app, env = process.env, keyring, warn }: ProfileTokenStoreOptions) {
    const where = { appName: app.appName, prefix: app.envPrefix, env }
    this.#app = app
    this.variable = envName(app, "TOKEN")
    this.#options = {
      configDir: resolvePaths(where).config,
      service: app.appName,
      envVar: this.variable,
      isolated: isMovedRun(where),
      env,
      ...(keyring ? { keyring } : {}),
      warn: warn ?? ((message) => process.stderr.write(`${message}\n`)),
    }
    this.#credentials = new Credentials(this.#options)
  }

  read(profile: string): StoredCredential | undefined {
    return this.#credentials.read(accountOf(profile))
  }

  /** `file` also forgets the keyring copy, so a later read cannot find the token the owner asked to keep elsewhere. */
  write(profile: string, token: string, storage: TokenStorage = "keyring"): CredentialSource {
    if (storage === "keyring") return this.#credentials.write(accountOf(profile), token, { signIn: true })
    const kept = new Credentials({ ...this.#options, storage: "file" }).write(accountOf(profile), token)
    try {
      new Credentials({ ...this.#options, storage: "keyring" }).remove(accountOf(profile))
    } catch {
      // No keyring on this computer: there is no copy to forget.
    }
    return kept
  }

  remove(profile: string): CredentialSource[] {
    return this.#credentials.remove(accountOf(profile))
  }

  /** The profile's token, or the one "not signed in" refusal every token CLI gives, naming the command to fix it. */
  need(profile: string): string {
    const stored = this.read(profile)
    if (stored) return stored.secret
    throw new CliError(
      "authentication_error",
      `profile ${profile} is not signed in — run \`${this.#app.command} ${profile} session start\``,
      { reason: "session.missing" },
    )
  }

  /** For `appMcpCommand`'s `signedIn`: a keyring that cannot be read counts as not signed in. */
  signedIn(profile: string): boolean {
    try {
      return this.read(profile) !== undefined
    } catch {
      return false
    }
  }
}

const accountOf = (profile: string) => `token:${profile}`
