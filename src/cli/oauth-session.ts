import { CliError, isMovedRun, type KeyringStore, resolvePaths, systemKeyring } from "@wirecat/cli-base"
import type { OAuthFlow } from "@wirecat/cli-base/codegen"
import { annotate } from "@wirecat/cli-base/commands"
import { hostFetch } from "@wirecat/cli-base/http"
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
import type { TokenStorage } from "./profile-token.js"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import type { GlobalFlags, ResolveOptions, Settings } from "./settings.js"
import { storageOf } from "./token-session.js"

/** The authorization code flow an OpenAPI spec declares; a GraphQL service (Linear) writes the same object by hand. */
export const oauthFlowOf = (manifest: ServiceApiManifest, scheme?: string): OAuthFlow => {
  const schemes = Object.entries(manifest.securitySchemes ?? {}).filter(
    ([name, one]) => (scheme === undefined || name === scheme) && one.flows?.authorizationCode !== undefined,
  )
  const flow = schemes.length === 1 ? schemes[0]?.[1].flows?.authorizationCode : undefined
  if (!flow?.authorizationUrl || !flow.tokenUrl)
    throw new CliError(
      "configuration_error",
      schemes.length > 1
        ? `the api has ${schemes.length} OAuth sign-ins in the browser; name one`
        : `the api declares no OAuth authorization code flow with its URLs${scheme ? ` under ${scheme}` : ""}`,
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
  /** The provider sends a new refresh token on each refresh; a run with moved folders then never refreshes. */
  rotating?: boolean
}

export interface OAuthPreset {
  provider: OAuthProvider
  scopes: readonly string[]
  rotating: boolean
}

/** An installed app's sign-in (authorization code with PKCE) from the flow a spec declares, and the scopes it asks. */
export const oauthPreset = (flow: OAuthFlow, options: OAuthPresetOptions): OAuthPreset => {
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
  const plain = [flow.authorizationUrl, flow.tokenUrl, options.revokeUrl].find(
    (url) => url !== undefined && !url.startsWith("https://"),
  )
  // The code, the client secret and the tokens would cross the network in the clear.
  if (plain) throw new CliError("configuration_error", `${options.name} signs in at ${plain}, which is not https`)
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
  return { provider, scopes: [...options.scopes], rotating: options.rotating === true }
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
  /** The preset's `id` and `name`: `session list` and `status` read the sign-in without choosing a client. */
  providerId: string
  service: string
  /** From `oauthPreset`; the client is the CLI's own choice (a flag, a variable, the config, WireCat's app). */
  preset: (command: Command) => OAuthPreset
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
  const { app, providerId, service } = options
  const pathsOf = (env: NodeJS.ProcessEnv) => ({ appName: app.appName, prefix: app.envPrefix, env })
  const storageFor = (
    where: { env: NodeJS.ProcessEnv; keyring?: KeyringStore | undefined; warn?: (message: string) => void },
    profile: string,
    storage: "auto" | "file" | "keyring" = "auto",
    rotating = false,
  ) =>
    credentialStorage({
      credentials: {
        service: app.appName,
        configDir: resolvePaths(pathsOf(where.env)).config,
        storage,
        env: where.env,
        isolated: isMovedRun(pathsOf(where.env)),
        keyring: where.keyring ?? systemKeyring,
        ...(where.warn ? { warn: where.warn } : {}),
      },
      account: oauthAccount(providerId, profile),
      codec: rotating ? { ...standardCodec(providerId), rotating: true } : standardCodec(providerId),
    })
  const contextOf = (command: Command) => {
    const base = baseContext(command, options.resolveSettings)
    const environment = environmentOf<OAuthEnvironment>(command)
    const where = { env: base.env, keyring: base.keyring, warn: base.renderer.warn }
    const { profile } = base.settings
    /** The preset is asked only here, after the refusals: a CLI's client choice may fail on its own. */
    const keeperOf = (storage?: "file") => {
      const { provider, scopes, rotating } = options.preset(command)
      const keeper: TokenKeeper = tokenKeeper({
        provider,
        storage: storageFor(where, profile, storage ?? "auto", rotating),
        lockDir: resolvePaths(pathsOf(base.env)).config,
        // Only the provider's own sign-in hosts: a token request never reaches anything else.
        fetch:
          environment.fetch ??
          (hostFetch({
            hosts: [provider.authorizeUrl, provider.tokenUrl, provider.revokeUrl]
              .filter((url): url is string => url !== undefined)
              .map((url) => new URL(url).hostname),
          }) as typeof fetch),
        signInCommand: `${app.command} ${profile} session start`,
        ...(environment.signal ? { signal: environment.signal } : {}),
      })
      return { keeper, scopes }
    }
    const saved = () => storageFor(where, profile).read()
    return { ...base, environment, where, profile, keeperOf, saved }
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
    .summary(`sign in to ${service} in the browser`)
    .description(
      `sign this profile in to ${service} in the browser; the account is checked before anything is kept, in the ` +
        "keyring or, with --credential-storage file, a private file",
    )
    .option("--no-browser", "print the sign-in URL instead of opening a browser")
    .option(
      "--credential-storage <storage>",
      "where the sign-in is kept: keyring, which falls back to a private file by itself, or file",
      storageOf,
      "keyring" as TokenStorage,
    )
    .action(async function (this: Command, args: { browser: boolean; credentialStorage: TokenStorage }) {
      const context = contextOf(this)
      refuseCommandName(context.profile, commandWords(rootOf(this)), app.command)
      refuseOffline(this, service)
      const { keeper, scopes: asked } = context.keeperOf(args.credentialStorage === "file" ? "file" : undefined)
      const { streams } = outputFor(this)
      const steps = signInSteps({
        diagnostic: (line) => streams.diagnostic(`${line}\n`),
        json: context.format !== "pretty" || context.environment.tty === false,
        answers: false,
      })
      let shown: Readonly<Record<string, unknown>> = {}
      const { scopes } = await context.run((events) =>
        keeper.signIn({
          scopes: asked,
          openBrowser: async (url) => {
            if (args.browser) await context.environment.openBrowser?.(url, this)
          },
          showUrl: (url) => {
            steps.openUrl(url, `Sign in to ${service} and allow access`)
            streams.diagnostic(`Open ${service} sign-in: ${url}\n`)
          },
          // Before anything is saved, so a refused account leaves the profile's sign-in as it was.
          accept: async (tokens) => {
            if (!tokens.accessToken) throw new CliError("authentication_error", `${service} returned no access token`)
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
      // The owner chose the file: an older keyring copy must not outlive it with a live refresh token.
      if (args.credentialStorage === "file")
        try {
          storageFor(context.where, context.profile, "keyring").remove()
        } catch {
          // No keyring on this computer: there is no copy to forget.
        }
      answer(this, { ...shown, profile: context.profile, signed_in: true, scopes })
    })

  const status = annotate(new Command("status"), {
    effects: REMOTE_READ,
    examples: [`${app.command} personal session status`, `${app.command} personal session status --check --json`],
  })
    .summary("show this profile's sign-in; tokens are never printed")
    .description(`show this profile's sign-in and its scopes, never a token; --check asks ${service} whose it is`)
    .option("--check", `ask ${service} whether the sign-in still works, and whose it is`)
    .action(async function (this: Command, args: { check?: boolean }) {
      const context = contextOf(this)
      const saved = context.saved()
      if (!saved) return answer(this, { profile: context.profile, state: "missing", verified: false })
      const state = { profile: context.profile, state: "saved", scopes: saved.tokens.scopes }
      if (!args.check) return answer(this, { ...state, verified: false })
      refuseOffline(this, service)
      const { keeper } = context.keeperOf()
      const { account } = await context.run(async (events) => options.verify(this, await keeper.accessToken(), events))
      answer(this, { ...account, ...state, verified: true })
    })

  const end = logsInOrOut(
    annotate(new Command("end"), {
      effects: LOCAL_WRITE,
      mcp: false,
      examples: [`${app.command} personal session end`],
    }),
  )
    .summary("sign this profile out on this computer")
    .description(
      `forget this profile's sign-in on this computer; the grant stays in ${service}, and a run with moved folders ` +
        "never removes the owner's sign-in",
    )
    .action(async function (this: Command) {
      const context = contextOf(this)
      if (!context.saved()) return answer(this, { profile: context.profile, ended: false })
      const { removed } = await context.keeperOf().keeper.signOut()
      if (!context.saved()) return answer(this, { profile: context.profile, ended: true, removed })
      answer(this, {
        profile: context.profile,
        ended: false,
        removed,
        why: isMovedRun(pathsOf(context.env))
          ? "this run has moved folders: the owner's sign-in in the system keyring stays, and this run still reads it"
          : "the sign-in could not be removed from the keyring",
      })
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
      const environment = environmentOf<OAuthEnvironment>(this)
      const env = environment.env ?? process.env
      const { configuredProfiles } = options.resolveSettings({}, { env, needsProfile: false })
      const where = { env, keyring: environment.keyring, warn: outputFor(this).renderer.warn }
      const items = profilesHere(app, configuredProfiles, env).map((profile) => ({
        profile,
        signed_in: storageFor(where, profile).read() !== undefined,
      }))
      renderAnswer(
        this,
        outputFor(this),
        listOf("session list", { items, limit: Math.max(1, items.length), has_more: false }),
      )
    })

  return annotate(new Command("session"), { effects: LOCAL_READ })
    .description(`sign in to ${service} in the browser and manage this profile's sign-in`)
    .addCommand(start)
    .addCommand(status)
    .addCommand(end)
    .addCommand(list)
}
