# Which tool owns which command

Status: decided by the owner 2026-10-11; nothing moved yet. The steps are at the end.

Today tg and max carry commands about data they did not bring in (`tg search mail`, `tg search notes`),
memo repeats some of them, and this package holds everything. Each tool gets one job instead.

## Three roles

| Role | Who | Owns |
|---|---|---|
| **Source tool** | tg, max, zm | Its own service: log in, sync it into the shared local store, act there (send, reply, react, read a chat) |
| **Knowledge tool** | memo, to be renamed | The whole store across sources: search everywhere, a person across messengers and mail, tasks, notes, memories, facts, projects, reminders, vocabulary. Note-folder and mail import are its own sources |
| **Library** | this package (later `@wirecat/cli-base`) | The store, the services, the adapter kit and the shared command builders. No product commands of its own |

**The rule: a command lives where its data comes from.** Data one source brings in is that source tool's.
Data that spans sources, or that no messenger brought in, is the knowledge tool's.

**The exception: basic notes, tags and tasks on a source's own things stay in the source tool.** A tg user
writes a note on a contact, tags a chat, or makes a task from a message without installing anything else.
The source tool lists only what points at its own chats, contacts and messages.

**Never in a source tool:** mail, note folders, meetings, or a search across other sources. Installing tg
gives a tg user no mail or notes commands.

Nobody uses these tools yet (owner, 2026-10-11), so a command moves in one step, with no alias.

## The map

Source tools keep every group about their service: `session`, `setup`, `account`, `chats`, `messages`,
`reactions`, `polls`, `topics`, `calls`, `stickers`, `conversations`, `attachments`, `inbox`, `review`,
`watch`, `serve`, `server`, `schedule`, `store`, `flood`, `recipients`, `sends`, `replies`, `runs`,
`metadata`, `bot`, plus the tool plumbing: `config`, `doctor`, `commands`, `complete`, `upgrade`, `mcp`,
`skill`, `models`.

| Today in tg and max | After |
|---|---|
| `search all`, `search mail`, `search notes` | knowledge tool only |
| `search messages`, `search conversations`, `search topics`, `searches` | source tool, limited to its own accounts |
| `contacts context` (every messenger, mail, meetings) | knowledge tool; the source tool keeps the contact's own record |
| `contacts notes` | source tool (a note on its own contact) |
| `tags add/remove/list/auto` on chats, contacts, messages | source tool, on its own things |
| `tasks add` from a message, `tasks list/close/plan/link/show` | source tool for tasks whose source is its own message or chat |
| `tasks agenda`, tasks across sources, task-to-task links, assign | knowledge tool |
| `stats tasks` | knowledge tool; `stats` about messages and chats stays |

Already only in the knowledge tool, and staying there: notes import, export and folders, mail import,
memories, facts, proposed actions, the agent log, organizations, projects, relationships, reminders,
vocabulary, `ask`, scheduled imports. The knowledge tool's MCP server is the one an agent uses for these;
a source tool's MCP server offers only its own service.

## What the library does

A shared command (search, tags, tasks) stays a builder here, and each tool mounts the part it may offer:
a source tool mounts it scoped to its own provider, the knowledge tool mounts all of it. The
[parity manifest](../../parity.json) gets a list per kind of tool, so a source tool that gains
`search mail` fails `parity:check`.

## Steps

1. Name the knowledge tool. `memo` is a short, generic word that other note tools may use (not checked
   beyond npm); the npm packages `memo` and `wire` install no command, the `wcat` package installs one,
   and nothing on npm or Homebrew is called `wirecat`.
2. Scope the shared builders: a provider filter for search, tags and tasks, and a flag for which parts a
   tool mounts. Here, released before the tools change.
3. tg and max drop the cross-source commands in the table, one release each. The knowledge tool adds
   `tasks agenda`; its search already covers every source.
4. The parity manifest records the split; the standard (`STANDARD.md`) says which groups a source tool has.
