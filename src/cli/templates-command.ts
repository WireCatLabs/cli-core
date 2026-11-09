import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { Command, Option } from "commander"
import type { MessageKind } from "../background/report/messages.js"
import {
  checkTemplate,
  defaultTemplate,
  REPORT_CHANNELS,
  type ReportChannel,
  renderReport,
} from "../background/report/render.js"
import {
  checkTemplateSave,
  previewView,
  reportKeyOf,
  reportKeysOf,
  shippedLanguages,
  TEMPLATE_KEYS,
  templateKeyOf,
} from "../background/report/stored-templates.js"
import { listSchedules } from "../background/schedules.js"
import { template } from "../entities/index.js"
import type { AppIdentity } from "../ports/app.js"
import { agentOf } from "../runs/run-context.js"
import { type MessageStore, openStore, type TemplateAddress } from "../store/store.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { type Body, itemOf, listOf } from "./envelope.js"
import { type QueryWords, queryTerms, withQuery } from "./list-query.js"
import { ownerLanguageOf, scheduleState } from "./schedule/schedule-command.js"

export interface TemplatesOptions {
  env: () => NodeJS.ProcessEnv
  output: (answer: Body, command: Command) => void
  diagnostic: (line: string) => void
  /** Opens `path` in the owner's editor and returns when it closes; `$VISUAL` or `$EDITOR` when absent. */
  editor?: (path: string, env: NodeJS.ProcessEnv) => void
}

const withStore = async <T>(env: NodeJS.ProcessEnv, work: (store: MessageStore) => T | Promise<T>) => {
  const store = await openStore({ env })
  try {
    return await work(store)
  } finally {
    await store.close()
  }
}

const systemEditor = (path: string, env: NodeJS.ProcessEnv) => {
  const editor = env.VISUAL?.trim() || env.EDITOR?.trim()
  if (!editor)
    throw new CliError("validation_error", "set VISUAL or EDITOR, or pass the template with --file", {
      reason: "template.no-editor",
    })
  const [program = editor, ...args] = editor.split(/\s+/)
  const ran = spawnSync(program, [...args, path], { stdio: "inherit", env })
  if (ran.status !== 0)
    throw new CliError("validation_error", `the editor exited with ${ran.status ?? ran.signal}; nothing was saved`)
}

const channelOption = () =>
  new Option("--channel <channel>", "telegram (Bot API HTML), email (HTML with inline styles) or text")
    .choices(REPORT_CHANNELS)
    .makeOptionMandatory()

const localeOption = () =>
  new Option("--locale <code>", "the template's language, ISO 639-1; the owner's first language if not given")

const TEMPLATES_QUERY: QueryRegistry = {
  entity: "template",
  backend: "native",
  fields: queryFieldsOf(template, {
    native: ["key", "channel", "language", "source"],
    exclude: ["about", "renders", "updated_at", "updated_by"],
    examples: { key: 'key:"report/morning-digest"', channel: "channel:telegram", language: "language:en" },
  }).map((field) => ({
    ...field,
    operators: field.operators.filter((operator) => operator === "term" || operator === "phrase"),
  })),
}

const matching = <T extends Record<string, unknown>>(rows: T[], terms: Map<string, string>): T[] =>
  rows.filter((row) => [...terms].every(([field, value]) => String(row[field]).toLowerCase() === value.toLowerCase()))

/** The key, its message kind and the language, refused when cli-core ships no template in that language. */
const addressOf = async (
  key: string,
  given: { channel: ReportChannel; locale?: string },
  env: NodeJS.ProcessEnv,
  state: string,
): Promise<{ address: TemplateAddress; kind: MessageKind; channel: ReportChannel; schedule?: string }> => {
  const known: ReturnType<typeof reportKeyOf> =
    templateKeyOf(key) ??
    reportKeyOf(key, [
      ...listSchedules(state, { kind: "agent" }).map((one) => one.name),
      // A removed schedule's templates stay in the store, and must still be shown and reset.
      ...(await withStore(env, (store) => store.templates.list())).flatMap((row) =>
        row.key.startsWith("report/") ? [row.key.slice("report/".length)] : [],
      ),
    ])
  if (!known)
    throw new CliError(
      "validation_error",
      `no template ${key}; the keys are ${TEMPLATE_KEYS.map((one) => one.key).join(", ")}, or report/<schedule> for an agent schedule's digest`,
      {
        reason: "template.unknown-key",
      },
    )
  const language = (given.locale ?? (await ownerLanguageOf(env))).trim().toLowerCase()
  const languages = shippedLanguages(known.kind)
  if (!languages.includes(language))
    throw new CliError(
      "validation_error",
      `${key} has templates in ${languages.join(", ")}; a ${language} one would never be used`,
      { reason: "template.unknown-language" },
    )
  return {
    address: { key, channel: given.channel, language },
    kind: known.kind,
    channel: given.channel,
    ...(known.schedule ? { schedule: known.schedule } : {}),
  }
}

/** The stored body that applies to `address`: its own, else the one its digest falls back to; undefined for shipped. */
const appliedBody = (store: MessageStore, address: TemplateAddress, kind: MessageKind, schedule?: string) =>
  reportKeysOf(kind, schedule)
    .map((key) => store.templates.get({ ...address, key })?.body)
    .find((body) => body !== undefined)

const refuseAgent = (env: NodeJS.ProcessEnv) => {
  // A template decides what every later digest says to the owner; an agent could make it hide or invent things.
  if (agentOf(env))
    throw new CliError("permission_error", "only the owner changes a message template, not an agent", {
      reason: "template.owner-only",
    })
}

const stateOf = (app: AppIdentity, env: NodeJS.ProcessEnv) => scheduleState({ app, env })

const historyOf = (store: MessageStore, address: TemplateAddress) =>
  store.templates.history(address).map((entry) => ({
    id: entry.id,
    saved_at: new Date(entry.savedAt).toISOString(),
    saved_by: entry.savedBy,
    replaced_at: new Date(entry.replacedAt).toISOString(),
    chars: entry.body.length,
  }))

/**
 * `templates`: the owner's own templates for the messages WireCat sends him, kept in the shared store over the ones
 * cli-core ships. The platform rules (escaping, the tags each channel keeps, links only to the report's own, the
 * Telegram size) stay in code and run after every render, so a template cannot break them.
 */
export const templatesCommand = (app: AppIdentity, options: TemplatesOptions): Command => {
  const editor = options.editor ?? systemEditor
  const templates = annotate(new Command("templates"), { effects: LOCAL_READ })
    .summary("the templates of the messages sent to you; edit, preview, reset")
    .description(
      "the templates of the digest and the other messages sent to you, per channel and language; edit, preview, reset",
    )

  withQuery(
    annotate(templates.command("list"), {
      effects: LOCAL_READ,
      examples: [`${app.command} templates list`, `${app.command} templates list channel:telegram language:en`],
    }),
    TEMPLATES_QUERY,
  )
    .summary("every template, and whether yours or the shipped one applies")
    .description("every template key, channel and language, and whether yours or the shipped one applies")
    .action(async function (this: Command, words: QueryWords) {
      const terms = queryTerms(words, TEMPLATES_QUERY, "templates list")
      const env = options.env()
      const stored = await withStore(env, (store) => store.templates.list())
      const own = [...new Set(stored.map((one) => one.key))].flatMap((key) => {
        const known = reportKeyOf(key, [key.slice("report/".length)])
        return known?.schedule ? [known] : []
      })
      const items = [...TEMPLATE_KEYS, ...own].flatMap((known) =>
        REPORT_CHANNELS.flatMap((channel) =>
          shippedLanguages(known.kind).map((language) => {
            const rowOf = (key: string) =>
              stored.find((one) => one.key === key && one.channel === channel && one.language === language)
            const row = rowOf(known.key)
            const inherited =
              !row && "schedule" in known && reportKeysOf(known.kind, known.schedule).some((key) => rowOf(key))
            return {
              key: known.key,
              channel,
              language,
              about: known.about,
              renders: true,
              source: row ? "stored" : inherited ? "inherited" : "default",
              updated_at: row ? new Date(row.updatedAt).toISOString() : null,
              updated_by: row?.updatedBy ?? null,
            }
          }),
        ),
      )
      const found = matching(items, terms)
      options.output(listOf("templates list", { items: found, limit: found.length, has_more: false }), this)
    })

  annotate(templates.command("show"), {
    effects: LOCAL_READ,
    examples: [`${app.command} templates show report/morning-digest --channel telegram`],
  })
    .summary("the template that applies, and the bodies your changes replaced")
    .description("the template that applies, yours or the shipped one, and the bodies your changes replaced")
    .argument("<key>", "the template, such as report/morning-digest")
    .addOption(channelOption())
    .addOption(localeOption())
    .action(async function (this: Command, key: string, given: { channel: ReportChannel; locale?: string }) {
      const env = options.env()
      const { address, kind, channel, schedule } = await addressOf(key, given, env, stateOf(app, env))
      const item = await withStore(env, (store) => {
        const row = store.templates.get(address)
        const applied = appliedBody(store, address, kind, schedule)
        return {
          ...address,
          source: row ? "stored" : applied === undefined ? "default" : "inherited",
          body: applied ?? defaultTemplate(kind, channel, address.language),
          updated_at: row ? new Date(row.updatedAt).toISOString() : null,
          updated_by: row?.updatedBy ?? null,
          history: historyOf(store, address),
        }
      })
      options.output(itemOf(item), this)
    })

  grantsAuthority(
    annotate(templates.command("edit"), {
      effects: LOCAL_WRITE,
      examples: [
        `${app.command} templates edit report/morning-digest --channel telegram`,
        `${app.command} templates edit report/morning-digest --channel text --file digest.text.liquid`,
        `${app.command} templates edit report/morning-digest --channel telegram --undo`,
      ],
    }),
  )
    .summary("change a template in $EDITOR or from --file; checked before it is saved")
    .description(
      "change a template in $EDITOR or from --file; it is checked first, and a failed check saves nothing and says why",
    )
    .argument("<key>", "the template, such as report/morning-digest")
    .addOption(channelOption())
    .addOption(localeOption())
    .option("--file <file>", "take the new template from this file instead of opening an editor; - reads stdin")
    .addOption(
      new Option("--undo", "put back the body your last change replaced; twice is back where you were").conflicts(
        "file",
      ),
    )
    .action(async function (
      this: Command,
      key: string,
      given: { channel: ReportChannel; locale?: string; file?: string; undo?: boolean },
    ) {
      const env = options.env()
      refuseAgent(env)
      const { address, kind, channel, schedule } = await addressOf(key, given, env, stateOf(app, env))
      const { current, previous } = await withStore(env, (store) => ({
        current: appliedBody(store, address, kind, schedule),
        previous: store.templates.history(address, 1)[0]?.body,
      }))
      const effective = current ?? defaultTemplate(kind, channel, address.language)
      let draft: string | undefined
      let body: string
      if (given.undo) {
        if (previous === undefined)
          throw new CliError(
            "validation_error",
            `${key} ${channel} ${address.language} has no earlier body to put back`,
            {
              reason: "template.no-history",
            },
          )
        body = previous
      } else if (given.file !== undefined) {
        body = readFileSync(given.file === "-" ? 0 : given.file, "utf8")
      } else {
        draft = join(
          mkdtempSync(join(tmpdir(), "wirecat-template-")),
          `${key.replace("/", "-")}.${channel}.${address.language}.liquid`,
        )
        writeFileSync(draft, effective, { mode: 0o600 })
        editor(draft, env)
        body = readFileSync(draft, "utf8")
      }
      if (body === effective) {
        if (draft) rmSync(join(draft, ".."), { recursive: true, force: true })
        options.diagnostic(`${key} ${channel} ${address.language} is unchanged; nothing saved`)
        options.output(itemOf({ ...address, changed: false }), this)
        return
      }
      const checks = await checkTemplateSave({
        kind,
        channel,
        language: address.language,
        body,
        state: stateOf(app, env),
        now: Date.now(),
        ...(schedule ? { schedule } : {}),
      })
      const problems = checks.flatMap((check) => check.problems.map((problem) => `${check.against}: ${problem}`))
      if (problems.length > 0)
        throw new CliError(
          "validation_error",
          `the template was not saved — ${problems.join("; ")}${
            draft ? `. Your text is in ${draft}; fix it and run again with --file ${draft}` : ""
          }`,
          { reason: "template.check-failed" },
        )
      const saved = await withStore(env, (store) => store.templates.save(address, body, app.command))
      if (draft) rmSync(join(draft, ".."), { recursive: true, force: true })
      options.diagnostic(
        `saved ${key} ${channel} ${address.language}; checked against ${checks.map((check) => check.against).join(" and ")}`,
      )
      options.output(
        itemOf({
          ...address,
          changed: true,
          updated_at: new Date(saved.updatedAt).toISOString(),
          updated_by: saved.updatedBy,
          checked_against: checks.map((check) => check.against),
        }),
        this,
      )
    })

  annotate(templates.command("preview"), {
    effects: LOCAL_READ,
    examples: [
      `${app.command} templates preview report/morning-digest --channel telegram`,
      `${app.command} templates preview report/morning-digest --channel email --file draft.liquid`,
    ],
  })
    .summary("what would be sent on that channel; saves nothing")
    .description(
      "what would be sent on that channel, from the last real report or a synthetic one when there is none; saves nothing",
    )
    .argument("<key>", "the template, such as report/morning-digest")
    .addOption(channelOption())
    .addOption(localeOption())
    .option("--file <file>", "preview this draft instead of the template that applies; - reads stdin")
    .action(async function (
      this: Command,
      key: string,
      given: { channel: ReportChannel; locale?: string; file?: string },
    ) {
      const env = options.env()
      const { address, kind, channel, schedule } = await addressOf(key, given, env, stateOf(app, env))
      const stored =
        given.file === undefined
          ? await withStore(env, (store) => appliedBody(store, address, kind, schedule))
          : undefined
      const body = given.file === undefined ? stored : readFileSync(given.file === "-" ? 0 : given.file, "utf8")
      const { against, view } = previewView(stateOf(app, env), kind, address.language, Date.now(), schedule)
      const rendering = await renderReport(view, channel, body === undefined ? {} : { template: body })
      const problems = body === undefined ? [] : (await checkTemplate(view, channel, body)).problems
      options.output(
        itemOf({
          ...address,
          template: given.file === undefined ? (stored === undefined ? "default" : "stored") : given.file,
          against,
          template_failed: rendering.templateFailed,
          problems,
          text: rendering.text,
        }),
        this,
      )
    })

  grantsAuthority(
    annotate(templates.command("reset"), {
      effects: LOCAL_WRITE,
      examples: [`${app.command} templates reset report/morning-digest --channel telegram`],
    }),
  )
    .summary("go back to the shipped template; edit --undo brings yours back")
    .description("go back to the shipped template; yours is kept in the history, and edit --undo brings it back")
    .argument("<key>", "the template, such as report/morning-digest")
    .addOption(channelOption())
    .addOption(localeOption())
    .action(async function (this: Command, key: string, given: { channel: ReportChannel; locale?: string }) {
      const env = options.env()
      refuseAgent(env)
      const { address } = await addressOf(key, given, env, stateOf(app, env))
      const changed = await withStore(env, (store) => store.templates.reset(address))
      options.diagnostic(
        changed
          ? `${key} ${address.channel} ${address.language} uses the shipped template again`
          : `${key} ${address.channel} ${address.language} already uses the shipped template`,
      )
      options.output(itemOf({ ...address, changed }), this)
    })

  return templates
}
