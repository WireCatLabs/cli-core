import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { QueryRegistry } from "@wirecat/cli-base/query"
import type { NextStep } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { environmentOf, inCommandRun, outputFor, runBudgetOf } from "../../cli/context.js"
import { honoursDryRun } from "../../cli/dry-run-guard.js"
import { FETCH, LOCAL_READ, NO_EFFECTS, REMOTE_WRITE } from "../../cli/effects.js"
import { type Body, itemOf, listOf, renderAnswer } from "../../cli/envelope.js"
import { listQuery, nativeTermLists, termField, typedQuery, withQuery } from "../../cli/list-query.js"
import { terminalAsker } from "../../cli/messenger/ask.js"
import { CONTENT_KINDS, type ContentPost, POST_STATUSES, POST_TYPES, type PostStatus } from "../../domain/content.js"
import { aheadOf } from "../../domain/moment.js"
import { count, text } from "../../entities/fields.js"
import type { AppIdentity } from "../../ports/app.js"
import { refusedPlace } from "../../sends/upload.js"
import type { ContentFilter, ContentItem } from "../../store/sqlite/content.js"
import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import type { ContentSource } from "../source.js"
import { syncContent } from "../sync.js"
import type { ContentFields } from "../writer.js"
import {
  type ContentWriteContext,
  type ContentWrites,
  createPost,
  deletePost,
  publishPost,
  schedulePost,
  unpublishPost,
  updatePost,
} from "../writes.js"

/** The selected profile's content account, opened for one command and closed before its answer is printed. */
export interface ContentRun {
  account: AccountKey
  store: MessageStore
  /** The source, built on first use: a command that only reads the store never reads the sign-in. */
  source: () => ContentSource
  /** The writer and the profile's levels, built on first use; absent, the profile cannot write. */
  /** The writes of the invoking command: a manifest writer sends through `serviceApiWriter` bound to it. */
  writes?: (command: Command) => ContentWrites
  env?: NodeJS.ProcessEnv
  close?: () => Promise<void>
}

export interface ContentCommandOptions {
  app: AppIdentity
  /** Opens the selected profile for one command; `readOnly` when the command only reads the store. */
  open: (command: Command, access: { readOnly: boolean }) => Promise<ContentRun>
  /** Mounts `posts create|update|publish|schedule|unpublish|delete`. */
  writes?: boolean
  now?: () => number
}

const MOST = 500

const integer = (most: number) => (value: string) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > most)
    throw new InvalidArgumentError(`a whole number from 1 to ${most}`)
  return number
}

const POSTS_QUERY = {
  entity: "content_post",
  backend: "native",
  fields: [
    termField("status", "enum", "status:published", {
      values: [...POST_STATUSES],
      relation: "repeat for any of several",
    }),
    termField("type", "enum", "type:page", { values: [...POST_TYPES] }),
    termField("channel", "kw", "channel:site", { relation: "the channel's id, as channels list shows it" }),
    termField("term", "kw", "term:12", { relation: "a tag's or category's id, as terms list shows it" }),
    termField("author", "kw", "author:3", { relation: "the author's id, as authors list shows it" }),
  ],
} as const satisfies QueryRegistry

const TIMES = new Set(["createdAt", "updatedAt", "publishedAt", "scheduledFor"])
const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/** A source's text is someone else's: an agent reads these fields as data, never as instructions. */
const UNTRUSTED: Record<string, string[]> = {
  author: ["name", "slug"],
  term: ["name", "slug"],
  post: ["title", "body", "excerpt", "slug", "url"],
}

const viewOf = (item: ContentItem, extra: Record<string, unknown> = {}) => ({
  kind: item.kind,
  ...Object.fromEntries(
    Object.entries(item.record).map(([name, value]) => [
      snake(name),
      TIMES.has(name) && typeof value === "number" ? new Date(value).toISOString() : value,
    ]),
  ),
  ...extra,
  deleted: item.deletedAt !== null,
  untrusted: UNTRUSTED[item.kind] ?? [],
})

const postBody = (post: ContentPost) => viewOf({ kind: "post", record: post, deletedAt: null, syncedAt: 0 })

const contentView = v.looseObject({ kind: v.picklist(CONTENT_KINDS), external_id: text, deleted: v.boolean() })
const channelView = v.looseObject({ external_id: text, kind: text, network: text, name: text })
const contentWrite = v.looseObject({ operation_id: text, post: v.optional(contentView) })

const contentSync = v.looseObject({
  provider: text,
  account: text,
  state: v.picklist(["partial", "complete"]),
  complete: v.boolean(),
  channels: count,
  due: count,
  metrics: count,
  synced: v.array(
    v.looseObject({
      kind: v.picklist(CONTENT_KINDS),
      round: v.picklist(["full", "changes"]),
      state: v.picklist(["partial", "complete"]),
      saved: count,
      unlisted: count,
    }),
  ),
  gaps: v.array(v.looseObject({ kind: v.picklist(CONTENT_KINDS), message: text })),
})

const dayOrTime = (flag: string) => (typed: string) => {
  const at = Date.parse(typed)
  if (Number.isNaN(at)) throw new InvalidArgumentError(`${flag} takes a day (YYYY-MM-DD) or an ISO 8601 time`)
  return at
}

const collect = (value: string, previous: string[]) => [...previous, value]

const addContentCommandsDefinition = (program: Command, options: ContentCommandOptions): void => {
  const now = () => options.now?.() ?? Date.now()
  const within = (command: Command, readOnly: boolean, work: (run: ContentRun) => Promise<Body>) =>
    inCommandRun(command, async () => {
      const run = await options.open(command, { readOnly })
      let body: Body
      try {
        body = await work(run)
      } finally {
        await run.close?.()
      }
      renderAnswer(command, outputFor(command), body)
    })
  const example = (command: Command, ...lines: string[]) =>
    annotate(command, { examples: lines.map((line) => `${options.app.command} work ${line}`) })
  const paging = (command: Command) =>
    command
      .option("--limit <n>", `rows per page, 1–${MOST}`, integer(MOST), 50)
      .option("--page <n>", "which page, starting at 1", integer(1_000_000), 1)

  example(
    answerEntity(
      annotate(program.command("sync"), { effects: FETCH, offline: false, cooperative: true, partial: true }),
      "content_sync",
      contentSync,
    ).description(
      "bring the copy of your posts up to date: channels, authors, tags and categories, and posts that changed since " +
        "the last sync, or everything with --rescan. Once a day it also finds what the site deleted for good; trash " +
        "stays a status. A site whose address changed, or a sign-in that sees only part, marks nothing deleted",
    ),
    "sync",
    "sync --rescan",
  )
    .option("--rescan", "list everything again, every id too, dropping a round in progress")
    .option("--max-pages <pages>", "at most this many requests to the source in this run", integer(100_000))
    .action(async (opts: { maxPages?: number; rescan?: boolean }, command: Command) => {
      const { signal } = environmentOf(command)
      await within(command, false, async (run) => {
        const report = await syncContent(run.source(), run.store, run.account, {
          now: now(),
          budget: runBudgetOf(command, opts.maxPages),
          ...(signal ? { signal } : {}),
          ...(opts.rescan ? { rescan: true } : {}),
        })
        const failed = report.synced.filter((one) => one.error !== undefined)
        const next: NextStep[] | undefined =
          report.state === "partial" && report.progress.steps > 0
            ? [
                {
                  kind: "command",
                  step: "content.sync",
                  command: "sync",
                  args: opts.maxPages === undefined ? {} : { max_pages: opts.maxPages },
                  why: failed.length
                    ? "a kind failed to sync; running sync again retries it"
                    : "the sync stopped before its end; running it again goes on from there",
                  safe_to_auto_execute: true,
                },
              ]
            : undefined
        const issues = [
          ...failed.map((one) => ({
            code: "provider_error" as const,
            reason: "sync.partial",
            source: `content:${one.kind}`,
          })),
          ...report.synced
            .filter((one) => one.pass === "held")
            .map((one) => ({
              code: "validation_error" as const,
              reason: "content.unlisted-held",
              source: `content:${one.kind}`,
            })),
        ]
        return itemOf(report, {
          ...(report.state === "partial" || issues.length
            ? { meta: { complete: false, ...(issues.length ? { issues } : {}) } }
            : {}),
          ...(next ? { next } : {}),
        })
      })
    })

  const channels = annotate(program.command("channels"), { effects: NO_EFFECTS }).description(
    "the sites and social accounts this profile publishes on",
  )
  example(
    answerEntity(
      annotate(channels.command("list"), { effects: LOCAL_READ }),
      "content_channel",
      channelView,
    ).description("the channels copied by the last sync"),
    "channels list",
  ).action(async (_opts: unknown, command: Command) => {
    await within(command, true, async (run) => {
      const items = (await run.store.content.channels(run.account)).map((one) => ({
        ...Object.fromEntries(Object.entries(one).map(([name, value]) => [snake(name), value])),
        untrusted: ["name", "handle"],
      }))
      return listOf("channels list", { items, limit: items.length, page: 1, has_more: false })
    })
  })

  const posts = annotate(program.command("posts"), { effects: NO_EFFECTS }).description(
    "posts and pages as last synced, with their text as Markdown",
  )
  example(
    paging(
      withQuery(
        answerEntity(annotate(posts.command("list"), { effects: LOCAL_READ }), "content_post", contentView),
        POSTS_QUERY,
      )
        .description("posts copied from the source, newest change first; run sync to bring them up to date")
        .option("--since <day>", "published on or after this day or time", dayOrTime("--since"))
        .option("--until <day>", "published before this day or time", dayOrTime("--until")),
    ),
    "posts list status:draft",
    "posts list type:page --since 2026-01-01",
  ).action(
    async (
      words: string[],
      opts: { limit: number; page: number; since?: number; until?: number },
      command: Command,
    ) => {
      const lists = nativeTermLists(listQuery(typedQuery(words), POSTS_QUERY, "posts list"), "posts list", ["status"])
      if ([...lists.values()].flat().some((one) => one.operator !== "term" && one.operator !== "phrase"))
        throw new InvalidArgumentError("posts list takes field:value terms, each one whole value")
      const statuses = (lists.get("status") ?? []).map((one) => String(one.value).toLowerCase() as PostStatus)
      const terms = new Map(
        [...lists].filter(([field]) => field !== "status").map(([field, [one]]) => [field, String(one?.value)]),
      )
      await within(command, true, async (run) => {
        const filter: ContentFilter = {
          ...(statuses.length ? { statuses } : {}),
          ...(terms.has("type") ? { type: terms.get("type") as ContentFilter["type"] } : {}),
          ...(terms.has("channel") ? { channel: terms.get("channel") as string } : {}),
          ...(terms.has("term") ? { term: terms.get("term") as string } : {}),
          ...(terms.has("author") ? { author: terms.get("author") as string } : {}),
          ...(opts.since === undefined ? {} : { since: opts.since }),
          ...(opts.until === undefined ? {} : { until: opts.until }),
          limit: opts.limit,
          offset: (opts.page - 1) * opts.limit,
        }
        const found = await run.store.content.list(run.account, "post", filter)
        return listOf("posts list", {
          items: found.items.map((one) => viewOf({ ...one, record: { ...one.record, body: undefined } })),
          limit: opts.limit,
          page: opts.page,
          has_more: found.hasMore,
          ...(words.length ? { args: { query: words } } : {}),
        })
      })
    },
  )
  example(
    answerEntity(annotate(posts.command("show"), { effects: LOCAL_READ }), "content_post_detail", contentView)
      .description("one post with its text, its authors and tags by name, its earlier versions and its last numbers")
      .argument("<post>", "the post's id at the source, as posts list shows it"),
    "posts show 10",
  ).action(async (id: string, _opts: unknown, command: Command) => {
    await within(command, true, async (run) => {
      const found = await run.store.content.get(run.account, "post", id)
      if (!found) throw new CliError("not_found", `no post ${id} in the copy; run sync, then try again`)
      const named = async (kind: "author" | "term", ids: readonly string[] = []) =>
        (await Promise.all(ids.map((one) => run.store.content.get(run.account, kind, one)))).flatMap((one) =>
          one ? [{ external_id: one.record.externalId, name: one.record.name }] : [],
        )
      const people = new Map(
        (await run.store.content.people(run.account, found.record.authors ?? [])).map((one) => [one.author, one]),
      )
      const versions = await run.store.content.revisions(run.account, id)
      const [metric] = await run.store.content.metrics(run.account, id, 1)
      return itemOf(
        viewOf(found, {
          authors_named: (await named("author", found.record.authors)).map((one) => ({
            ...one,
            ...(people.has(one.external_id) ? { person: people.get(one.external_id)?.person } : {}),
          })),
          terms_named: await named("term", found.record.terms),
          versions: versions.map((one) => ({
            title: one.title,
            status: one.status,
            reason: one.reason,
            at: new Date(one.createdAt).toISOString(),
          })),
          ...(metric ? { metrics: { ...metric, at: new Date(metric.at).toISOString() } } : {}),
        }),
      )
    })
  })
  example(
    paging(
      answerEntity(annotate(posts.command("search"), { effects: LOCAL_READ }), "content_hit", contentView)
        .description("find posts in the copy by the words of their title and text")
        .argument("<words...>", "every word must match; prefixes of three letters or more match too"),
    ),
    'posts search "pricing change"',
  ).action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
    await within(command, true, async (run) => {
      const found = await run.store.content.find({
        words,
        accounts: [run.account],
        limit: opts.limit,
        offset: (opts.page - 1) * opts.limit,
      })
      return listOf("posts search", {
        items: found.items.map((hit) =>
          viewOf({ ...hit.item, record: { ...hit.item.record, body: undefined } }, { excerpt: hit.excerpt }),
        ),
        limit: opts.limit,
        page: opts.page,
        has_more: found.hasMore,
        args: { words },
      })
    })
  })

  for (const [kind, plural, what] of [
    ["author", "authors", "the source's authors, each with the person the store knows by the same e-mail"],
    ["term", "terms", "the source's tags and categories"],
  ] as const) {
    const group = annotate(program.command(plural), { effects: NO_EFFECTS }).description(what)
    example(
      paging(
        answerEntity(annotate(group.command("list"), { effects: LOCAL_READ }), `content_${kind}`, contentView),
      ).description(`${plural} copied from the source`),
      `${plural} list`,
    ).action(async (opts: { limit: number; page: number }, command: Command) => {
      await within(command, true, async (run) => {
        const found = await run.store.content.list(run.account, kind, {
          limit: opts.limit,
          offset: (opts.page - 1) * opts.limit,
        })
        const people =
          kind === "author"
            ? new Map(
                (
                  await run.store.content.people(
                    run.account,
                    found.items.map((one) => one.record.externalId),
                  )
                ).map((one) => [one.author, one.person]),
              )
            : new Map<string, string>()
        return listOf(`${plural} list`, {
          items: found.items.map((one) =>
            viewOf(one, people.has(one.record.externalId) ? { person: people.get(one.record.externalId) } : {}),
          ),
          limit: opts.limit,
          page: opts.page,
          has_more: found.hasMore,
        })
      })
    })
  }

  const metrics = annotate(program.command("metrics"), { effects: NO_EFFECTS }).description(
    "readings of a post's numbers, one per sync, each kept",
  )
  example(
    answerEntity(
      annotate(metrics.command("show"), { effects: LOCAL_READ }),
      "content_metric",
      v.looseObject({ post: text, at: text }),
    )
      .description("a post's readings, the newest first")
      .argument("<post>", "the post's id at the source"),
    "metrics show 10",
  ).action(async (id: string, _opts: unknown, command: Command) => {
    await within(command, true, async (run) => {
      const items = (await run.store.content.metrics(run.account, id)).map((one) => ({
        ...one,
        at: new Date(one.at).toISOString(),
      }))
      return listOf("metrics show", { items, limit: items.length, page: 1, has_more: false })
    })
  })

  if (!options.writes) return

  const contextOf = (run: ContentRun, command: Command): ContentWriteContext => {
    if (!run.writes) throw new CliError("configuration_error", "this profile cannot write to its source")
    return {
      store: run.store,
      account: run.account,
      writes: run.writes(command),
      ask: terminalAsker(command),
      source: run.source,
      now,
    }
  }
  const bodyOf = (run: ContentRun, path: string | undefined): string | undefined => {
    if (path === undefined) return undefined
    if (path !== "-" && refusedPlace(path, options.app, run.env ?? process.env))
      throw new CliError("validation_error", `--body-file may not read ${path}: it holds sign-ins or state`, {
        param: "--body-file",
      })
    return readFileSync(path === "-" ? 0 : path, "utf8")
  }
  const answered = (operationId: string, post: ContentPost | null, extra: Record<string, unknown> = {}) =>
    itemOf({ operation_id: operationId, ...(post ? { post: postBody(post) } : {}), ...extra })
  const write = (name: string, description: string) =>
    answerEntity(
      annotate(posts.command(name), { effects: REMOTE_WRITE, offline: false }),
      "content_write",
      contentWrite,
    ).description(description)
  const fields = (command: Command) =>
    command
      .option("--title <title>", "the post's title")
      .option("--body-file <path>", "the text as Markdown, from a file, or - for stdin")
      .option("--excerpt <text>", "the short text lists show")
      .option("--slug <slug>", "the address's last part")
      .option(
        "--term <id>",
        "a tag's or category's id, as terms list shows it; repeat it; replaces the list",
        collect,
        [],
      )
  type Typed = { title?: string; bodyFile?: string; excerpt?: string; slug?: string; term: string[] }
  const fieldsOf = (run: ContentRun, typed: Typed): ContentFields => {
    const body = bodyOf(run, typed.bodyFile)
    return {
      ...(typed.title === undefined ? {} : { title: typed.title }),
      ...(body === undefined ? {} : { body }),
      ...(typed.excerpt === undefined ? {} : { excerpt: typed.excerpt }),
      ...(typed.slug === undefined ? {} : { slug: typed.slug }),
      ...(typed.term.length ? { terms: typed.term } : {}),
    }
  }

  example(
    fields(write("create", "write a new draft; publishing is its own step, posts publish")).option(
      "--type <type>",
      `${POST_TYPES.join(" or ")}; post when left out`,
    ),
    "posts create --title 'Version 3' --body-file notes.md",
  ).action(async (typed: Typed & { type?: string }, command: Command) => {
    if (typed.type !== undefined && !(POST_TYPES as readonly string[]).includes(typed.type))
      throw new InvalidArgumentError(`--type is ${POST_TYPES.join(" or ")}`)
    await within(command, false, async (run) => {
      const done = await createPost(contextOf(run, command), {
        ...fieldsOf(run, typed),
        ...(typed.type ? { type: typed.type as ContentPost["type"] & string } : {}),
      })
      return answered(done.operationId, done.post)
    })
  })
  example(
    fields(
      write(
        "update",
        "change a post's fields; a published or scheduled post's change is public and checks posts.publish too",
      ).argument("<post>", "the post's id at the source"),
    ).option(
      "--replace-body",
      "write the body over a post whose blocks or embeds Markdown cannot keep, flattening them",
    ),
    "posts update 10 --title 'Version 2 is out now'",
  ).action(async (id: string, typed: Typed & { replaceBody?: boolean }, command: Command) => {
    await within(command, false, async (run) => {
      const done = await updatePost(contextOf(run, command), id, fieldsOf(run, typed), {
        ...(typed.replaceBody ? { replaceBody: true } : {}),
      })
      return answered(done.operationId, done.post)
    })
  })
  for (const [name, description, act] of [
    ["publish", "publish a post now; a published post is answered as it is", publishPost],
    ["unpublish", "bring a published or scheduled post back to a draft", unpublishPost],
  ] as const)
    example(write(name, description).argument("<post>", "the post's id at the source"), `posts ${name} 11`).action(
      async (id: string, _opts: unknown, command: Command) => {
        await within(command, false, async (run) => {
          const done = await act(contextOf(run, command), id)
          return answered(done.operationId, done.post, done.unchanged ? { unchanged: true } : {})
        })
      },
    )
  example(
    write("schedule", "publish a post at a later time; checks posts.publish too")
      .argument("<post>", "the post's id at the source")
      .requiredOption(
        "--at <time>",
        "when it goes out: an ISO 8601 time, a day, or 3d from now; it must be ahead",
        (typed: string) => aheadOf(typed, "--at", Date.now()),
      ),
    "posts schedule 11 --at 2026-12-01T09:00:00Z",
  ).action(async (id: string, opts: { at: number }, command: Command) => {
    await within(command, false, async (run) => {
      const done = await schedulePost(contextOf(run, command), id, opts.at)
      return answered(done.operationId, done.post)
    })
  })
  example(
    write("delete", "move a post to the source's trash, from which it comes back; --force deletes it for good")
      .argument("<post>", "the post's id at the source")
      .option("--force", "delete it for good, past the trash; checks posts.delete.force"),
    "posts delete 11",
  ).action(async (id: string, opts: { force?: boolean }, command: Command) => {
    await within(command, false, async (run) => {
      const done = await deletePost(contextOf(run, command), id, opts.force ? { force: true } : {})
      return answered(done.operationId, done.post, { deleted: done.deleted })
    })
  })
}

/**
 * The content commands: `sync`, `channels list`, `posts list|show|search`, `authors list`, `terms list`,
 * `metrics show`, and with `writes` `posts create|update|publish|schedule|unpublish|delete`.
 */
export const addContentCommands = honoursDryRun(sharedCommand(addContentCommandsDefinition))
