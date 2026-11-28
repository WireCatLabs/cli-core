# Content

`src/content/`, exported as `@wirecat/cli-core` and `/content/testing`. A content CLI (WordPress first) keeps
the posts and pages of a site in the shared store, syncs them, searches them and writes them, with publishing behind
the owner's question. The CLI writes its sign-in and either a `ContentSource` adapter or a manifest; the copy, the
sync, the commands and the contract kits are shared, as for [trackers](TRACKER.md) and [CRMs](CRM.md). The tables are
in the [schema](../storage/schema.md) (store version 71).

## The domain

Three kinds a sync reads, in this order: `author`, `term`, `post` (`CONTENT_KINDS`, `src/domain/content.ts`). A channel
is where posts go out: for WordPress, the site the profile signed in to, its address the channel's id.

- A **post** has a `type` (`post` or `page`), a `status` (`draft`, `pending`, `scheduled`, `published`, `private`,
  `trashed`), its text as Markdown in `body`, `lossy` when the source's markup holds more than Markdown keeps (block
  comments, embeds, frames), `publishedAt` or `scheduledFor`, its `authors` and `terms` by their source ids, and the
  source's `version` for a write's conflict check. The trash is a status, not a deletion.
- A **term** is a `tag` or a `category`. It also becomes a WireCat tag where its name or slug matches one, and the post
  is tagged with it (`taggings`, type `post`, source `file`); a tag that needs the owner's review is not made.
- **Revisions.** A sync or a write that changes a post's text, title or status keeps the replaced one in
  `content_post_revisions`, and a post the source deleted for good keeps its last text there (`reason: "deleted"`).
- **Metrics** are readings at a time (`content_metrics`), never overwritten. WordPress has none.

## The ports

`ContentSource` (`src/content/source.ts`): `channels()`, `changes(kind, cursor, page?)`, `ids(kind, page?)`,
`get(kind, id)` (null for a row deleted for good) and `metrics?(posts)`. A source that pages inside a call asks
`context.spend()` before each further request, and names what the sign-in could not read with `context.gap()`.

`ContentWriter` (`src/content/writer.ts`): `createDraft`, `update`, `publish`, `schedule`, `unpublish` and
`trash(id, { force })`. Each write carries the copy's version; a post changed at the source since is refused as
`content.conflict`. A publish of a published post sends nothing.

## `syncContent(source, store, account, options)`

Channels first: a channel whose address changed is reported in `moved` and holds every id pass, in this run and the
next ones, until `sync --rescan`. Then each kind's changes since its cursor, with an overlap, page by page; a round in
which a read was refused (a gap) keeps the cursor it started from, so what changed meanwhile is read once access
returns. A gap that is a right the role lacks (`lasting`: `optional.requires`, `optional.needs`, `optional.fallback`)
moves the cursor on, as the round read all the role may see; the cursor keeps the rights it lacked, and a round that
lacks fewer lists the kind in full again, since a right gained shows rows changed before the cursor. Then the scheduled posts whose time has passed are read again one by one (up to 50, the longest unread
first), so a post that went out is published in the copy, and one deleted is marked so; one the sign-in may not read
stays as it is, with a gap.

Once a day an id pass lists every id. It is held, marking nothing, when the list is empty, when it would mark more than
half of a kind of ten rows or more, when a page of it was refused (in this run or the run it resumes), or when the site
moved. A right the role lacks does not hold it where the entity has a `get`: an author's list is complete for what
the author may see, and each row it lacks is read by its id. An entity without a `get` keeps such a gap a refusal. Otherwise each stored row the list lacks is read once more with `get`, and only a row the source says is gone
is marked deleted: a list paged by number skips a row when an earlier one is deleted between pages. A source that
cannot read one row by id throws `content.get-unsupported`, and then absence from a complete list marks it. A budget
stops a run between requests; the next run goes on from the page it reached.

## Commands

`sync`, `channels list`, `users list` (the source's authors), `tags list` (tags and categories), `posts list|show|search`
and `posts stats <post>` (the metric readings). `posts list` narrows by query fields: `status:`, `type:`, `channel:`,
`tag:`, `author:` and `published:` (a time, or a range such as `published:[2026-01-01 TO 2026-02-01]`). A write takes
`--title`, `--text-file <path>` (Markdown; `-` reads stdin), `--description` (the excerpt), `--slug` and `--tags <ids>`
(comma-separated, replacing the post's tags and categories).

## Writes and permissions

`addContentCommands(program, { app, open, writes: true })` adds `posts create|update|publish|unpublish|delete`;
`posts publish --at-time <time>` schedules. A CLI's `open` opens the store with `openContentStore` (the same as the CRM's
`openCrmStore`, from `openProfileStore`): a read takes the account an earlier run saved, and under `<PREFIX>_READ_ONLY`
a read with no store reads an empty one in a temporary folder.
Every write is checked and journaled through `guardedWrite`, its operation id kept, a lost answer `outcome_unknown`.

| Key | Default | Checked for |
|---|---|---|
| `posts.create`, `posts.update`, `posts.delete` | `ask` | the write itself |
| `posts.publish` | `ask` | publish, `publish --at-time`, and an update of a published or scheduled post |
| `posts.delete.force` | `ask` | `posts delete --allow-delete`, past the trash |

`posts.publish` is the value key the `api` group checks for the same publishing through a raw call. Before a write the
post is read again from the source, so the keys follow its status there: WordPress publishes a scheduled post whose time
passed on any edit, and the copy may not know it yet. An update of a `lossy` post's body needs `--replace-body`.

## Content from a manifest

`contentSourceFromManifest(manifest, { api, call, site })` and `contentWriterFromManifest(manifest, { api, write,
command, source, site })` (`src/content/manifest/`) build both ports from configuration over the generated `api` group.

- Each kind lists one entry per call it is read by: tags and categories, posts and pages. An entry names its `list`
  (sorted by id), `changes` (with `"{since}"` and, where the source pages by time, a `keyset` field), `ids`, `get`
  (with `"{id}"`), the `map` onto our fields (the CRM rules: paths, `value`, `map`, `all`), the post's `body` path and
  format (`markdown`, `html`, `wp-blocks`), and `optional`, the gap a refused call reports.
- Times without an offset are UTC, as WordPress's `*_gmt` fields are.
- Pages follow each operation's own `pagination`; a page style with `pagesHeader` stops at the page the header names,
  read through the call's `withHeaders` (`nextPage` reads it). cli-base's `wpJsonToOpenApi` sets that paging on every
  WordPress collection read, so a CLI generated from a site's index pages without a hand-written override; the fixture
  here sets it by hand, as it has no generator.
- `optional.requires` names a read that says whether the sign-in sees every row (WordPress:
  `capabilities.edit_others_posts` of `users/me`): a contributor's list leaves others' posts out with no error, so
  the gap comes from its rights.
- `optional.needs` names a read whose `check` must be true for the call to be sent at all (WordPress:
  `capabilities.edit_pages`, as an author or a contributor is refused pages with a private status). Otherwise the call
  is skipped and the gap says the `needs` message; the kind's other calls sync, and the gap holds its deletions. Each
  rights read is sent once per source, whatever it checks. A read refused with a 400 whose details name 403 is a
  refusal too, so `optional` reports it as a gap.
- `optional.fallback` names the query values a refused call is sent again with (WordPress: `context: "view"` for the
  users, as only an administrator lists them with `context=edit`; an editor or an author is then answered the authors
  with published posts, without their e-mail). Once refused, the source sends the kind's calls in that form, and the
  gap says the fallback's message. A row read then has fewer fields: an author without an e-mail is not joined to a
  person.
- The one channel's id is `site`, whatever the address: a profile pointed at another address is a moved channel.
- Write fields are dotted paths into the body: WordPress takes `title.raw`, `content.raw` and `excerpt.raw`.
- `writes` names the create, update, trash and delete calls, where each of our fields goes, and the values over the
  update call that publish, schedule at `"{at}"` and unpublish. `writes.page` names a page's own create, update, trash
  and delete calls, and its `fields` when they differ (WordPress pages have no tags); the publish values are shared.
  Without it a write to a page is refused as `content.write-unsupported`, and so are tags on a type whose fields have
  none. The answer is read by the post entity of the type written. A write goes only through `write`, the `api` group's
  `serviceApiWriter` bound to the invoking command, which checks the profile's keys as a raw call would.

The WordPress manifest in `test/fixtures/wordpress-content.ts` is configuration only, no hook, and the source and write
contract kits pass over it against a fake site that answers as WordPress 6.9 does.

## The contract kits

`contentSourceContract`, `contentSyncContract` and `contentWriteContract` (`/content/testing`), with
`fakeContentSource`, a stateful fake blog. A source or writer adapter runs the first and the last in its tests.

`contentManifestFake(manifest, { api })` is the service a manifest describes, in memory, for a CLI made from a config:
our example rows written into each entity's shape by its map, read by the calls the manifest names, paged by each
operation's pagination (a page count header and a refused page past the end included), and written by its writes.
`call` and `write` feed `contentSourceFromManifest` and `contentWriterFromManifest`; `fetch` answers the CLI's own
commands over HTTP. A call the manifest does not make lands in `refusals`. `lacks` names the rights a sign-in lacks,
as `check` paths: its rights reads answer false, and a call whose `needs` it lacks is refused (a list with HTTP 400 and
403 in the details, one row with 403, as WordPress refuses an author) and lands in `refusals`; a row that is not
there answers 404 to every role. `denied` names operations refused with 403, as WordPress refuses an author the users
list with `context=edit`; the kind's `optional.fallback` form of the call is answered. `hidden` names rows, by kind,
the sign-in may not see: left out of every list, and a read of one refused with 403, as WordPress hides another
author's draft.
