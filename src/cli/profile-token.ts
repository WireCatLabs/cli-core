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
 * What one profile's entry holds when it keeps more than its token: the token and named secrets, as one JSON value
 * after a prefix no typed password starts with. A plain value is the token alone, as every entry written before.
 */
const ENVELOPE = "wirecat-secrets:v1:"

interface Held {
  token?: string
  secrets: Record<string, string>
}

const SECRET_NAME = /^[a-z][a-z0-9-]{0,31}$/

const checkName = (name: string): void => {
  if (!SECRET_NAME.test(name) || name === "token")
    throw new CliError("validation_error", "a secret's name is a-z, 0-9 and -, up to 32 characters, and not token", {
      reason: "input.invalid",
    })
}

const unpack = (value: string | undefined): Held => {
  if (value === undefined) return { secrets: {} }
  if (!value.startsWith(ENVELOPE)) return { token: value, secrets: {} }
  try {
    const parsed = JSON.parse(value.slice(ENVELOPE.length)) as { token?: unknown; secrets?: unknown }
    const secrets =
      parsed.secrets && typeof parsed.secrets === "object" ? (parsed.secrets as Record<string, unknown>) : {}
    return {
      ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      secrets: Object.fromEntries(
        Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    }
  } catch {
    throw new CliError("configuration_error", "this profile's stored secrets cannot be read; run session start again", {
      reason: "session.unreadable",
    })
  }
}

/** The token alone stays a plain value, so an entry with nothing else in it reads as before. */
const pack = (held: Held): string | undefined => {
  if (Object.keys(held.secrets).length === 0) return held.token
  return `${ENVELOPE}${JSON.stringify({ ...(held.token === undefined ? {} : { token: held.token }), secrets: held.secrets })}`
}

/**
 * One API token per profile for a CLI that is not a messenger: `<PREFIX>_TOKEN`, then the keyring entry
 * `token:<profile>` under the app's own service, then a 0600 file (WC-SECR-4). A run with moved folders reads the
 * owner's entry and never replaces or deletes it: it writes a temporary `<app>:<config folder>` entry instead
 * (WC-SECR-24, cli-base `Credentials`).
 *
 * A profile that needs a second secret (a database password and an SSH password) keeps it in the same entry, by
 * name: `writeSecret(profile, "ssh", …)`. The entry then holds the token and the named secrets as one value, as an
 * OAuth entry holds its tokens and client secret; the keyring gets no second entry. `<PREFIX>_TOKEN_<NAME>` overrides
 * one for CI, as `<PREFIX>_TOKEN` does the token.
 */
export class ProfileTokenStore {
  readonly variable: string
  readonly #app: AppIdentity
  readonly #options: CredentialsOptions
  readonly #credentials: Credentials
  /** The same entry without the environment variable, for the value a write merges into. */
  readonly #stored: Credentials

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
    const { envVar: _, ...stored } = this.#options
    this.#stored = new Credentials(stored)
  }

  read(profile: string): StoredCredential | undefined {
    const found = this.#credentials.read(accountOf(profile))
    if (!found || found.source === "environment") return found
    const { token } = unpack(found.secret)
    return token === undefined ? undefined : { secret: token, source: found.source }
  }

  /** The token; the profile's named secrets stay as they were. */
  write(profile: string, token: string, storage: TokenStorage = "keyring"): CredentialSource {
    const held = this.#held(profile)
    return this.#put(profile, { ...held, token }, storage)
  }

  /** The token and every named secret: the whole entry, as `session end` wants. */
  remove(profile: string): CredentialSource[] {
    return this.#credentials.remove(accountOf(profile))
  }

  /** A named secret: `<PREFIX>_TOKEN_<NAME>`, then the profile's entry. */
  readSecret(profile: string, name: string): StoredCredential | undefined {
    checkName(name)
    const variable = this.secretVariable(name)
    const given = this.#options.env?.[variable]
    if (given) return { secret: given, source: "environment" }
    const found = this.#stored.read(accountOf(profile))
    const secret = found ? unpack(found.secret).secrets[name] : undefined
    return found && secret !== undefined ? { secret, source: found.source } : undefined
  }

  /** A named secret, kept in the profile's one entry beside its token; where the entry is now when not given. */
  writeSecret(profile: string, name: string, secret: string, storage?: TokenStorage): CredentialSource {
    checkName(name)
    const found = this.#stored.read(accountOf(profile))
    const held = unpack(found?.secret)
    const where = storage ?? (found?.source === "file" ? "file" : "keyring")
    return this.#put(profile, { ...held, secrets: { ...held.secrets, [name]: secret } }, where)
  }

  /** Forgets one named secret; the token and the others stay. An entry left empty is removed. */
  removeSecret(profile: string, name: string): CredentialSource[] {
    checkName(name)
    const held = this.#held(profile)
    if (!(name in held.secrets)) return []
    const { [name]: _, ...secrets } = held.secrets
    const left = { ...held, secrets }
    if (pack(left) === undefined) return this.remove(profile)
    const found = this.#stored.read(accountOf(profile))
    return [this.#put(profile, left, found?.source === "file" ? "file" : "keyring")]
  }

  /** The variable that overrides a named secret: `PBX_TOKEN_SSH` for `ssh`. */
  secretVariable(name: string): string {
    return `${this.variable}_${name.toUpperCase().replaceAll("-", "_")}`
  }

  #held(profile: string): Held {
    return unpack(this.#stored.read(accountOf(profile))?.secret)
  }

  /** `file` also forgets the keyring copy, so a later read cannot find the secret the owner asked to keep elsewhere. */
  #put(profile: string, held: Held, storage: TokenStorage): CredentialSource {
    const value = pack(held) as string
    if (storage === "keyring") return this.#stored.write(accountOf(profile), value, { signIn: true })
    const kept = new Credentials({ ...this.#options, storage: "file" }).write(accountOf(profile), value)
    try {
      new Credentials({ ...this.#options, storage: "keyring" }).remove(accountOf(profile))
    } catch {
      // No keyring on this computer: there is no copy to forget.
    }
    return kept
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
