import { readFileSync } from "node:fs"
import { join } from "node:path"
import { writeSecurely } from "./config.js"
import { CliError } from "./errors.js"
import { type KeyringStore, systemKeyring } from "./keyring.js"

export const CREDENTIAL_STORAGE = ["auto", "keyring", "file"] as const
export type CredentialStorage = (typeof CREDENTIAL_STORAGE)[number]

export type CredentialSource = "environment" | "keyring" | "file"

export interface StoredCredential {
  secret: string
  source: CredentialSource
}

export interface CredentialsOptions {
  /** Where the fallback file lives when the keyring cannot be used. */
  configDir: string
  /** The keyring service name — the command's name, e.g. `max-cli`. */
  service: string
  /**
   * **True when the config directory came from the environment rather than the OS convention.**
   *
   * The OS keyring is global: an entry is addressed by service and account and knows nothing about
   * which config directory asked for it. So a throwaway config directory looks isolated and is
   * not — it overwrites the real secret for that account. In `brazecli` that destroyed two working
   * keys on 2026-09-14, and a keyring entry cannot be read back out. Passing `true` here scopes the
   * service name to the directory, making the isolation people already assume they have real.
   */
  isolated?: boolean
  /** Read before the keyring, for CI. */
  envVar?: string
  storage?: CredentialStorage
  keyring?: KeyringStore
  env?: NodeJS.ProcessEnv
  fileName?: string
  /** Where the one-line warning goes when the keyring is unavailable. Never stdout. */
  warn?: (message: string) => void
}

export const keyringService = (service: string, configDir: string, isolated = false): string =>
  isolated ? `${service}:${configDir}` : service

type FileStore = Record<string, { secret?: string }>

/**
 * Environment first, then the OS keyring, then a file.
 *
 * `auto` does not probe whether a keyring exists: it attempts the operation, and on failure warns
 * once and falls through. A probe would touch the user's keychain for nothing and could still
 * succeed where the real operation fails.
 */
export class Credentials {
  readonly #configDir: string
  readonly #storage: CredentialStorage
  readonly #keyring: KeyringStore
  readonly #env: NodeJS.ProcessEnv
  readonly #service: string
  readonly #envVar: string | undefined
  readonly #fileName: string
  readonly #warn: (message: string) => void
  #warned = false

  constructor(options: CredentialsOptions) {
    this.#configDir = options.configDir
    this.#storage = options.storage ?? "auto"
    this.#keyring = options.keyring ?? systemKeyring
    this.#env = options.env ?? process.env
    this.#envVar = options.envVar
    this.#fileName = options.fileName ?? "credentials.json"
    this.#warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`))
    this.#service = keyringService(options.service, options.configDir, options.isolated)
  }

  read(account: string): StoredCredential | undefined {
    const fromEnv = this.#envVar ? this.#env[this.#envVar]?.trim() : undefined
    if (fromEnv) return { secret: fromEnv, source: "environment" }

    if (this.#storage !== "file") {
      const fromKeyring = this.#tryKeyring(() => this.#keyring.get(this.#service, account))
      if (fromKeyring) return { secret: fromKeyring, source: "keyring" }
    }

    const fromFile = this.#readFile()?.[account]?.secret
    return fromFile ? { secret: fromFile, source: "file" } : undefined
  }

  write(account: string, secret: string): CredentialSource {
    if (this.#storage !== "file") {
      const stored = this.#tryKeyring(() => {
        this.#keyring.set(this.#service, account, secret)
        return true
      })
      if (stored) return "keyring"
    }

    const store = this.#readFile()
    if (!store) {
      throw new CliError(
        "configuration_error",
        `${this.#path()} cannot be read as a credentials file; storing now would replace every secret in it. ` +
          "Fix the file or move it aside, then try again.",
      )
    }
    store[account] = { secret }
    this.#writeFile(store)
    return "file"
  }

  remove(account: string): CredentialSource[] {
    const removed: CredentialSource[] = []

    if (this.#storage !== "file" && this.#tryKeyring(() => this.#keyring.delete(this.#service, account))) {
      removed.push("keyring")
    }

    const store = this.#readFile()
    if (store?.[account] !== undefined) {
      delete store[account]
      this.#writeFile(store)
      removed.push("file")
    }

    return removed
  }

  #path(): string {
    return join(this.#configDir, this.#fileName)
  }

  /** `undefined` when the file exists but is not a store: writing would replace what it holds. */
  #readFile(): FileStore | undefined {
    let text: string
    try {
      text = readFileSync(this.#path(), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      return undefined
    }
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as FileStore) : undefined
    } catch {
      // The parser's message quotes the file, and the file holds secrets.
      return undefined
    }
  }

  #writeFile(store: FileStore): void {
    writeSecurely(this.#path(), `${JSON.stringify(store, null, 2)}\n`, 0o600)
  }

  #tryKeyring<T>(operation: () => T): T | undefined {
    if (this.#storage === "keyring") return operation()

    try {
      return operation()
    } catch (error) {
      if (!this.#warned) {
        this.#warned = true
        this.#warn(
          `the OS keyring is unavailable (${error instanceof Error ? error.message : String(error)}); ` +
            `storing in ${this.#path()} instead, readable only by you`,
        )
      }
      return undefined
    }
  }
}
