import { CliError, isCliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { defineQuery, type Predicate, type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { isoTime } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { REMOTE_READ, REMOTE_WRITE } from "../../cli/effects.js"
import { type Body, itemOf, listOf } from "../../cli/envelope.js"
import {
  commandPath,
  listQuery,
  nativeTerms,
  searchText,
  typedQuery,
  withQuery,
  withWords,
} from "../../cli/list-query.js"
import { terminalAsker } from "../../cli/messenger/ask.js"
import type { CrmField, CrmOrganization, CrmPerson, CrmUser } from "../../domain/crm.js"
import type { AppIdentity } from "../../ports/app.js"
import { foldName } from "../../resolve.js"
import { foreignContacts, foreignContactsPathFor } from "../foreign-contacts.js"
import {
  type CrmQueryField,
  conditionsOf,
  customConditions,
  customNames,
  filterableFields,
  selectedCodes,
  wantedCodes,
  withCustomFields,
} from "../query.js"
import type { CrmLiveKind, CrmSource } from "../source.js"
import type { CrmWriteCapabilities } from "../writer.js"
import {
  type CrmRecordInput,
  type CrmRecordWritten,
  type CrmWriteContext,
  createCrmRecord,
  fieldPairsOf,
  RECORD_ID,
  updateCrmRecord,
} from "../writes.js"
import { csvFormatOption, renderCsv } from "./csv.js"
import type { CrmRun, CrmWithin } from "./index.js"

/** The kinds a CRM CLI reads live: its contacts and companies by `list`/`get`, its users by `users()`. */
export type CrmLiveRecord = CrmLiveKind | "user"

const time = v.nullable(isoTime)
const metadata = v.optional(
  v.record(
    v.string(),
    v.strictObject({
      label: v.nullable(v.string()),
      value: v.unknown(),
      option_id: v.optional(v.union([v.string(), v.array(v.string())])),
    }),
  ),
)
const untrusted = v.array(v.string())
/** A phone or an address and its kind as the CRM names it (`WORK`, `MOB`), null when it names none. */
const contacts = v.optional(v.array(v.strictObject({ value: v.string(), type: v.nullable(v.string()) })))

/** A CRM contact as the CRM holds it now. `emails` and `phones` are left out where the sign-in may not see them. */
export const crmPersonSchema = v.strictObject({
  id: v.string(),
  name: v.nullable(v.string()),
  first_name: v.nullable(v.string()),
  last_name: v.nullable(v.string()),
  position: v.nullable(v.string()),
  organization_ids: v.array(v.string()),
  emails: contacts,
  phones: contacts,
  assigned_to: v.nullable(v.string()),
  created_at: time,
  updated_at: time,
  url: v.nullable(v.string()),
  provider_metadata: metadata,
  untrusted,
})

/** A CRM company as the CRM holds it now. */
export const crmOrganizationSchema = v.strictObject({
  id: v.string(),
  name: v.nullable(v.string()),
  type: v.nullable(v.string()),
  own: v.boolean(),
  person_ids: v.array(v.string()),
  emails: contacts,
  phones: contacts,
  assigned_to: v.nullable(v.string()),
  created_at: time,
  updated_at: time,
  url: v.nullable(v.string()),
  provider_metadata: metadata,
  untrusted,
})

/** A user of the CRM account: someone of the owner's own company. */
export const crmUserSchema = v.strictObject({
  id: v.string(),
  name: v.nullable(v.string()),
  email: v.nullable(v.string()),
  position: v.nullable(v.string()),
  active: v.boolean(),
  department_ids: v.array(v.string()),
  untrusted,
})

const PERSON_UNTRUSTED = ["name", "first_name", "last_name", "position", "emails", "phones", "provider_metadata"]
const ORGANIZATION_UNTRUSTED = ["name", "type", "emails", "phones", "provider_metadata"]
const USER_UNTRUSTED = ["name", "email", "position"]

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString())

/** The primary value first, each once; absent when the CRM said neither. */
const both = (first: string | null | undefined, all: string[] | undefined) =>
  first == null && all === undefined ? undefined : [...new Set([...(first ? [first] : []), ...(all ?? [])])]

const shared = (record: CrmPerson | CrmOrganization) => {
  const typed = (values: string[] | undefined) =>
    values?.map((value) => ({ value, type: record.contactTypes?.[value] ?? null }))
  const emails = typed(both((record as CrmPerson).email, record.emails))
  const phones = typed(both((record as CrmPerson).phone, record.phones))
  return {
    ...(emails ? { emails } : {}),
    ...(phones ? { phones } : {}),
    assigned_to: record.assignee ?? null,
    created_at: iso(record.createdAt),
    updated_at: iso(record.updatedAt),
    url: record.url ?? null,
    ...(record.metadata ? { provider_metadata: record.metadata as v.InferOutput<typeof metadata> } : {}),
  }
}

export const crmPersonOf = (person: CrmPerson): v.InferOutput<typeof crmPersonSchema> => ({
  id: person.externalId,
  name: person.name,
  first_name: person.firstName ?? null,
  last_name: person.lastName ?? null,
  position: person.position ?? null,
  organization_ids: (person.organizations ?? []).map(({ externalId }) => externalId),
  ...shared(person),
  untrusted: PERSON_UNTRUSTED,
})

export const crmOrganizationOf = (organization: CrmOrganization): v.InferOutput<typeof crmOrganizationSchema> => ({
  id: organization.externalId,
  name: organization.name,
  type: organization.type ?? null,
  own: organization.own === true,
  person_ids: organization.people ?? [],
  ...shared(organization),
  untrusted: ORGANIZATION_UNTRUSTED,
})

export const crmUserOf = (user: CrmUser): v.InferOutput<typeof crmUserSchema> => ({
  id: user.externalId,
  name: user.name,
  email: user.email ?? null,
  position: user.position ?? null,
  active: user.active !== false,
  department_ids: user.departments ?? [],
  untrusted: USER_UNTRUSTED,
})

const RECORD_FIELDS: Record<CrmLiveKind, Record<string, CrmQueryField>> = {
  person: {
    assigned_to: { field: "assigned_to", kind: "id" },
    created_at: { field: "created_at", kind: "time" },
    updated_at: { field: "updated_at", kind: "time" },
  },
  organization: {
    type: { field: "type", kind: "text" },
    assigned_to: { field: "assigned_to", kind: "id" },
    created_at: { field: "created_at", kind: "time" },
    updated_at: { field: "updated_at", kind: "time" },
  },
}

const nativeQuery = (entity: string, schema: v.GenericSchema, native: string[]): QueryRegistry =>
  defineQuery({
    entity,
    backend: "native",
    fields: queryFieldsOf(schema, {
      exclude: ["provider_metadata", "url", "untrusted"],
      native,
      text: ["name"],
      examples: { name: "name:anna*" },
    }),
  })

export const CRM_PEOPLE_QUERY = nativeQuery("crm_person", crmPersonSchema, [
  "name",
  ...Object.keys(RECORD_FIELDS.person),
])
export const CRM_ORGANIZATIONS_QUERY = nativeQuery("crm_organization", crmOrganizationSchema, [
  "name",
  ...Object.keys(RECORD_FIELDS.organization),
])
export const CRM_USERS_QUERY = nativeQuery("crm_user", crmUserSchema, ["name", "active"])

const CUSTOM_HELP = `
The CRM's own fields, as \`fields list\` prints them:
  <code or label>:<value>    a field the CRM can filter by; a list field takes its option's label or id.
                             A label with spaces: lead_source:web, or Lead\\ source:web
  --json=id,name,provider_metadata.<code>   keeps that field of each item; provider_metadata keeps them all`

interface Noun {
  kind: CrmLiveKind
  noun: string
  entity: string
  schema: v.GenericSchema
  query: QueryRegistry
  what: string
  of: (record: CrmPerson | CrmOrganization) => Record<string, unknown>
}

const NOUNS: Record<CrmLiveKind, Noun> = {
  person: {
    kind: "person",
    noun: "people",
    entity: "crm_person",
    schema: crmPersonSchema,
    query: CRM_PEOPLE_QUERY,
    what: "contacts",
    of: (record) => crmPersonOf(record as CrmPerson),
  },
  organization: {
    kind: "organization",
    noun: "organizations",
    entity: "crm_organization",
    schema: crmOrganizationSchema,
    query: CRM_ORGANIZATIONS_QUERY,
    what: "companies",
    of: (record) => crmOrganizationOf(record as CrmOrganization),
  },
}

/** The most rows a live page asks for: amoCRM's own largest page. */
const MOST = 250
/** A whole number from 1 to `most`, as `--limit` and `--page` take it. */
export const integer = (most: number) => (value: string) => {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > most) throw new InvalidArgumentError(`expected 1 to ${most}`)
  return Number(value)
}

const sourceWith = <M extends "list" | "get" | "users">(run: CrmRun, method: M, what: string) => {
  const source = run.source()
  if (!source[method]) throw new CliError("configuration_error", `this CRM does not read its ${what} live`)
  return source as CrmSource & Required<Pick<CrmSource, M>>
}

export interface CrmRecordCommandOptions {
  within: CrmWithin
  example: (command: Command, ...lines: string[]) => Command
  open: (command: Command, access: { readOnly: boolean }) => Promise<CrmRun>
  app: AppIdentity
  live: readonly CrmLiveRecord[]
  /** `words`: the live lists are the service's own search (a source from a manifest), which takes no field terms. */
  liveQuery?: "fields" | "words"
  writes?: CrmWriteCapabilities
  now: () => number
}

/** `people`, `organizations` and `users`: read live from the CRM, so `--offline` is refused. */
export const addCrmRecordCommands = (program: Command, options: CrmRecordCommandOptions): void => {
  const { within, example } = options
  const quotaOf = (run: CrmRun) =>
    foreignContacts(
      run.source(),
      async () => {
        const self = run.source().self
        return foreignContactsPathFor(options.app, run.account, run.env, self ? String(await self()) : undefined)
      },
      { now: options.now },
    )
  // The definitions a sync stored, which a list reads without a request; read live only before the first sync.
  const liveFields = async (run: CrmRun, kind: CrmLiveKind): Promise<CrmField[]> => {
    const stored = await run.store.crm.fields(run.account, kind)
    return stored.length ? stored : ((await run.source().fields?.(kind)) ?? [])
  }

  const words = options.liveQuery === "words"
  const records = (noun: Noun) => {
    const group = annotate(program.command(noun.noun), { effects: REMOTE_READ }).description(
      `the CRM's ${noun.what}, read live: the copy holds only your own`,
    )
    const query = words
      ? { ...noun.query, fields: noun.query.fields.filter(({ name }) => name === "name") }
      : noun.query
    const list = answerEntity(
      annotate(group.command("list"), { effects: REMOTE_READ, offline: false }),
      noun.entity,
      noun.schema,
    )
    example(
      (words
        ? withWords(list, query, `words the CRM's own search looks for in ${noun.what}`)
        : withQuery(list, query).addHelpText("after", CUSTOM_HELP)
      )
        .description(`${noun.what} in the CRM, newest first; another client is found here, never in the copy`)
        .option("--limit <n>", `${noun.what} per page, 1–${MOST}`, integer(MOST), 50)
        .option("--page <n>", "which page, starting at 1", integer(1_000_000), 1)
        .addOption(csvFormatOption()),
      `${noun.noun} list`,
      words ? `${noun.noun} list anna --json` : `${noun.noun} list name:anna* --json`,
      `${noun.noun} list --format csv > ${noun.noun}.csv`,
    ).action(async (words: string[], opts: { limit: number; page: number; format?: "csv" }, command: Command) => {
      const csv = opts.format === "csv"
      const path = commandPath(command)
      const text = typedQuery(words)
      const names = customNames(text, query, path, "name")
      const columns = command.optsWithGlobals<{ fields?: string }>().fields
      const wanted = csv && columns === undefined ? "all" : wantedCodes(columns)
      const read = async (run: CrmRun) => {
        const source = sourceWith(run, "list", noun.what)
        const fields = names.length || wanted !== undefined || csv ? await liveFields(run, noun.kind) : []
        const chosen = filterableFields(fields, names)
        selectedCodes(fields, wanted)
        const terms = nativeTerms(
          listQuery(text, withCustomFields(query, chosen), path, { defaultField: "name" }),
          path,
        )
        const custom = customConditions(terms, chosen)
        const name = searchText(terms.get("name"))
        terms.delete("name")
        const page = await source.list(noun.kind, {
          conditions: [...conditionsOf(terms, RECORD_FIELDS[noun.kind]), ...custom],
          ...(name ? { text: name } : {}),
          limit: opts.limit,
          page: opts.page,
        })
        const shown = await quotaOf(run).strip(noun.kind, page.items as (CrmPerson | CrmOrganization)[])
        return { items: shown.map(noun.of), fields, hasMore: page.hasMore }
      }
      if (csv)
        return renderCsv(command, options.open, async (run) => ({ ...(await read(run)), page: opts.page }), [
          ...Object.keys((noun.schema as v.ObjectSchema<v.ObjectEntries, undefined>).entries).filter(
            (key) => key !== "provider_metadata" && key !== "untrusted",
          ),
          "provider_metadata",
        ])
      await within(command, async (run) => {
        const found = await read(run)
        return listOf(path, {
          items: found.items,
          limit: opts.limit,
          page: opts.page,
          has_more: found.hasMore,
          ...(words.length ? { args: { query: words } } : {}),
        })
      })
    })
    example(
      answerEntity(annotate(group.command("show"), { effects: REMOTE_READ, offline: false }), noun.entity, noun.schema)
        .description(
          `one of the CRM's ${noun.what}, read live, with its phones and e-mails; one that is not your client ` +
            "counts toward the day's limit when the CRM sets one",
        )
        .argument(
          `<${noun.kind}>`,
          `the CRM's id of the ${noun.kind}, as list prints it, the ${noun.kind}:<id> a deal gives, or its exact name`,
        ),
      `${noun.noun} show 42`,
      `${noun.noun} show "Anna Example" --json`,
    ).action(async (given: string, _opts: unknown, command: Command) => {
      await within(command, async (run) => {
        const found = await recordNamed(run, noun, given)
        await quotaOf(run).spend(noun.kind, found)
        return itemOf(noun.of(found))
      })
    })
    addRecordWrites(group, noun, options)
  }

  for (const kind of ["person", "organization"] as const) if (options.live.includes(kind)) records(NOUNS[kind])
  if (options.live.includes("user")) users(program, options)
}

/** By the CRM's id first; else the one record whose whole name is the given one, folded. */
/** A service whose ids have a fixed shape refuses a word as one (Attio answers 400): the word is then a name. */
const byIdOrNone = async (run: CrmRun, noun: Noun, id: string) => {
  try {
    return await sourceWith(run, "get", noun.what).get(noun.kind, id)
  } catch (error) {
    if (isCliError(error) && error.code === "validation_error") return null
    throw error
  }
}

/** The copy's `person:<id>` or `organization:<id>`, which a deal gives, is the CRM record it was stored from. */
const storedRecord = async (run: CrmRun, noun: Noun, ref: string): Promise<CrmPerson | CrmOrganization> => {
  const ids = await run.store.crm.externalIdsOf(run.account, ref)
  if (ids.length > 1)
    throw new CliError("validation_error", `${ref} is ${ids.length} records of the CRM; name one by its id`, {
      reason: "crm.record-ambiguous",
      candidates: ids.map((id) => ({ id })),
    })
  const found = ids[0] ? await sourceWith(run, "get", noun.what).get(noun.kind, ids[0]) : null
  if (!found)
    throw new CliError("not_found", `the copy holds no CRM ${noun.kind} as ${ref}, or this sign-in cannot see it`)
  return found as CrmPerson | CrmOrganization
}

const recordNamed = async (run: CrmRun, noun: Noun, given: string): Promise<CrmPerson | CrmOrganization> => {
  const id = given.trim()
  if (id.startsWith(`${noun.kind}:`) && /^\w+:\d+$/.test(id)) return storedRecord(run, noun, id)
  const byId = RECORD_ID.test(id) ? await byIdOrNone(run, noun, id) : null
  if (byId) return byId as CrmPerson | CrmOrganization
  const want = foldName(id)
  const page = await sourceWith(run, "list", noun.what).list(noun.kind, { conditions: [], text: id, limit: MOST })
  const named = (page.items as (CrmPerson | CrmOrganization)[]).filter((one) => foldName(one.name ?? "") === want)
  const [only] = named
  if (named.length > 1)
    throw new CliError("validation_error", `${named.length} ${noun.what} are named ${id}; name one by its id`, {
      reason: "crm.record-ambiguous",
      candidates: named.map((one) => ({ id: one.externalId, name: one.name })),
    })
  if (!only) throw new CliError("not_found", `the CRM has no ${noun.kind} ${id}, or this sign-in cannot see it`)
  return only
}

const matches = (user: CrmUser, terms: Map<string, Predicate>) => {
  const name = terms.get("name")
  if (name) {
    const want = foldName(searchText(name) ?? "")
    if (!foldName(user.name ?? "").includes(want)) return false
  }
  const active = terms.get("active")
  return !active || String(user.active !== false) === active.value.toLowerCase()
}

const runUsers = new WeakMap<CrmRun, Promise<CrmUser[]>>()
/** The CRM's users, read once a run. */
const usersOf = (run: CrmRun): Promise<CrmUser[]> => {
  let found = runUsers.get(run)
  if (!found) {
    found = sourceWith(run, "users", "users").users()
    runUsers.set(run, found)
  }
  return found
}

const users = (program: Command, { within, example }: CrmRecordCommandOptions) => {
  const group = annotate(program.command("users"), { effects: REMOTE_READ }).description(
    "the CRM account's users: the people of your own company who own deals",
  )
  example(
    withQuery(
      answerEntity(
        annotate(group.command("list"), { effects: REMOTE_READ, offline: false }),
        "crm_user",
        crmUserSchema,
      ),
      CRM_USERS_QUERY,
    )
      .description("the CRM's users, read live, in the CRM's order")
      .option("--limit <n>", `users per page, 1–${MOST}`, integer(MOST), 50)
      .option("--page <n>", "which page, starting at 1", integer(1_000_000), 1),
    "users list",
    "users list active:true --json",
  ).action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
    const path = commandPath(command)
    const terms = nativeTerms(listQuery(typedQuery(words), CRM_USERS_QUERY, path, { defaultField: "name" }), path)
    await within(command, async (run) => {
      const all = (await usersOf(run)).filter((user) => matches(user, terms))
      const offset = (opts.page - 1) * opts.limit
      return listOf(path, {
        items: all.slice(offset, offset + opts.limit).map(crmUserOf),
        limit: opts.limit,
        page: opts.page,
        has_more: all.length > offset + opts.limit,
        ...(words.length ? { args: { query: words } } : {}),
      })
    })
  })
  example(
    answerEntity(annotate(group.command("show"), { effects: REMOTE_READ, offline: false }), "crm_user", crmUserSchema)
      .description("one of the CRM's users, read live")
      .argument("<user>", "the CRM's id of the user, as list prints it"),
    "users show 7",
  ).action(async (id: string, _opts: unknown, command: Command) => {
    if (!RECORD_ID.test(id))
      throw new CliError("validation_error", "name the user by the CRM's id, as users list prints it", {
        reason: "ref.malformed",
      })
    await within(command, async (run) => {
      const found = (await usersOf(run)).find((user) => user.externalId === id)
      if (!found) throw new CliError("not_found", `the CRM has no user ${id}`)
      return itemOf(crmUserOf(found))
    })
  })
}

const crmRecordWrite = v.strictObject({
  operation_id: v.string(),
  stored: v.boolean(),
  removed: v.optional(v.boolean()),
  person: v.optional(crmPersonSchema),
  organization: v.optional(crmOrganizationSchema),
  untrusted,
})

/** `create` and `update` of contacts and companies, through the same guarded path as `deals create`. */
const addRecordWrites = (group: Command, noun: Noun, { within, example, writes }: CrmRecordCommandOptions) => {
  if (!writes?.kinds.includes(noun.kind)) return
  const person = noun.kind === "person"
  const written = writes.fields?.[noun.kind]
  const takes = (field: string) => !written || written.includes(field)
  const fields = (command: Command) => {
    command.option("--name <name>", person ? "the whole name" : "the company's name")
    if (person) {
      command
        .option("--first-name <name>", "the first name; empty clears it")
        .option("--last-name <name>", "the last name; empty clears it")
      if (takes("position")) command.option("--position <title>", "the job title; empty clears it")
    }
    const repeated = (value: string, previous: string[] = []) => [...previous, value]
    if (takes("emails"))
      command.option(
        "--email <address>",
        "an e-mail address to give it; repeat it for more; replaces its list, and an empty one clears it",
        repeated,
      )
    if (takes("phones"))
      command.option(
        "--phone <phone>",
        "a phone number to give it, in international form starting with +; repeat it for more; replaces its list, " +
          "and an empty one clears it",
        repeated,
      )
    if (takes("owner"))
      command.option(
        "--owner <user>",
        "the CRM user it is assigned to; anyone but the sign-in's own user checks crm.assign-others",
      )
    if (takes("custom"))
      command.option(
        "--field <key=value>",
        "one of the CRM's own fields, by its code or label as `fields list` prints them, and its value; a list " +
          "field takes its option's label or id; repeat it for more fields, or for each value of a multiple field; " +
          "an empty value clears it",
        (value: string, previous: string[] = []) => {
          if (value.indexOf("=") < 1) throw new CliError("validation_error", "--field takes <key>=<value>")
          return [...previous, value]
        },
        [] as string[],
      )
    if (writes.idempotent)
      command.option(
        "--operation-id <id>",
        "the operation_id a write that ended in outcome_unknown named: the CRM answers the repeat from its record",
      )
    return command
  }
  type Typed = Omit<CrmRecordInput, "custom" | "emails" | "phones"> & {
    field?: string[]
    email?: string[]
    phone?: string[]
    operationId?: string
  }
  const inputOf = ({ field, email, phone, operationId: _id, ...rest }: Typed): CrmRecordInput => ({
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    ...(email ? { emails: email } : {}),
    ...(phone ? { phones: phone } : {}),
    ...(field?.length ? { custom: fieldPairsOf(field) } : {}),
  })
  const contextOf = (run: CrmRun, command: Command): CrmWriteContext => {
    if (!run.writes) throw new CliError("configuration_error", "this profile cannot write to its CRM")
    return {
      store: run.store,
      account: run.account,
      writes: run.writes(),
      ask: terminalAsker(command),
      source: run.source,
      names: { id: "--operation-id" },
    }
  }
  const answered = ({ operationId, record, stored, removed }: CrmRecordWritten<CrmLiveKind>): Body =>
    itemOf({
      operation_id: operationId,
      stored,
      ...(removed === undefined ? {} : { removed }),
      [noun.kind]: noun.of(record),
      untrusted: (person ? PERSON_UNTRUSTED : ORGANIZATION_UNTRUSTED).map((one) => `${noun.kind}.${one}`),
    })
  const command = (name: "create" | "update", description: string) =>
    answerEntity(
      annotate(group.command(name), { effects: REMOTE_WRITE, offline: false }),
      "crm_record_write",
      crmRecordWrite,
    ).description(description)
  if (writes.verbs.includes("create"))
    example(
      fields(
        command(
          "create",
          `make ${noun.kind === "organization" ? "an" : "a"} ${noun.kind} in the CRM, then store the CRM's copy of it`,
        ),
      ),
      person
        ? `${noun.noun} create --first-name Anna --last-name Example --position Buyer`
        : `${noun.noun} create --name "Example LLC"`,
    ).action(async (opts: Typed, leaf: Command) => {
      await within(leaf, async (run) => {
        const done = await createCrmRecord(contextOf(run, leaf), noun.kind, inputOf(opts), idOf(opts))
        return answered(done)
      })
    })
  if (writes.verbs.includes("update"))
    example(
      fields(
        command(
          "update",
          `change a ${noun.kind} in the CRM; what is left out keeps its value; the CRM's copy is stored again`,
        ).argument(`<${noun.kind}>`, `the CRM's id of the ${noun.kind}, as list prints it`),
      ),
      person ? `${noun.noun} update 42 --position Buyer` : `${noun.noun} update 9 --name "Example Ltd"`,
    ).action(async (id: string, opts: Typed, leaf: Command) => {
      await within(leaf, async (run) => {
        const done = await updateCrmRecord(contextOf(run, leaf), noun.kind, id, inputOf(opts), idOf(opts))
        return answered(done)
      })
    })
}

const idOf = (opts: { operationId?: string }) =>
  opts.operationId === undefined ? {} : { operationId: opts.operationId }
