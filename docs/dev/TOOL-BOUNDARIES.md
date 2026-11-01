# Which tool owns which command

Status: decided by the owner 2026-10-11, revised 2026-10-14: tg and max keep notes, tags and tasks, and
`search notes` and `search all` (messages, notes and calendar events, no mail); they drop `search mail`. Done: `search mail` (see
the end).

Until this split, tg and max carried commands about data they did not bring in (`tg search mail`), memo
repeated some of them, and this package held everything. Each tool gets one job instead.

## Three roles

| Role | Who | Owns |
|---|---|---|
| **Source tool** | tg, max, zm, mail-cli | Its own service: log in, sync it into the shared local store, act there (send, reply, react, read a chat) |
| **Knowledge tool** | memo, to be renamed | The whole store across sources: search everywhere, a person across messengers and mail, tasks, notes, memories, facts, projects, reminders, vocabulary. Note-folder import is its own source; it reads mail from the store, and never fetches it |
| **Library** | this package (later `@wirecat/cli-base`) | The store, the services, the adapter kit and the shared command builders. No product commands of its own |

**The rule: a command lives where its data comes from.** Data one source brings in is that source tool's.
Data that spans sources, or that no messenger brought in, is the knowledge tool's.

**The exception: notes, tags and tasks stay in the source tool** (owner, 2026-10-14). A tg user writes a
note on a contact, tags a chat, makes a task from a message, reads `tasks agenda`, and finds notes with
`search notes` or messages and notes together with `search all`, without installing anything else. `review`,
`serve` and a reply rule's `task` action still open tasks there. These commands are the shared builders here;
memo mounts the same ones (`Messenger.accountOf`).

**Mail is fetched by its own source tool**, `mail-cli`, like messengers and calendars: it signs in, fetches, and writes
the store through the shared `./mail` engine ([MAIL.md](MAIL.md)). It is a source tool, and the rule that a command lives
where its data comes from holds for it. tg and max do not read mail: tg has no `search mail` (it is an unknown command
there), and their `search all` never reads mail. mail-cli searches and reads its own mailbox (`search messages`,
`messages show`, `conversations list|show`, from `@wirecat/cli-core/mail/cli`), as tg searches its own messages; search
across mailboxes and sources, and linking mail to people and projects, stays in the knowledge tool. Both read with the
same `searchMail` and `showMail`, so a query and an email's JSON are the same in each.

Nobody uses these tools yet (owner, 2026-10-11), so a command moves in one step, with no alias.

## The map

Source tools keep every group about their service: `session`, `setup`, `account`, `chats`, `messages`,
`reactions`, `polls`, `topics`, `calls`, `stickers`, `conversations`, `attachments`, `inbox`, `review`,
`watch`, `serve`, `server`, `schedule`, `store`, `flood`, `recipients`, `sends`, `replies`, `runs`,
`metadata`, `bot`, plus the tool plumbing: `config`, `doctor`, `commands`, `complete`, `upgrade`, `mcp`,
`skill`, `models`.

| Today in tg and max | After |
|---|---|
| `search mail` | knowledge tool only; the source tool points to it |
| `search all` | both: in the source tool messages, notes and calendar events, never mail; in the knowledge tool with mail |
| `search notes` | both |
| `search messages`, `search conversations`, `search topics`, `searches` | source tool, limited to its own accounts |
| `contacts context` (every messenger, mail, meetings) | knowledge tool; the source tool keeps the contact's own record |
| `contacts notes` | both (a note on a contact) |
| `tags add/remove/list/auto` on chats, contacts, messages | both |
| `tasks list/add/close/plan/link/show/agenda`, `stats tasks` | both, on the same builders |
| tasks across sources, assign | knowledge tool |

Already only in the knowledge tool, and staying there: notes import, export and folders,
memories, facts, proposed actions, the agent log, organizations, projects, relationships, reminders,
vocabulary, `ask`, scheduled imports. The knowledge tool's MCP server is the one an agent uses for these;
a source tool's MCP server offers only its own service.

## What the library does

A shared command (search, notes, tags, tasks) stays a builder here, and each tool mounts the part it may
offer. A source tool's `search` has no `mail` leaf and its `search all` reads no mail. The
[parity manifest](../../parity.json) lists only the source tools' commands.

## Steps

1. Name the knowledge tool. `memo` is a short, generic word that other note tools may use (not checked
   beyond npm); the npm packages `memo` and `wire` install no command, the `wcat` package installs one,
   and nothing on npm or Homebrew is called `wirecat`.
2. Scope the shared builders: a provider filter for search, tags and tasks, and a flag for which parts a
   tool mounts. Here, released before the tools change.
3. tg and max drop `search mail`, one release each. Done in this package; memo already has it.
   `contacts context` is still open.
4. The parity manifest records the split; the standard (`STANDARD.md`) says which groups a source tool has.
