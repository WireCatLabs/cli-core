import { CliError, type KeyringStore } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { FetchLike } from "@wirecat/cli-base/http"
import { Command } from "commander"
import { at as valueAt } from "../crm/manifest/map.js"
import type { CliVerify } from "../manifest/index.js"
import type { AppIdentity } from "../ports/app.js"
import type { EventSink } from "../runs/events.js"
import { plainSetupText } from "../setup/plain.js"
import { drawsHyperlinks, hyperlink } from "../terminal/hyperlink.js"
import { readSecret } from "../terminal/prompt.js"
import { baseContext, environmentOf, outputFor, secretInputOf } from "./context.js"
import { refuseOffline } from "./early-refusal.js"
import { FETCH, LOCAL_READ, LOCAL_WRITE, logsInOrOut, REMOTE_READ, refuseUnderReadOnly } from "./effects.js"
import { itemOf, listOf, renderAnswer } from "./envelope.js"
import { profilesHere, rememberAccount } from "./messenger/accounts.js"
import { commandWords, profileFree, refuseCommandName, rootOf } from "./profile.js"
import { ProfileTokenStore, type TokenStorage } from "./profile-token.js"
import { serviceApiCall } from "./service-api-call.js"
import { type ServiceApiManifest, siteValue } from "./service-api-manifest.js"
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
    site: string | undefined,
  ) => Promise<{ id: string; account: Readonly<Record<string, unknown>> }>
  /**
   * The service runs on the owner's own site, its server's `{site}`: `session start` takes `--site`, verifies the
   * token there and keeps the site in the token's own entry, written and forgotten with it, so the token only ever
   * goes to that site (`signedInSite`). `<PREFIX>_TOKEN` needs `<PREFIX>_TOKEN_SITE` beside it. The example is a site
   * for the help, such as "blog.example.com".
   */
  site?: { example: string }
  /**
   * The secret is a password for a user name, as WordPress's application passwords: `session start --login <name>`
   * asks only the password hidden, and the profile keeps `<name>:<password>`, which a `basic` scheme sends.
   * `page` names where the owner makes one, shown before the question. `<PREFIX>_TOKEN` then holds
   * `<name>:<password>` too.
   */
  login?: { page?: (site: string | undefined) => string }
  /**
   * Keeps the account a profile signed in to; by default only remembers it. A CLI that refuses a taken one says so.
   * With `site`, `id` is `<site>:<id>`, the site as `--site` was cleaned.
   */
  claim?: (
    env: NodeJS.ProcessEnv,
    profile: string,
    id: string,
    tokens: ProfileTokenStore,
    keyring: KeyringStore | undefined,
  ) => void
  /** What the token is, for the prompt and help: "API token" when not given. */
  token?: string
  /** One sentence more for `session start --help`: which token, and what it can see. */
  about?: string
  /**
   * How a person who never made one gets the token: the steps and their links, in plain words, as the restricted
   * Markdown of a setup text (a `##` heading, `**bold**`, `[words](link)`). `session start` prints it before the
   * question at a terminal, its links drawn as links where the terminal shows them, and `session start --help` ends
   * with it.
   */
  guide?: string
  /** One sentence more for `session end --help`, such as what of the service's own tools it leaves alone. */
  endNote?: string
}

export interface ManifestVerifyOptions {
  manifest: ServiceApiManifest
  /** The service's name in messages: "Attio". */
  service: string
  /** The config's `auth.verify`: the operation, where its answer holds the id and a name, and whether it is live. */
  verify: CliVerify
  /**
   * The command's host-checked fetch, such as `hostsFetch(hosts, environment.fetch)`. `site` is the one `session start
   * --site` names, for a service on the owner's own site: its host is not among the CLI's own.
   */
  fetch: (command: Command, site: string | undefined) => FetchLike
}

/**
 * `verify` for `tokenSessionCommand` from a config's `auth.verify`: the one operation is sent with the token, a token the
 * answer does not call active is refused, and the account is the id and name the answer holds.
 */
export const manifestVerify =
  ({ manifest, service, verify, fetch }: ManifestVerifyOptions): TokenSessionOptions["verify"] =>
  async (command, token, _events, site) => {
    const call = serviceApiCall({
      manifest,
      service,
      fetch: fetch(command, site),
      token: () => token,
      ...(site === undefined ? {} : { serverVariables: { site } }),
    })
    const answer = await call(verify.operation, { path: {}, query: {}, headers: {}, fields: {} })
    // A service such as Attio answers a revoked key with 200 and `active: false`, not with 401.
    if (verify.active !== undefined && valueAt(answer, verify.active) !== true)
      throw new CliError("authentication_error", `${service} does not accept this token; sign in again`)
    const id = valueAt(answer, verify.id)
    if (typeof id !== "string" && typeof id !== "number")
      throw new CliError("provider_error", `${service} answered ${verify.operation} without ${verify.id}`, {
        reason: "verify.no-id",
      })
    const name = verify.name === undefined ? undefined : valueAt(answer, verify.name)
    return { id: String(id), account: { id: String(id), ...(typeof name === "string" ? { name } : {}) } }
  }

const UNREADABLE = new Set(["keyring.unreachable", "oauth.not-saved", "oauth.invalid", "session.unreadable"])

/**
 * `session list`'s row for a profile whose sign-in cannot be read: a keyring this run cannot reach or a broken entry
 * must not hide the other profiles (WC-ACCT-12), and `session status` names the cause. Warns once per cause.
 */
export const unknownSignIn = (warn: (message: string) => void) => {
  const warned = new Set<string>()
  return (profile: string, error: unknown) => {
    if (!(error instanceof CliError) || !UNREADABLE.has(String(error.details.reason))) throw error
    if (!warned.has(error.message)) warn(error.message)
    warned.add(error.message)
    return { profile, signed_in: null, state: "unknown" } as const
  }
}

export const storageOf = (raw: string): TokenStorage => {
  if (raw === "keyring" || raw === "file") return raw
  throw new CliError("validation_error", `--credential-storage takes keyring or file; got ${raw}`)
}

/**
 * `session start | status | end | list` for a service signed in with one token (WC-ACCT-12): the token is asked hidden
 * or read from stdin, checked with the service, and only then kept in the keyring or a private file.
 */
export const tokenSessionCommand = (options: TokenSessionOptions): Command => {
  const { app, service } = options
  const word = options.token ?? (options.login ? "password" : "API token")
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

  const siteOf = (site: string | undefined) => (options.site ? { site: site ?? null } : {})
  const start = logsInOrOut(
    annotate(new Command("start"), {
      effects: FETCH,
      lifetime: "interactive",
      mcp: false,
      examples: [
        `${app.command} personal session start${options.site ? ` --site ${options.site.example}` : ""}${options.login ? " --login <name>" : ""}`,
        `${app.command} personal session start --credential-storage file`,
      ],
    }),
  )
    .summary(`sign in to ${service} with its ${word}`)
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
  if (options.guide) start.addHelpText("after", `\n${plainSetupText(options.guide)}`)
  if (options.login) start.option("--login <name>", `the ${service} user name the password belongs to`)
  if (options.site)
    start.option(
      "--site <address>",
      `the ${service} site, as https://${options.site.example} or ${options.site.example}`,
    )
  start.action(async function (
    this: Command,
    args: { credentialStorage: TokenStorage; site?: string; login?: string },
  ) {
    const { env, profile, tokens, run, renderer, keyring, streams } = contextOf(this)
    refuseCommandName(profile, commandWords(rootOf(this)), app.command)
    if (options.site && args.site === undefined)
      throw new CliError("validation_error", `give the ${service} site: --site ${options.site.example}`)
    const site = options.site && args.site !== undefined ? siteValue(args.site) : undefined
    const login = args.login?.trim()
    if (options.login && !login) throw new CliError("validation_error", `give the ${service} user name: --login <name>`)
    // Basic sign-in splits at the first colon, so a colon in the name would move part of it into the password.
    if (login?.includes(":")) throw new CliError("validation_error", "a user name with a colon cannot sign in")
    refuseOffline(this, service)
    const page = options.login?.page?.(site)
    const input = secretInputOf(this).input ?? process.stdin
    // Only a person at a terminal pastes it; piped in, the note would stand before the answer on stderr.
    if ((input as { isTTY?: boolean }).isTTY) {
      if (options.guide) {
        const link = drawsHyperlinks(env) ? hyperlink : undefined
        streams.diagnostic(`${plainSetupText(options.guide, link ? { link } : {})}\n\n`)
      }
      if (page) renderer.note(`the ${word} of ${login}: make one at ${page}, then paste it here`)
    }
    // A secret is never an argument: it would land in shell history and in the run record (WC-SECR-5).
    const secret = (await readSecret(`${service} ${word}: `, secretInputOf(this))).trim()
    if (!secret) throw new CliError("validation_error", `no ${word} was given`)
    const token = login === undefined ? secret : `${login}:${secret}`
    const { id, account } = await run((events) => options.verify(this, token, events, site))
    ;(options.claim ?? ((at, name, key) => rememberAccount(app, name, key, at)))(
      env,
      profile,
      siteAccount(site, id),
      tokens,
      keyring,
    )
    const storedIn = tokens.write(profile, token, args.credentialStorage, site === undefined ? {} : { site })
    answer(this, { profile, state: "saved", stored_in: storedIn, verified: true, ...siteOf(site), ...account })
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
      const site = options.site ? tokens.readWith(profile, SITE)?.secret : undefined
      const state = { profile, state: saved ? "saved" : "missing", token_from: saved?.source ?? null, ...siteOf(site) }
      if (!args.check || !saved) return answer(this, { ...state, verified: false })
      if (options.site && site === undefined) throw noSite(app, profile)
      refuseOffline(this, service)
      const { account } = await run((events) => options.verify(this, saved.secret, events, site))
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
    .description(
      `forget this profile's token on this computer; the token itself stays valid in ${service}` +
        (options.endNote ? `. ${options.endNote}` : ""),
    )
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
      const unknown = unknownSignIn(outputFor(this).renderer.warn)
      const items = profilesHere(app, configuredProfiles, env).map((profile) => {
        try {
          const saved = tokens.read(profile)
          return {
            profile,
            signed_in: saved !== undefined,
            state: saved ? "saved" : "missing",
            token_from: saved?.source ?? null,
          }
        } catch (error) {
          return { ...unknown(profile, error), token_from: null }
        }
      })
      renderAnswer(
        this,
        outputFor(this),
        listOf("session list", { items, limit: Math.max(1, items.length), has_more: false }),
      )
    })

  return annotate(new Command("session"), { effects: LOCAL_READ })
    .description(`keep this profile's ${service} ${word} in the OS keyring`)
    .addCommand(start)
    .addCommand(status)
    .addCommand(end)
    .addCommand(list)
}

const SITE = "site"

/**
 * The account a profile keeps: on a service of the owner's own site, `<site>:<id>`, as bitrix24-cli keeps
 * `<portal>:<user id>`. Each site numbers its users from 1, so the id alone would put two sites' records together.
 */
const siteAccount = (site: string | undefined, id: string): string => (site === undefined ? id : `${site}:${id}`)
const noSite = (app: AppIdentity, profile: string) =>
  new CliError(
    "authentication_error",
    `profile ${profile} is not signed in to a site — run \`${app.command} ${profile} session start --site <address>\``,
    { reason: "session.missing" },
  )

/**
 * The site this run's profile signed in to, as the `{ site }` server variable of `serviceApiCommand` (give it as is)
 * and `serviceApiCall` (give it the command's). It comes from where the token does: the profile's entry, or
 * `<PREFIX>_TOKEN_SITE` beside `<PREFIX>_TOKEN`; never one of each.
 */
export const signedInSite = (
  app: AppIdentity,
  resolveSettings: TokenSessionOptions["resolveSettings"],
): ((command: Command) => { site: string }) => {
  return (command) => {
    const { env, keyring, settings } = baseContext(command, resolveSettings)
    const tokens = new ProfileTokenStore({ app, env, ...(keyring ? { keyring } : {}) })
    const site = tokens.readWith(settings.profile, SITE)?.secret
    if (site === undefined) throw noSite(app, settings.profile)
    // <PREFIX>_TOKEN_SITE skips session start's cleaning, and `host/blog/..` would be the root site.
    return { site: siteValue(site) }
  }
}
