### Added

- **A content manifest writes pages: `writes.page`.** It names a page's own create, update, trash and delete calls,
  and its `fields` when they differ from a post's. `posts create --type page` and every write to a page then go by
  those calls, and the answer stays a page in the copy. Without it a page write is still refused as
  `content.write-unsupported`, and so are tags on a type whose fields have none
  ([CONTENT.md](../docs/dev/CONTENT.md#content-from-a-manifest)).
- **`optional.fallback`: a refused call is sent again in a simpler form.** It names query values over the call's own
  (WordPress: `context: "view"` for the users, which only an administrator lists with `context=edit`). An editor or
  an author then gets the authors with published posts, by name and without e-mail, and the gap says the fallback's
  message. `contentManifestFake` answers that form of a `denied` operation, and its new `hidden` names rows a
  sign-in may not see.
- **`openContentStore`** (`@wirecat/cli-core/content`): the store helper of a content CLI's `open`, so content no
  longer opens the store with the CRM's `openCrmStore`. Both come from `openProfileStore`; `openCrmStore` stays.

### Fixed

- **An author or a contributor no longer lists every post on every sync, and sees a post deleted for good.** A gap
  that is a right the role lacks (`optional.requires`, `needs`, `fallback`; `ContentGap.lasting`) now lets the cursor
  move on, and the id pass reads each post it no longer lists once more by its id: only a 404 marks it deleted, a
  refusal keeps it. The cursor keeps the rights the role lacked; once it has one more, the kind is listed in full
  again.
- **A post's text keeps its `-` list marker.** `htmlToMarkdown` wrote `* one` for `- one`, so a body read back
  differed from the file it was written from.
- **`content.schedule-past` names `--at-time`,** the option `posts publish` takes, not `--at`.
