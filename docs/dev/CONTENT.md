# Content

`src/content/`, exported as `@wirecat/cli-core/content` and `/content/testing`. A content CLI (WordPress first) keeps
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
returns. Then the scheduled posts whose time has passed are read again one by one (up to 50, the longest unread
first), so a post that went out is published in the copy, and one deleted is marked so.

Once a day an id pass lists every id. It is held, marking nothing, when the list is empty, when it would mark more than
half of a kind of ten rows or more, when a page of it was refused (in this run or the run it resumes), or when the site
moved. Otherwise each stored row the list lacks is read once more with `get`, and only a row the source says is gone
is marked deleted: a list paged by number skips a row when an earlier one is deleted between pages. A source that
cannot read one row by id throws `content.get-unsupported`, and then absence from a complete list marks it. A budget
stops a run between requests; the next run goes on from the page it reached.

## Writes and permissions

`addContentCommands(program, { app, open, writes: true })` adds `posts create|update|publish|unpublish|schedule|delete`.
Every write is checked and journaled through `guardedWrite`, its operation id kept, a lost answer `outcome_unknown`.

| Key | Default | Checked for |
|---|---|---|
| `posts.create`, `posts.update`, `posts.delete` | `ask` | the write itself |
| `posts.publish` | `ask` | publish, schedule, and an update of a published or scheduled post |
| `posts.delete.force` | `ask` | `posts delete --force`, past the trash |

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
- The one channel's id is `site`, whatever the address: a profile pointed at another address is a moved channel.
- Write fields are dotted paths into the body: WordPress takes `title.raw`, `content.raw` and `excerpt.raw`.
- The writer writes posts. Pages are read; a write to a page is refused as `content.write-unsupported`.
- `writes` names the create, update, trash and delete calls, where each of our fields goes, and the values over the
  update call that publish, schedule at `"{at}"` and unpublish. A write goes only through `write`, the `api` group's
  `serviceApiWriter` bound to the invoking command, which checks the profile's keys as a raw call would.

The WordPress manifest in `test/fixtures/wordpress-content.ts` is configuration only, no hook, and the source and write
contract kits pass over it against a fake site that answers as WordPress 6.9 does.

## The contract kits

`contentSourceContract`, `contentSyncContract` and `contentWriteContract` (`/content/testing`), with
`fakeContentSource`, a stateful fake blog. A source or writer adapter runs the first and the last in its tests.
