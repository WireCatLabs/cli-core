### Changed — may break callers

- **cli-core ships pre-bundled, and its 51 entry points are now 7.** `exports` points at `dist/bundle/`, one esbuild
  build split into chunks and merged by rolldown, so a CLI loads cli-core from this package instead of carrying its own
  copy: tg's `dist/bundle` goes from 14.7 MB to 1.7 MB, the template's from 13.0 MB to 0.03 MB. Warm `--help` of tg
  measured +28 ms against the private copy, the template's +19 ms (Node 24, median of 30 and 10 runs). A CLI must take
  this release together with cli-base 2.0.0, the peer range now: an older `cli-dev bundle` copies cli-core privately
  again. The unbundled `dist/**/*.js` stay in the package: a bundled module names its own file through
  `import.meta.url`, and the embedding process starts from `dist/embeddings/child.js`.

  | Before | Now |
  |---|---|
  | `.`, `./cli`, `./store`, `./store/areas`, `./sends`, `./update`, `./services`, `./background`, `./manifest`, `./oauth`, `./constants`, `./models`, `./files`, `./crm`, `./crm/cli`, `./meetings`, `./meetings/cli`, `./meetings/mcp`, `./calendar`, `./calendar/cli`, `./calendar/mcp`, `./tracker`, `./content`, `./tasks`, `./google`, `./speech`, `./speech/wav`, `./persistence/native`, `./parity`, `./charts`, `./sql`, `./sftp`, `./mount`, `./office` | `.` |
  | `./cli/start`, `./sqlite-runtime` | `./start` |
  | `./mcp` | `./mcp` |
  | `./documents`, `./documents/cli` | `./documents` |
  | `./mail`, `./mail/cli` | `./mail` |
  | `./testing`, `./crm/testing`, `./meetings/testing`, `./calendar/testing`, `./tracker/testing`, `./content/testing`, `./mail/testing`, `./documents/testing`, `./tasks/testing`, `./skill-validation` | `./testing` |
  | — | `./preload` (new), `./package.json` (new) |
  | `./internal/*` (types only) | removed: no CLI used it |
  | `./parity.json`, `./schemas/records-envelope.v1.schema.json`, `./schemas/examples/records-business.jsonl` | unchanged |

  Five types that two areas named alike are renamed in `.`; the old name keeps the other area's type:
  `Attachment` from `./meetings` → `MeetingAttachment`, `Finding` from `./meetings` → `MeetingFinding`, `Transcript`
  from `./meetings` → `MeetingTranscript`, `TokenStorage` from `./oauth` → `OAuthTokenStorage`, `GroupMember` from
  `./services` → `GroupContextMember`. `SCOPES` from `./services` and from `./store/areas` are now one array.
  `matches` (tasks and mail) and `within` (documents and mail) keep their meaning per entry point: they stay apart.

  What a CLI changes, mechanically:
  - Rewrite each import specifier by the table above, then merge the imports that now share one specifier.
  - Import `startCli` and `ensureSqlite` from `@wirecat/cli-core/start` in the bin; `.` loads the whole program.
  - `vi.mock("@wirecat/cli-core/<old path>")` becomes `vi.mock("@wirecat/cli-core")` or the new entry: gcal-cli and
    max-cli mock `./cli`, zoom-cli `./services` and `./store`, cli-memo `./store`. The mock only reaches the CLI's
    own calls, as before.
  - Deep `dist/` imports read unbundled files the bundle does not use, so a mock of them no longer reaches cli-core:
    cli-memo mocks `node_modules/@wirecat/cli-core/dist/embeddings/models.js` (`src/search/search-meaning.test.ts`),
    cli-testing imports `dist`, `dist/cli/index.js` and `dist/store/index.js`, cli-base `dist/index.js`. Move them to
    an entry point.
  - biome rules naming `@wirecat/cli-core/store/*` (slack-cli, whatsapp-cli) and `@wirecat/cli-core/*`
    (whatsapp-cli) match nothing now.
  - The stable API is `.`, `./mcp`, `./start` and `./testing`; names from the areas that were experimental entry
    points stay experimental inside `.` ([what may break](../docs/REFERENCE.md#how-often-and-what-may-break)).

### Added

- **`@wirecat/cli-core/preload`** loads every file of the bundle and resolves the bundle's own chunks without looking
  on disk, so a server keeps answering after an upgrade replaces the package under it. The CLI's loader calls it 2 s
  after a server starts and before `upgrade`.
