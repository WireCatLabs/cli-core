import { toJsonSchema } from "@valibot/to-json-schema"
import { CliError, isCliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type * as v from "valibot"
import { agentOf } from "../runs/run-context.js"
import {
  type Current,
  checkField,
  type Field,
  holds,
  type Known,
  nextOf,
  type Outcome,
  walk,
} from "../setup/answers.js"
import type { Setup } from "../setup/define.js"
import { type Block, SETUP_LIMITS, type SetupDocument, type Step, type Value } from "../setup/document.js"
import { answerStdinOption, lineReader, type SignInSteps, signInSteps } from "../terminal/sign-in-steps.js"
import { refuseGuardedKey } from "./config-command.js"
import { baseContext, environmentOf, secretInputOf } from "./context.js"
import { FETCH, LOCAL_READ, logsInOrOut, refuseUnderReadOnly } from "./effects.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { systemLanguage } from "./first-run.js"
import { bufferedInput } from "./input-policy.js"
import { rememberAccount } from "./messenger/accounts.js"
import { ProfileTokenStore } from "./profile-token.js"
import { fromFile, NONE_NAMED } from "./settings.js"

type Answers = Record<string, unknown>

const fieldsOf = (blocks: readonly Block[] = []): Field[] =>
  blocks.flatMap((block) =>
    block.type === "group" ? fieldsOf(block.blocks) : block.type === "input" || block.type === "choice" ? [block] : [],
  )

const allFields = (document: SetupDocument): Field[] =>
  Object.values(document.steps).flatMap((step) => fieldsOf(step.blocks))

const secretOf = (field: Field) => (field.type === "input" ? field.secret : undefined)

/** `token` is the profile's own token, as `session start` keeps it; any other name is a secret beside it. */
const readKept = (store: ProfileTokenStore, profile: string, name: string) =>
  name === "token" ? store.read(profile) : store.readSecret(profile, name)

const settingJsonSchema = (schema: v.GenericSchema): Record<string, unknown> => {
  const inner = "wrapped" in schema ? (schema.wrapped as v.GenericSchema) : schema
  const { $schema: _, ...json } = toJsonSchema(inner, { errorMode: "ignore" }) as Record<string, unknown>
  return json
}

/** The setup group a CLI gets by describing its flow: `show`, `apply`, `run` and the terminal walk-through. */
export const setupCommand = (setup: Setup): Command => {
  const { app, configuration, check, ownerOnly = {} } = setup.definition
  const cli = app.command
  const { document } = setup

  // A read never creates the settings file, and a file with a bad key still shows the flow.
  const contextFor = (command: Command, needsProfile: boolean, readOnly = false) =>
    baseContext(command, (flags, options) =>
      configuration.resolveSettings(flags, {
        ...options,
        needsProfile,
        ...(readOnly ? { readOnly, withIssues: true } : {}),
      }),
    )

  const storeFor = (command: Command, warn: (message: string) => void) => {
    const environment = environmentOf(command)
    return new ProfileTokenStore({
      app,
      env: environment.env ?? process.env,
      ...(environment.keyring ? { keyring: environment.keyring } : {}),
      warn,
    })
  }

  const currentOf = (command: Command, context: ReturnType<typeof contextFor>): Current => {
    const { settings, renderer } = context
    const current: Record<string, Value | { set: true }> = {}
    const store = storeFor(command, renderer.warn)
    for (const field of allFields(document)) {
      if (field.setting !== undefined) {
        const value = fromFile<Value | undefined>(settings, field.setting, undefined).value
        if (value !== undefined) current[field.setting] = value
      }
      const secret = secretOf(field)
      if (secret === undefined || current[secret]) continue
      try {
        if (readKept(store, settings.profile, secret)) current[secret] = { set: true }
      } catch {
        // A keyring that cannot be read says nothing about the secret; the flow asks for it again.
      }
    }
    return current
  }

  const described = (): SetupDocument => {
    const withSchema = (blocks: readonly Block[] = []): Block[] =>
      blocks.map((block) => {
        if (block.type === "group") return { ...block, blocks: withSchema(block.blocks) }
        if ((block.type !== "input" && block.type !== "choice") || block.setting === undefined) return block
        const schema = configuration.settingSchema(block.setting)
        return schema ? { ...block, schema: settingJsonSchema(schema) } : block
      })
    const steps = Object.fromEntries(
      Object.entries(document.steps).map(([id, step]): [string, Step] => [
        id,
        step.blocks ? { ...step, blocks: withSchema(step.blocks) } : step,
      ]),
    )
    return { ...document, steps }
  }

  const readAnswers = async (
    command: Command,
    lines?: () => Promise<string>,
    { noneAllowed = false } = {},
  ): Promise<Answers> => {
    const input = environmentOf(command).stdin ?? process.stdin
    if (!lines && input.isTTY)
      throw new CliError("validation_error", `pipe the answers as one JSON object on stdin: echo '{…}' | ${cli} …`, {
        reason: "input.required",
      })
    const text = lines ? await lines() : (await bufferedInput(input, { maxBytes: SETUP_LIMITS.bytes })).toString("utf8")
    // A dry run of no answers names the first step to ask, and lets a contract learn the command's permission key.
    if (noneAllowed && text.trim() === "") return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new CliError("validation_error", "the answers on stdin are not JSON — one object, input id → value", {
        reason: "input.invalid",
      })
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new CliError("validation_error", "the answers on stdin are one object, input id → value", {
        reason: "input.invalid",
      })
    return parsed as Answers
  }

  /** The one way answers are checked and saved, for `apply`, `run apply` and the terminal alike. */
  const apply = async (
    command: Command,
    answers: Answers,
    { dryRun, steps }: { dryRun: boolean; steps: SignInSteps },
  ) => {
    const context = contextFor(command, true, dryRun)
    const { settings, env } = context
    const profile = settings.profile
    const path = walk(setup, answers, { current: currentOf(command, context) })
    const reached = path.stopped === "run" || path.stopped === "done"
    const told = {
      profile,
      path: path.path,
      at: path.at,
      errors: path.errors,
      dropped: path.dropped,
    }
    if (dryRun) return { valid: path.errors.length === 0, complete: reached, ...told }
    if (path.errors.length > 0)
      throw new CliError(
        "validation_error",
        path.errors.map(({ input, message }) => `${input} ${message}`).join("; "),
        { reason: "input.invalid", ...told },
      )
    if (!reached)
      throw new CliError("validation_error", `the answers stop at ${path.at}, before the flow's check`, {
        reason: "input.incomplete",
        ...told,
      })
    refuseUnderReadOnly(command, "setup")
    // An agent's own shell counts too, as for `config set` (SEC-116).
    if (environmentOf(command).agent || agentOf(env))
      for (const [setting, value] of Object.entries(path.settings)) refuseGuardedKey(setting, String(value), ownerOnly)
    steps.progress("check", `checking ${profile}'s settings`)
    const { keep = {}, ...checked } =
      (await check?.({
        command,
        profile,
        settings: { ...settings, configured: { ...settings.configured, ...path.settings } },
        secrets: path.secrets,
        answers: path.kept,
        steps,
      })) ?? {}
    const secrets = { ...path.secrets }
    for (const [name, secret] of Object.entries(keep.secrets ?? {})) {
      if (!(name in secrets)) throw new Error(`the flow's check keeps secret ${name}, which the answers did not give`)
      secrets[name] = secret
    }
    for (const [setting, value] of Object.entries(path.settings))
      configuration.changeSetting(settings.configPath, { profile, setting, value: JSON.stringify(value) })
    const store = storeFor(command, context.renderer.warn)
    const kept = Object.entries(secrets).map(([name, secret]) =>
      name === "token" ? store.write(profile, secret) : store.writeSecret(profile, name, secret),
    )
    rememberAccount(app, profile, keep.account ?? profile, env)
    return {
      outcome: "ok" as const,
      ...told,
      saved: Object.keys(path.settings),
      secrets: Object.keys(path.secrets),
      stored_in: kept[0] ?? null,
      ...checked,
    }
  }

  const stepsFor = (command: Command, json: boolean, lines?: () => Promise<string>) =>
    signInSteps({
      diagnostic: contextFor(command, false, true).streams.diagnostic,
      json,
      answers: lines !== undefined,
      ...(lines ? { lines } : {}),
    })

  const show = annotate(new Command("show"), {
    effects: LOCAL_READ,
    examples: [`${cli} setup show --json`, `${cli} office setup show --json`],
  })
    .summary("print the connection flow as JSON, for WireCat Desktop")
    .description(
      "print the connection flow as a WireCat setup document: steps, texts in every language, and each setting's " +
        "own JSON Schema; with a profile it adds the profile's current values, a secret only as { set: true }",
    )
    .action(function (this: Command) {
      const context = contextFor(this, false, true)
      const named = context.settings.sources.profile !== NONE_NAMED
      const body = { ...described(), ...(named ? { values: currentOf(this, context) } : {}) }
      renderAnswer(this, context, itemOf(body))
    })

  const applyCommand = annotate(new Command("apply"), {
    effects: FETCH,
    mcp: false,
    examples: [`${cli} office setup apply --dry-run --json`, `${cli} office setup apply --json`],
  })
    .summary("check the answers on stdin against the flow, and save them")
    .description(
      "read the answers as one JSON object on stdin (input id → value), keep only those on the path they lead to, " +
        "check each with its setting's own schema, then run the CLI's check and save the settings and secrets; " +
        "--dry-run only checks and saves nothing",
    )
    .option("--dry-run", "check the answers, and save nothing")
    .action(async function (this: Command, { dryRun }: { dryRun?: boolean }) {
      const answers = await readAnswers(this, undefined, { noneAllowed: dryRun === true })
      const result = await apply(this, answers, { dryRun: dryRun === true, steps: stepsFor(this, false) })
      renderAnswer(this, contextFor(this, false, true), itemOf(result))
    })

  const runCommand = logsInOrOut(
    annotate(new Command("run"), {
      effects: FETCH,
      lifetime: "interactive",
      mcp: false,
      examples: [`${cli} office setup run apply --json --answer-stdin`],
    }),
  )
    .summary("run one step of the flow, as WireCat Desktop does")
    .description(
      "run one run step of the flow: apply checks the answers, runs the CLI's check and saves; the sign-in events " +
        "go to stderr as JSON lines and the result to stdout; with --answer-stdin the answers are stdin's first line",
    )
    .argument("<action>", "the step's action: apply")
    .addOption(answerStdinOption())
    .action(async function (this: Command, action: string, { answerStdin }: { answerStdin?: boolean }) {
      if (action !== "apply")
        throw new CliError("validation_error", `setup run takes apply; ${action} is not a run action of v1`, {
          reason: "input.invalid",
        })
      const json = this.optsWithGlobals<{ json?: boolean; jsonl?: boolean }>()
      const machine = json.json === true || json.jsonl === true
      const input = environmentOf(this).stdin ?? process.stdin
      const lines = answerStdin ? lineReader(input) : undefined
      const steps = stepsFor(this, machine, lines)
      const answers = await readAnswers(this, lines)
      renderAnswer(this, contextFor(this, false, true), itemOf(await apply(this, answers, { dryRun: false, steps })))
    })

  const group = logsInOrOut(
    annotate(new Command("setup"), {
      effects: FETCH,
      lifetime: "interactive",
      mcp: false,
      examples: [`${cli} office setup`, `${cli} setup show --json`],
    }),
  )
    .summary("connect this profile, question by question")
    .description(
      `connect this profile to ${cli}: the same questions WireCat Desktop shows, asked in the terminal, checked, ` +
        "and saved only when the check succeeds; show, apply and run are the same flow for programs",
    )
    .action(async function (this: Command) {
      await walkThrough(this)
    })
  group.addCommand(show)
  group.addCommand(applyCommand)
  group.addCommand(runCommand)

  const walkThrough = async (command: Command) => {
    const context = contextFor(command, true)
    const { renderer, env } = context
    const current = currentOf(command, context)
    const language = systemLanguage(env) ?? "en"
    const text = (id: string | undefined, params: Record<string, string> = {}) =>
      id === undefined
        ? ""
        : (document.texts[language]?.[id] ?? document.texts.en[id] ?? id).replace(
            /\{([a-z][a-z0-9_]*)\}/g,
            (all: string, name: string) => params[name] ?? all,
          )
    const say = (line: string) => renderer.note(line)
    const environment = environmentOf(command)
    const input = secretInputOf(command)
    const ask = async (prompt: string, hidden: boolean): Promise<string> => {
      if (environment.answer) {
        const answer = await environment.answer(prompt)
        if (answer === null)
          throw new CliError(
            "validation_error",
            `${cli} setup asks questions — run it in a terminal, or pipe the answers to setup apply`,
            {
              reason: "input.required",
            },
          )
        return answer
      }
      const { readSecret } = await import("../terminal/prompt.js")
      return readSecret(prompt, { ...input, echo: !hidden })
    }

    const answers: Answers = {}
    const results: Record<string, Outcome> = {}
    const known: Known = {
      field: (id) => {
        if (Object.hasOwn(answers, id)) return answers[id]
        const setting = allFields(document).find((field) => field.id === id)?.setting
        return setting === undefined ? undefined : current[setting]
      },
      result: (name) => results[name],
    }

    const coerce = (field: Field, typed: string): unknown => {
      const raw = typed.trim()
      if (raw === "") return undefined
      const options = field.options ?? []
      const pick = (one: string) => options[Number(one) - 1]?.value ?? one
      const kind = field.type === "choice" ? "select" : field.input
      if (kind === "select") return pick(raw)
      if (kind === "multiselect" || kind === "countries")
        return raw
          .split(",")
          .map((one) => one.trim())
          .filter(Boolean)
          .map((one) => (kind === "countries" ? one.toUpperCase() : pick(one)))
      if (kind === "number" || kind === "port") return Number.isNaN(Number(raw)) ? raw : Number(raw)
      if (kind === "toggle") return /^(y|yes|true)$/i.test(raw) ? true : /^(n|no|false)$/i.test(raw) ? false : raw
      return raw
    }

    const askField = async (field: Field) => {
      const bound = field.setting ?? secretOf(field)
      const now = bound === undefined ? undefined : current[bound]
      const options = field.options ?? []
      for (const [index, option] of options.entries())
        say(`  ${index + 1}) ${text(option.label)}${option.hint ? ` — ${text(option.hint)}` : ""}`)
      if (field.hint) say(text(field.hint))
      const kept =
        now === undefined || secretOf(field) !== undefined
          ? field.default === undefined
            ? ""
            : ` [${field.default}]`
          : ` [${now}]`
      const label = field.label ? text(field.label) : options.length ? "Your choice" : field.id
      // A hidden prompt takes no empty answer, so keeping a saved secret is its own question.
      if (secretOf(field) !== undefined && now !== undefined) {
        const change = await ask(`${label}: change the saved one? [y/N] `, false)
        if (!/^\s*y(es)?\s*$/i.test(change)) return
      }
      const toggle = field.type === "input" && field.input === "toggle" ? " (y/n)" : ""
      for (let tries = 1; ; tries++) {
        const typed = await ask(`${label}${toggle}${kept}: `, field.type === "input" && field.input === "password")
        const checked = checkField(field, coerce(field, typed), {
          current,
          settingSchema: configuration.settingSchema,
        })
        if (!checked.problem) {
          if (checked.value !== undefined) answers[field.id] = checked.value
          return
        }
        if (tries >= 3)
          throw new CliError("validation_error", `${label} ${checked.problem}`, { reason: "input.invalid" })
        renderer.warn(`${label} ${checked.problem}`)
      }
    }

    const show = async (blocks: readonly Block[] = []) => {
      for (const block of blocks) {
        if (block.when && !holds(block.when, known)) continue
        switch (block.type) {
          case "text":
          case "note":
            say(text(block.text, block.params))
            break
          case "heading":
            say(`\n${text(block.text, block.params)}`)
            break
          case "code":
            say(`  ${block.code}`)
            break
          case "image":
            if (block.caption) say(text(block.caption))
            break
          case "link":
            say(`${text(block.text)}: ${block.href}`)
            break
          case "requirement":
            say(`${text(block.text)}${block.fix ? ` — ${text(block.fix)}` : ""}`)
            break
          case "group":
            if (block.title) say(`\n${text(block.title)}`)
            await show(block.blocks)
            break
          case "input":
          case "choice":
            await askField(block)
            break
          default:
            if (block.fallback) say(text(block.fallback))
        }
      }
    }

    const visited: string[] = []
    let at: string | undefined = document.start
    for (let moves = 0; at !== undefined && moves < SETUP_LIMITS.transitions; moves++) {
      const step: Step = document.steps[at] as Step
      visited.push(at)
      say(`\n${text(step.title)}`)
      await show(step.blocks)
      if (step.kind === "done") {
        renderAnswer(
          command,
          context,
          itemOf({ profile: context.settings.profile, finished: at, path: visited, results }),
        )
        return
      }
      if (step.kind === "run") {
        const name = step.result ?? at
        try {
          await apply(command, answers, { dryRun: false, steps: stepsFor(command, false) })
          results[name] = { outcome: "ok" }
          say("saved")
        } catch (error) {
          if (!isCliError(error)) throw error
          results[name] = { outcome: "error", code: error.code }
          renderer.warn(error.message)
        }
      }
      at = nextOf(step, known)
    }
    throw new CliError("validation_error", `${cli}'s setup flow stopped at ${at ?? visited.at(-1)} with no way on`)
  }

  return group
}
