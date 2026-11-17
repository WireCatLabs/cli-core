import { CliError, isMovedRun, type KeyringStore, resolvePaths, systemKeyring } from "@wirecat/cli-base"
import type { OAuthFlow } from "@wirecat/cli-base/codegen"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { type TokenKeeper, tokenKeeper } from "../oauth/keeper.js"
import type { OAuthClient, OAuthProvider } from "../oauth/provider.js"
import { credentialStorage, oauthAccount, standardCodec } from "../oauth/storage.js"
import type { AppIdentity } from "../ports/app.js"
import type { EventSink } from "../runs/events.js"
import { editDistance } from "../search/correct.js"
import { signInSteps } from "../terminal/sign-in-steps.js"
import { type BaseEnvironment, baseContext, environmentOf, outputFor } from "./context.js"
import { refuseOffline } from "./early-refusal.js"
import { LOCAL_READ, LOCAL_WRITE, logsInOrOut, REMOTE_READ, REMOTE_WRITE } from "./effects.js"
import { itemOf, listOf, renderAnswer } from "./envelope.js"
import { profilesHere, rememberAccount } from "./messenger/accounts.js"
import { commandWords, profileFree, refuseCommandName, rootOf } from "./profile.js"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import type { GlobalFlags, ResolveOptions, Settings } from "./settings.js"

/** The authorization code flow an OpenAPI spec declares; a GraphQL service (Linear) writes the same object by hand. */
export const oauthFlowOf = (manifest: ServiceApiManifest, scheme?: string): OAuthFlow => {
  const schemes = Object.entries(manifest.securitySchemes ?? {}).filter(
    ([name, one]) => (scheme === undefined || name === scheme) && one.type === "oauth2",
  )
  const flow = schemes.length === 1 ? schemes[0]?.[1].flows?.authorizationCode : undefined
  if (!flow?.authorizationUrl || !flow.tokenUrl)
    throw new CliError(
      "configuration_error",
      schemes.length > 1
        ? `the api has ${schemes.length} OAuth schemes; name one`
        : "the api declares no OAuth authorization code flow with its URLs",
    )
  return flow
}

export interface OAuthPresetOptions {
  /** A short word, part of the keyring account: `attio`. */
  id: string
  /** The name people know: `Attio`. */
  name: string
  client: OAuthClient
  /** What the CLI asks for; each must be one the flow lists. */
  scopes: readonly string[]
  /** The spec cannot say which redirect the app registered; a provider that wants an exact one needs `relay`. */
  redirect: OAuthProvider["redirect"]
  revokeUrl?: string
  authorizeParams?: Record<string, string>
}

/** An installed app's sign-in (authorization code with PKCE) from the flow a spec declares, and the scopes it asks. */
export const oauthPreset = (flow: OAuthFlow, options: OAuthPresetOptions) => {
  const known = Object.keys(flow.scopes)
  const unknown = options.scopes.filter((scope) => !known.includes(scope))
  if (unknown.length)
    throw new CliError(
      "configuration_error",
      unknown
        .map((scope) => {
          const near = known.find((one) => editDistance(scope, one, 2) <= 2)
          return `the ${options.name} sign-in has no scope ${scope}${near ? `; did you mean ${near}?` : ""}`
        })
        .join("; "),
    )
  if (flow.refreshUrl && flow.refreshUrl !== flow.tokenUrl)
    throw new CliError("configuration_error", `${options.name} refreshes at another URL, which the sign-in cannot use`)
  const provider: OAuthProvider = {
    id: options.id,
    name: options.name,
    authorizeUrl: flow.authorizationUrl as string,
    tokenUrl: flow.tokenUrl as string,
    client: options.client,
    redirect: options.redirect,
    ...(options.revokeUrl ? { revokeUrl: options.revokeUrl } : {}),
    ...(options.authorizeParams ? { authorizeParams: options.authorizeParams } : {}),
  }
  return { provider, scopes: [...options.scopes] }
}

/** What the CLI's entry hands `run()` beside cli-core's own; a test hands a fake service and browser. */
export interface OAuthEnvironment extends BaseEnvironment {
  fetch?: typeof fetch
  /** Gets the command, so the entry opens nothing under `--json`, `--no-input`, CI or without a terminal. */
  openBrowser?: (url: string, command?: Command) => Promise<void>
}

export interface OAuthSessionOptions {
  app: AppIdentity
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /** From `oauthPreset`; the client is the CLI's own choice (a flag, a variable, the config, WireCat's app). */
  preset: (command: Command) => { provider: OAuthProvider; scopes: readonly string[] }
  /** Asks the service whose the access token is; `id` names the account, `account` is what start and status show. */
  verify: (
    command: Command,
    accessToken: string,
    events: EventSink,
  ) => Promise<{ id: string; account: Readonly<Record<string, unknown>> }>
  /** Runs before anything is saved; by default only remembers the account. A CLI that refuses a taken one throws. */
  claim?: (env: NodeJS.ProcessEnv, profile: string, id: string) => void
}

/**
 * `session start | status | end | list` for a service signed in in the browser (WC-SECR-22): PKCE on the loopback,
 * the account checked before the tokens are kept, refreshes under one lock, and a run with moved folders that never
 * removes the owner's sign-in.
 */
export const oauthSessionCommand = (options: OAuthSessionOptions): Command => {
  const { app } = options
  const pathsOf = (env: NodeJS.ProcessEnv) => ({ appName: app.appName, prefix: app.envPrefix, env })
  const storageFor = (
    env: NodeJS.ProcessEnv,
    keyring: KeyringStore | undefined,
    providerId: string,
    profile: string,
    storage: "auto" | "file" = "auto",
  ) =>
    credentialStorage({
      credentials: {
        service: app.appName,
        configDir: resolvePaths(pathsOf(env)).config,
        storage,
        env,
        isolated: isMovedRun(pathsOf(env)),
        keyring: keyring ?? systemKeyring,
      },
      account: oauthAccount(providerId, profile),
      codec: standardCodec(providerId),
    })
  const contextOf = (command: Command, storage?: "file") => {
    const base = baseContext(command, options.resolveSettings)
    const { provider, scopes } = options.preset(command)
    const { profile } = base.settings
    const keeper: TokenKeeper = tokenKeeper({
      provider,
      storage: storageFor(base.env, base.keyring, provider.id, profile, storage),
      lockDir: resolvePaths(pathsOf(base.env)).config,
      fetch: environmentOf<OAuthEnvironment>(command).fetch ?? fetch,
      signInCommand: `${app.command} ${profile} session start`,
    })
    const saved = () => storageFor(base.env, base.keyring, provider.id, profile).read()
    return { ...base, profile: base.settings.profile, provider, scopes, keeper, saved }
  }
  const answer = (command: Command, item: unknown) => renderAnswer(command, outputFor(command), itemOf(item))

  const start = logsInOrOut(
    annotate(new Command("start"), {
      effects: REMOTE_WRITE,
      lifetime: "interactive",
      mcp: false,
      examples: [`${app.command} personal session start`, `${app.command} personal session start --no-browser`],
    }),
  )
    .summary("sign in in the browser")
    .description(
      "sign this profile in in the browser; the account is checked before anything is kept, in the keyring or, with " +
        "--credential-storage file, a private file",
    )
    .option("--no-browser", "print the sign-in URL instead of opening a browser")
    .option("--credential-storage <storage>", "where the sign-in is kept: keyring, which falls back to a file, or file")
    .action(async function (this: Command, args: { browser: boolean; credentialStorage?: string }) {
      if (args.credentialStorage !== undefined && !["keyring", "file"].includes(args.credentialStorage))
        throw new CliError(
          "validation_error",
          `--credential-storage takes keyring or file; got ${args.credentialStorage}`,
        )
      const context = contextOf(this, args.credentialStorage === "file" ? "file" : undefined)
      refuseCommandName(context.profile, commandWords(rootOf(this)), app.command)
      refuseOffline(this, context.provider.name)
      const environment = environmentOf<OAuthEnvironment>(this)
      const { streams } = outputFor(this)
      const steps = signInSteps({
        diagnostic: (line) => streams.diagnostic(`${line}\n`),
        json: context.format !== "pretty" || environment.tty === false,
        answers: false,
      })
      let shown: Readonly<Record<string, unknown>> = {}
      const { scopes } = await context.run((events) =>
        context.keeper.signIn({
          scopes: context.scopes,
          openBrowser: async (url) => {
            if (args.browser) await environment.openBrowser?.(url, this)
          },
          showUrl: (url) => {
            steps.openUrl(url, `Sign in to ${context.provider.name} and allow access`)
            streams.diagnostic(`Open ${context.provider.name} sign-in: ${url}\n`)
          },
          // Before anything is saved, so a refused account leaves the profile's sign-in as it was.
          accept: async (tokens) => {
            if (!tokens.accessToken)
              throw new CliError("authentication_error", `${context.provider.name} returned no access token`)
            const { id, account } = await options.verify(this, tokens.accessToken, events)
            ;(options.claim ?? ((env, profile, key) => rememberAccount(app, profile, key, env)))(
              context.env,
              context.profile,
              id,
            )
            shown = account
            return undefined
          },
        }),
      )
      answer(this, { profile: context.profile, signed_in: true, scopes, ...shown })
    })

  const status = annotate(new Command("status"), {
    effects: REMOTE_READ,
    examples: [`${app.command} personal session status`, `${app.command} personal session status --check --json`],
  })
    .summary("show this profile's sign-in; tokens are never printed")
    .description("show this profile's sign-in and its scopes, never a token; --check asks the service whose it is")
    .option("--check", "ask the service whether the sign-in still works, and whose it is")
    .action(async function (this: Command, args: { check?: boolean }) {
      const context = contextOf(this)
      const saved = context.saved()
      if (!saved) return answer(this, { profile: context.profile, state: "missing", verified: false })
      const state = { profile: context.profile, state: "saved", scopes: saved.tokens.scopes }
      if (!args.check) return answer(this, { ...state, verified: false })
      refuseOffline(this, context.provider.name)
      const { account } = await context.run(async (events) =>
        options.verify(this, await context.keeper.accessToken(), events),
      )
      answer(this, { ...state, verified: true, ...account })
    })

  const end = logsInOrOut(
    annotate(new Command("end"), {
      effects: LOCAL_WRITE,
      mcp: false,
      examples: [`${app.command} personal session end`],
    }),
  )
    .summary("sign this profile out on this computer")
    .description("forget this profile's sign-in on this computer; a run with moved folders never removes the owner's")
    .action(async function (this: Command) {
      const context = contextOf(this)
      if (!context.saved()) return answer(this, { profile: context.profile, ended: false })
      const { removed } = await context.keeper.signOut()
      // A run with moved folders removes only its own entry, and still reads the owner's, which it never removes.
      if (context.saved())
        return answer(this, {
          profile: context.profile,
          ended: false,
          removed,
          why: "this run has moved folders: the owner's sign-in in the system keyring stays, and this run still reads it",
        })
      answer(this, { profile: context.profile, ended: true, removed })
    })

  const list = profileFree(
    annotate(new Command("list"), {
      effects: LOCAL_READ,
      examples: [`${app.command} session list`, `${app.command} session list --json`],
    }),
  )
    .summary("list the profiles here and whether each is signed in")
    .description("list the profiles on this computer and whether each is signed in; picks none")
    .action(function (this: Command) {
      const environment = environmentOf(this)
      const env = environment.env ?? process.env
      const { configuredProfiles } = options.resolveSettings({}, { env, needsProfile: false })
      const { provider } = options.preset(this)
      const items = profilesHere(app, configuredProfiles, env).map((profile) => ({
        profile,
        signed_in: storageFor(env, environment.keyring, provider.id, profile).read() !== undefined,
      }))
      renderAnswer(
        this,
        outputFor(this),
        listOf("session list", { items, limit: Math.max(1, items.length), has_more: false }),
      )
    })

  return annotate(new Command("session"), { effects: LOCAL_READ })
    .description("sign in in the browser and manage this profile's sign-in")
    .addCommand(start)
    .addCommand(status)
    .addCommand(end)
    .addCommand(list)
}
