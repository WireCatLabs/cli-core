import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { defineQuery } from "@wirecat/cli-base/query"
import { Argument, Command } from "commander"
import { REGISTRIES, registriesCover } from "../../botcheck/registries.js"
import { secretInput } from "../../runs/run-context.js"
import { levelFor } from "../../sends/permissions.js"
import { phoneOf } from "../../services/index.js"
import { dateWindow } from "../../services/moment.js"
import { maskedAccount } from "../../services/people.js"
import { CHAT_MESSAGES, CONTEXT_BYTES, CONTEXT_MESSAGES } from "../../services/person-context.js"
import { SCOPES, type Scope, TIMELINE_ITEMS } from "../../services/person-timeline.js"
import { readSecret } from "../../terminal/prompt.js"
import { secretInputOf } from "../context.js"
import { FETCH, LOCAL_WRITE, REMOTE_READ } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, nativeField, nativeTerms, termField, timeBounds, typedQuery, withQuery } from "../list-query.js"
import { positiveCount, window, withPaging } from "../paging.js"
import { casKey } from "../registry-keys.js"
import { commandAt, nextStep } from "../steps.js"
import { contactWriteCommands } from "./admin-contacts-command.js"
import { contactAnswer, lines, pageOf } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { hideNever } from "./lacks.js"
import { CONTACTS_QUERY, notesAllowed } from "./people-queries.js"
import { privatePeopleCommands } from "./private-people-command.js"
import { syncsFirst } from "./search-sync-options.js"

const CONTACT_ACTIVITY_QUERY = defineQuery({
  entity: "contact_activity",
  backend: "native",
  fields: [
    termField("scope", "enum", "scope:work", { values: SCOPES }),
    nativeField({
      name: "at",
      type: "time",
      operators: ["term", "phrase", "range"],
      example: "at:[2026-10-01 TO 2026-10-31]",
    }),
  ],
})

/** People this account has a one-to-one chat with, as the people service counts them. */
const collect = (value: string, previous: string[] = []) => [...previous, value]

export const contactsCommand = (messenger: Messenger): Command => {
  const contacts = new Command("contacts").description("people this account has a one-to-one chat with")

  contacts.addCommand(
    withQuery(
      annotate(
        withPaging(
          annotate(new Command("list"), { effects: REMOTE_READ })
            .summary("people you have a one-to-one chat with")
            .description(
              "people you have a one-to-one chat with; name: matches the name, your local alias or the @username, " +
                "notes: your private notes about them",
            ),
        ).option("--order <recent|name>", "newest conversation first, or alphabetical", "recent"),
        { output: { entity: "contact" } },
      ),
      CONTACTS_QUERY,
    ).action(async function (this: Command, words: string[]) {
      const { order } = this.opts<{ order: string }>()
      if (order !== "recent" && order !== "name") {
        throw new CliError("validation_error", `--order is recent or name, not "${order}"`)
      }
      const terms = nativeTerms(listQuery(typedQuery(words), CONTACTS_QUERY, "contacts list"), "contacts list")
      const name = terms.get("name")
      const notes = terms.get("notes")
      const context = messengerContext(this, messenger)
      notesAllowed(context.settings.permissions, notes)
      const { found, account } = await context.withServices(async (services) => ({
        found: await services.people.list({
          order,
          ...(name ? { name } : {}),
          ...(notes ? { notes } : {}),
          ...window(context.settings),
        }),
        account: await services.chats.account(),
      }))
      renderAnswer(
        this,
        context,
        listOf("contacts list", {
          items: found.items.map((one) => contactAnswer(account, one)),
          ...pageOf(context.settings, found),
          args: { order, ...(words.length > 0 ? { query: words.join(" ") } : {}) },
        }),
        lines(({ id, name, username, last_messaged_at }) =>
          [id, name ?? "", username ? `@${username}` : "", last_messaged_at ?? ""].join("  "),
        ),
      )
    }),
  )

  contacts.addCommand(
    annotate(
      annotate(new Command("show"), { effects: REMOTE_READ })
        .description("one person and the chats you share with them")
        .argument("<person>", "their id, @username, or part of their name")
        .option("--with-notes", "include your private notes, subject to contacts.notes.list permission"),
      { output: { entity: "contact" } },
    ).action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      const { withNotes } = this.opts<{ withNotes?: boolean }>()
      if (withNotes && levelFor(context.settings.permissions, "contacts.notes.list").level === "deny")
        throw new CliError("permission_error", "profile denies contacts.notes.list")
      const { card, account } = await context.withServices(async (services) => ({
        card: await services.people.show(person, { notes: withNotes }),
        account: await services.chats.account(),
      }))
      renderAnswer(this, context, itemOf(contactAnswer(account, card)))
    }),
  )

  annotate(contacts.command("info"), { effects: REMOTE_READ, output: { entity: "contact_profile" } })
    .summary("a person's profile from the messenger")
    .description(
      "everything the messenger says about one person — handles, flags, last seen, when they registered — and " +
        "how many of their messages the store holds in each chat you share, the first and the last, and the " +
        "earlier names and usernames the store saw them with",
    )
    .argument("<person>", "their id, @username, or part of their name")
    .option("--show-phone", "print the whole phone number")
    .action(async function (this: Command, person: string) {
      const whole = this.opts<{ showPhone?: boolean }>().showPhone === true
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.people.profile(person))
      const partial = found.chats.filter(({ complete }) => !complete)
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(whole ? found : maskedAccount(found)), {
          next: syncsFirst(messenger)
            ? partial.map((one) => nextStep("messages.sync", { args: { chat: one.id } }))
            : [],
        }),
      )
    })

  const contextCommand = annotate(contacts.command("context"), {
    effects: REMOTE_READ,
    output: { entity: "contact_context" },
  })
    .summary("what the local archive knows about a person")
    .description(
      "what the store holds about one person, in every messenger linked to them: shared chats, the last " +
        "messages each way, their recent messages, where others mentioned them — never connects",
    )
    .argument("<person>", "their id, @username, or part of their name")
    .option(
      "--limit <n>",
      `at most this many messages in each list; ${CONTEXT_MESSAGES} if not given`,
      positiveCount("--limit"),
    )
    .option("--since-time <time>", "nothing older than this ISO 8601 time, or 2h / 1d ago")
    .option(
      "--chat <chat>",
      `a chat, by id or name; repeat it for more — then their newest messages in each, ${CHAT_MESSAGES} unless --limit, short unless -v`,
      collect,
    )
  if (syncsFirst(messenger))
    contextCommand.option("--sync-first", "with --chat, read their newest messages in each from the messenger first")
  contextCommand.action(async function (this: Command, person: string) {
    const { limit, sinceTime, chat, syncFirst } = this.opts<{
      limit?: number
      sinceTime?: string
      chat?: string[]
      syncFirst?: boolean
    }>()
    const context = messengerContext(this, messenger)
    if (chat === undefined) {
      if (syncFirst) throw new CliError("validation_error", "--sync-first reads the chats named with --chat")
    } else {
      if (sinceTime !== undefined) throw new CliError("validation_error", "--since-time is not used with --chat")
      const found = await context.withServices((services) =>
        services.people.messagesIn(person, {
          chats: chat,
          ...(limit === undefined ? {} : { limit }),
          detail: context.settings.detail,
          fetch: syncFirst === true,
        }),
      )
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(found), {
          next: syncsFirst(messenger)
            ? found.chats
                .filter((one) => !one.complete)
                .map((one) => nextStep("messages.sync", { args: { chat: one.chat.id } }))
            : [],
        }),
      )
      return
    }
    const window = dateWindow(sinceTime === undefined ? {} : { sinceTime })
    const found = await context.withServices((services) =>
      services.people.context(person, {
        messages: limit ?? CONTEXT_MESSAGES,
        bytes: CONTEXT_BYTES,
        ...(window.since === undefined ? {} : { since: window.since }),
      }),
    )
    const { hasMore, ...rest } = found
    renderAnswer(
      this,
      context,
      itemOf(snakeKeys(rest), {
        next: syncsFirst(messenger)
          ? found.notRead
              .filter((chat) => chat.provider === messenger.provider)
              .map((chat) => nextStep("messages.sync", { args: { chat: chat.chatId } }))
          : [],
        meta: { ...window.meta, ...(hasMore ? { truncated: true } : {}) },
      }),
    )
    if (hasMore) context.renderer.note("cut at --limit; a larger one shows more")
  })

  annotate(contacts.command("prepare"), {
    effects: REMOTE_READ,
    output: { entity: "contact_preparation" },
    examples: [`${messenger.app.command} contacts prepare Ana`],
  })
    .summary("what to know before you talk to someone, each item with its reference")
    .description(
      "before you talk to someone: what contacts context gives, plus the one-to-one chats where they wrote last, " +
        "open tasks, accepted facts, your notes and their recent meetings, each with its reference; never connects",
    )
    .argument("<person>", "their id, @username, or part of their name")
    .option(
      "--limit <n>",
      `at most this many messages, and items in each section; ${CONTEXT_MESSAGES} if not given`,
      positiveCount("--limit"),
    )
    .option("--since-time <time>", "no message or meeting older than this ISO 8601 time, or 2h / 1d ago")
    .action(async function (this: Command, person: string) {
      const { limit, sinceTime } = this.opts<{ limit?: number; sinceTime?: string }>()
      const context = messengerContext(this, messenger)
      const window = dateWindow(sinceTime === undefined ? {} : { sinceTime })
      const found = await context.withServices((services) =>
        services.people.prepare(person, {
          messages: limit ?? CONTEXT_MESSAGES,
          notes: levelFor(context.settings.permissions, "contacts.notes.list").level !== "deny",
          ...(window.since === undefined ? {} : { since: window.since }),
        }),
      )
      const { hasMore, ...rest } = found
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(rest), {
          next: syncsFirst(messenger)
            ? found.notRead
                .filter((chat) => chat.provider === messenger.provider)
                .map((chat) => nextStep("messages.sync", { args: { chat: chat.chatId } }))
            : [],
          meta: { ...window.meta, ...(hasMore ? { truncated: true } : {}) },
        }),
      )
    })

  withQuery(
    annotate(contacts.command("events"), {
      effects: REMOTE_READ,
      output: { entity: "contact_activity" },
    })

      .summary("one person's activity across their linked identities")
      .description(
        "everything one person took part in, in every messenger linked to them — messages they wrote or were " +
          "mentioned in, chats, mail, meetings, tasks — newest first, from the store; never connects",
      )
      .argument("<person>", "their id, @username, or part of their name"),
    CONTACT_ACTIVITY_QUERY,
  )
    .option("--limit <n>", `at most this many; ${TIMELINE_ITEMS} if not given`, positiveCount("--limit"))
    .option("--cursor <cursor>", "go on from where the last page stopped; page.next gives it, with the same filters")
    .action(async function (this: Command, person: string, words: string[]) {
      const terms = nativeTerms(
        listQuery(typedQuery(words), CONTACT_ACTIVITY_QUERY, "contacts events"),
        "contacts events",
      )
      const scope = terms.get("scope")?.value.toLowerCase()
      const { limit, cursor } = this.opts<{
        scope?: string
        sinceTime?: string
        untilTime?: string
        limit?: number
        cursor?: string
      }>()
      if (scope !== undefined && !(SCOPES as readonly string[]).includes(scope))
        throw new CliError("validation_error", `--scope is personal or work, not "${scope}"`)
      const context = messengerContext(this, messenger)
      const window = timeBounds(terms.get("at"))
      const found = await context.withServices((services) =>
        services.people.timeline(person, {
          ...(scope === undefined ? {} : { scope: scope as Scope }),
          ...(window.since === undefined ? {} : { since: window.since }),
          ...(window.until === undefined ? {} : { until: window.until }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      )
      const { items, hasMore, limits, pending } = found
      renderAnswer(
        this,
        context,
        listOf("contacts events", {
          items: items.map(snakeKeys),
          limit: limits.items,
          has_more: hasMore,
          paging: "cursor",
          ...(found.cursor === undefined ? {} : { cursor: found.cursor }),
          args: {
            person,
            ...(words.length ? { query: typedQuery(words) } : {}),
          },
          meta: { ...window.meta, ...(pending > 0 ? { truncated: true } : {}) },
        }),
      )
    })

  annotate(contacts.command("check"), { effects: REMOTE_READ, output: { entity: "contact_check" } })
    .summary("check a person's profile and messages for signs of abuse")
    .description(
      registriesCover(messenger.provider)
        ? "whether one person looks like a bot, a fake or a spammer: their profile, what they wrote in the store, " +
            `and the public ban lists (${Object.values(REGISTRIES)
              .map(({ title }) => title)
              .join(", ")}), which are sent their id — a hint, never a verdict`
        : "whether one person looks like a bot, a fake or a spammer: their profile and what they wrote in the " +
            "store — a hint, never a verdict; the public ban lists cover Telegram only, so nothing is sent",
    )
    .argument("<person>", "their id, @username, or part of their name")
    .option("--no-registries", "do not ask the public ban lists; nothing about them leaves this machine")
    .action(async function (this: Command, person: string) {
      const { registries } = this.opts<{ registries: boolean }>()
      const context = messengerContext(this, messenger)
      const asks = registries && !context.settings.offline && registriesCover(messenger.provider)
      const key = asks ? casKey(messenger.app, context.env, context.keyring) : undefined
      const checked = await context.withServices((services) =>
        services.botcheck.person(person, { registries, ...(key ? { registry: { casKey: key } } : {}) }),
      )
      for (const note of checked.notes) context.renderer.note(note)
      for (const { name, answer, detail } of checked.registries) {
        if (answer === "unknown") context.renderer.note(`${name}: not known — ${detail ?? "no answer"}`)
      }
      if (checked.unknown.length > 0)
        context.renderer.note(`not judged, nothing to judge by: ${checked.unknown.join(", ")}`)
      const { notes: _, ...answer } = checked
      renderAnswer(this, context, itemOf(snakeKeys(answer)))
    })

  annotate(contacts.command("link"), { effects: LOCAL_WRITE, output: { entity: "linked_person" } })
    .summary("link identities that belong to one person")
    .description("record that two people in the store are one person — the same name is never enough")
    .argument("<person>", "their id, @username, or part of their name")
    .argument(
      "<other>",
      "the same in another messenger of the store, as <messenger>:<person> — max:Ana; me: it is you, as zoom:<id> me",
    )
    .action(async function (this: Command, person: string, other: string) {
      const context = messengerContext(this, messenger)
      const linked = await context.withServices((services) => services.people.link(person, other))
      renderAnswer(this, context, itemOf(snakeKeys(linked)))
      context.renderer.success(`${linked.identities.length} identities are now one person`)
    })

  annotate(contacts.command("unlink"), { effects: LOCAL_WRITE, output: { entity: "linked_person" } })
    .description("undo contacts link for one identity: it is a person of its own again")
    .argument("<person>", "their id, @username, or part of their name; <messenger>:<person> for another messenger")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.people.unlink(person)))),
      )
    })

  /**
   * ⚠ **The number is asked for or piped, never an argument**: argv is read by `ps` and kept by shell
   * history, and a phone number is personal data.
   */
  annotate(contacts.command("lookup"), { effects: REMOTE_READ, output: { entity: "contact_lookup" } })
    .summary("find an account by a phone number")
    .description("who has this phone number — asks for it, or reads it from stdin; never an argument")
    // Declared only so a number typed here anyway, every word of it, stays out of the run record.
    .addArgument(secretInput(new Argument("[phone]", "refused: the number is asked for, never typed here")))
    // Commander's own refusal would repeat the number on stderr.
    .allowExcessArguments()
    .action(async function (this: Command) {
      if (this.args.length > 0) {
        throw new CliError(
          "validation_error",
          "the phone number is never an argument — pipe it in, or type it when asked",
        )
      }
      const context = messengerContext(this, messenger)
      const phone = phoneOf(await readSecret("phone number: ", { ...secretInputOf(this), echo: true }))
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.people.lookup(phone)))),
      )
    })

  annotate(contacts.command("sync"), { effects: FETCH, output: { entity: "contact_sync" } })
    .description("take the whole contact list from the messenger into the local store")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const summary = await context.withServices((services) => services.people.sync())
      renderAnswer(this, context, itemOf(summary))
      context.renderer.success(`${summary.added} new, ${summary.changed} changed, ${summary.known} people known`)
    })

  for (const command of privatePeopleCommands(messenger)) contacts.addCommand(command)
  for (const command of contactWriteCommands(messenger)) contacts.addCommand(command)
  const examples: Record<string, string> = {
    add: '"Alex Example"',
    "aliases remove": '"Alex Example"',
    "aliases set": '"Alex Example" "Reading partner"',
    block: '"Alex Example"',
    check: '"Alex Example"',
    context: '"Alex Example" --limit 10',
    import: "./contacts.csv",
    link: '"Alex Example" zoom:101',
    list: "--limit 10",
    lookup: "",
    "notes add": '"Alex Example" --text-file ./note.txt',
    "notes edit": '"Alex Example" 1 --revision 1 --text-file ./note.txt',
    "notes list": '"Alex Example"',
    "notes remove": '"Alex Example" 1',
    "notes show": '"Alex Example" 1',
    info: '"Alex Example"',
    remove: '"Alex Example"',
    rename: '"Alex Example" Alex Example',
    show: '"Alex Example"',
    sync: "",
    events: '"Alex Example" --limit 10',
    unblock: '"Alex Example"',
    unlink: '"Alex Example"',
  }
  for (const [path, args] of Object.entries(examples)) {
    const command = commandAt(contacts, path)
    if (command)
      annotate(command, { examples: [`${messenger.app.command} personal contacts ${path} ${args}`.trimEnd()] })
  }
  return hideNever(messenger, contacts)
}
