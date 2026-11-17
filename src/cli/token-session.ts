import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import type { EventSink } from "../runs/events.js"
import { readSecret } from "../terminal/prompt.js"
import { baseContext, environmentOf, outputFor, secretInputOf } from "./context.js"
import { refuseOffline } from "./early-refusal.js"
import { FETCH, LOCAL_READ, LOCAL_WRITE, logsInOrOut, REMOTE_READ, refuseUnderReadOnly } from "./effects.js"
import { itemOf, listOf, renderAnswer } from "./envelope.js"
import { profilesHere, rememberAccount } from "./messenger/accounts.js"
import { commandWords, profileFree, refuseCommandName, rootOf } from "./profile.js"
import { ProfileTokenStore, type TokenStorage } from "./profile-token.js"
import type { GlobalFlags, ResolveOptions, Settings } from "./settings.js"

export interface TokenSessionOptions {
  app: AppIdentity
  /** The service's name, as the owner knows it: "Notion". */
  service: string
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /**
   * Asks the service whose the token is. `id` names the account, so one profile stays one account; `account` is what
   * `session start` and `session status --check` show.
   */
  verify: (
    command: Command,
    token: string,
    events: EventSink,
  ) => Promise<{ id: string; account: Readonly<Record<string, unknown>> }>
  /** Keeps the account a profile signed in to; by default only remembers it. A CLI that refuses a taken one says so. */
  claim?: (env: NodeJS.ProcessEnv, profile: string, id: string, tokens: ProfileTokenStore) => void
  /** What the token is, for the prompt and help: "API token" when not given. */
  token?: string
  /** One sentence more for `session start --help`: which token, and what it can see. */
  about?: string
}

const storageOf = (raw: string): TokenStorage => {
  if (raw === "keyring" || raw === "file") return raw
  throw new CliError("validation_error", `--credential-storage takes keyring or file; got ${raw}`)
}

/**
 * `session start | status | end | list` for a service signed in with one token (WC-ACCT-12): the token is asked hidden
 * or read from stdin, checked with the service, and only then kept in the keyring or a private file.
 */
export const tokenSessionCommand = (options: TokenSessionOptions): Command => {
  const { app, service } = options
  const word = options.token ?? "API token"
  const contextOf = (command: Command) => {
    const base = baseContext(command, options.resolveSettings)
    const tokens = new ProfileTokenStore({
      app,
      env: base.env,
      ...(base.keyring ? { keyring: base.keyring } : {}),
      warn: base.renderer.warn,
    })
    return { ...base, profile: base.settings.profile, tokens }
  }
  const answer = (command: Command, item: unknown) => renderAnswer(command, outputFor(command), itemOf(item))

  const start = logsInOrOut(
    annotate(new Command("start"), {
      effects: FETCH,
      lifetime: "interactive",
      mcp: false,
      examples: [
        `${app.command} personal session start`,
        `${app.command} personal session start --credential-storage file`,
      ],
    }),
  )
    .summary(`sign in to ${service} with an ${word}`)
    .description(
      `sign this profile in: the ${service} ${word} is asked hidden or read from stdin, never taken as an argument, ` +
        `checked with ${service}, and only then kept in the keyring, or in a private file` +
        (options.about ? `. ${options.about}` : ""),
    )
    .option(
      "--credential-storage <storage>",
      "where the token is kept: keyring, which falls back to a private file by itself, or file",
      storageOf,
      "keyring" as TokenStorage,
    )
    .action(async function (this: Command, args: { credentialStorage: TokenStorage }) {
      const { env, profile, tokens, run } = contextOf(this)
      refuseCommandName(profile, commandWords(rootOf(this)), app.command)
      refuseOffline(this, service)
      // A secret is never an argument: it would land in shell history and in the run record (WC-SECR-5).
      const token = (await readSecret(`${service} ${word}: `, secretInputOf(this))).trim()
      if (!token) throw new CliError("validation_error", "no token was given")
      const { id, account } = await run((events) => options.verify(this, token, events))
      ;(options.claim ?? ((at, name, key) => rememberAccount(app, name, key, at)))(env, profile, id, tokens)
      const storedIn = tokens.write(profile, token, args.credentialStorage)
      answer(this, { profile, state: "saved", stored_in: storedIn, verified: true, ...account })
    })

  const status = annotate(new Command("status"), {
    effects: REMOTE_READ,
    examples: [`${app.command} personal session status`, `${app.command} personal session status --check --json`],
  })
    .summary("show where this profile's token comes from; never the token")
    .description(
      `show where this profile's token comes from: ${app.envPrefix}_TOKEN, the keyring or a file, never the token; ` +
        `--check asks ${service} whose token it is`,
    )
    .option("--check", `ask ${service} whether the token still works, and whose it is`)
    .action(async function (this: Command, args: { check?: boolean }) {
      const { profile, tokens, run } = contextOf(this)
      const saved = tokens.read(profile)
      const state = { profile, state: saved ? "saved" : "missing", token_from: saved?.source ?? null }
      if (!args.check || !saved) return answer(this, { ...state, verified: false })
      refuseOffline(this, service)
      const { account } = await run((events) => options.verify(this, saved.secret, events))
      answer(this, { ...state, verified: true, ...account })
    })

  const end = logsInOrOut(
    annotate(new Command("end"), {
      effects: LOCAL_WRITE,
      mcp: false,
      examples: [`${app.command} personal session end`],
    }),
  )
    .summary("forget this profile's token on this computer")
    .description(`forget this profile's token on this computer; the token itself stays valid in ${service}`)
    .action(function (this: Command) {
      refuseUnderReadOnly(this, "session end")
      const { profile, tokens } = contextOf(this)
      answer(this, { profile, ended: tokens.remove(profile) })
    })

  const list = profileFree(
    annotate(new Command("list"), {
      effects: LOCAL_READ,
      examples: [`${app.command} session list`, `${app.command} session list --json`],
    }),
  )
    .summary("list the profiles here and whether each is signed in")
    .description("list the profiles on this computer and whether each has a token; picks none")
    .action(function (this: Command) {
      const environment = environmentOf(this)
      const env = environment.env ?? process.env
      const { configuredProfiles } = options.resolveSettings({}, { env, needsProfile: false })
      const tokens = new ProfileTokenStore({
        app,
        env,
        ...(environment.keyring ? { keyring: environment.keyring } : {}),
        warn: outputFor(this).renderer.warn,
      })
      const items = profilesHere(app, configuredProfiles, env).map((profile) => {
        const saved = tokens.read(profile)
        return { profile, signed_in: saved !== undefined, token_from: saved?.source ?? null }
      })
      renderAnswer(
        this,
        outputFor(this),
        listOf("session list", { items, limit: Math.max(1, items.length), has_more: false }),
      )
    })

  return annotate(new Command("session"), { effects: LOCAL_READ })
    .description(`keep this profile's ${service} token in the OS keyring`)
    .addCommand(start)
    .addCommand(status)
    .addCommand(end)
    .addCommand(list)
}
