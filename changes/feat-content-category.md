### Added

- **The content category: posts and pages of a site such as WordPress, in the store.** Store version 71 adds
  channels, authors, tags and categories, posts with their text as Markdown, the versions a sync or a write replaced,
  metrics readings and a word index. `@wirecat/cli-core/content` has the `ContentSource` and `ContentWriter` ports,
  `syncContent` (a trashed post stays with the status `trashed`, a post deleted for good is marked so only by a
  complete id pass, and a pass is held when the sign-in read only part or the site moved), and `addContentCommands`:
  `sync`, `posts list|show|search`, `authors list`, `terms list`, `channels list`, `metrics show`, and with writes
  `posts create|update|publish|unpublish|schedule|delete`. Publishing asks first (`posts.publish`, the key the `api`
  group checks), and so do an edit of a public post and a deletion past the trash (`posts.delete.force`).
- **`contentSourceFromManifest` and `contentWriterFromManifest`** build a content CLI's source and writer from
  configuration over its generated `api` group. A WordPress manifest needs no hook. The category `content` joins
  `wirecat.config`. See [Content](../docs/dev/CONTENT.md).
- **`/content/testing`**: `contentSourceContract`, `contentSyncContract`, `contentWriteContract` and
  `fakeContentSource`.
