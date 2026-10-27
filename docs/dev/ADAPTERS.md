# Writing an adapter

How a new messenger CLI joins this package. You write two things: an **adapter**, which speaks to
the messenger, and a **`Messenger`**, which tells the shared commands about it. Then you run the
**contract cases** over your adapter. You do not edit this package.

The port is [`src/ports/messenger.ts`](../../src/ports/messenger.ts). Its doc comments are the
contract. This page is the order to read them in, and the rules that are not in one method.

## Where to import from

| Entry point | What a connector takes from it |
|---|---|
| `@wirecat/cli-core/cli` | `Messenger`, `MessengerAdapter`, `MessengerCore` and the optional groups |
| `@wirecat/cli-core/testing` | the messenger contract kit: `contractSeed`, `contractCases`, `fakeAdapter`; `mcpOverStdio` for MCP tests |
| `@wirecat/cli-core/meetings` | `MeetingSource` and `MeetingStore`, for a meeting provider ([MEETING-PROVIDERS.md](MEETING-PROVIDERS.md)) |
| `@wirecat/cli-core/meetings/testing` | the meeting contract kit: `meetingStoreContract`, `fakeMeetingSource`, `memoryMeetingStore` |
| `@wirecat/cli-core/calendar` | `CalendarSource` and `syncCalendars`, for a calendar provider ([CALENDARS.md](CALENDARS.md)) |
| `@wirecat/cli-core/calendar/testing` | the calendar contract kit: `calendarSourceContract`, `calendarSyncContract`, `fakeCalendarSource`, `memoryEventStore` |
| `@wirecat/cli-core/files` | native ordinary-file identity checks, directory syncing, `writeFileAtomic` and `acquireLock` |
| `@wirecat/cli-core/speech/wav` | bounded PCM16 WAV preflight and 16 kHz streaming, without loading a speech model |
| `@wirecat/cli-core/update` | `appUpdate`: an app's installer, npm's latest version, the update itself and the daily notice |
| `@wirecat/cli-core/oauth` | sign-in for a provider the CLI declares: `tokenKeeper` (refresh under a lock shared by every process), `authorize`, `credentialStorage` and the codecs for drive's and zm's saved entries |
| `@wirecat/cli-core/tasks` | `TaskStore`, when a host keeps tasks itself |

There is no `/sdk` entry point that gathers these; import each name from its own.

## What to build first

1. A `Messenger` with the required fields (below), and a `connect` that returns your adapter.
2. The adapter's **required core**, `MessengerCore`, and — unless your history is pushed to you
   (below) — the `ServerReads` group. With both you get `account`, `chats`, `contacts`,
   `messages list`, `show`, `context`, `send`, `inbox`, `messages sync` and the MCP read tools.
3. The contract cases, passing. Do this before any other optional group.
4. Then the optional groups your messenger has, one at a time.

## The `Messenger`

`Messenger` is in [`src/cli/messenger/context.ts`](../../src/cli/messenger/context.ts).

Required:

| Field | What it is |
|---|---|
| `app` | the CLI's name, its environment prefix and its folders |
| `provider` | the messenger's name in the store, for example `whatsapp`. It is part of every stored key; do not change it later |
| `resolveSettings` | the CLI's settings; `settingsFor(app).resolveSettings` is enough to start |
| `connect` | opens a connection for the profile, or throws `authentication_error` that says how to log in |
| `chatArgument` | the help text for a `<chat>` argument, in your messenger's words |

Optional fields fit the shared commands to your messenger. Leave each one out until a command
needs it. The ones a new messenger usually sets:

- `name` — the messenger's name as its users write it.
- `fetching` — how `messages sync` and `messages download --all` page your history. Set `orderBy: "time"` when your message ids
  are not whole numbers below 2^53.
- `history` — `"store"` when your messenger pushes its history instead of answering for it (below).
- `deletedWithoutChat` — set it only if your messenger reports a deletion without its chat. Without
  it, such a deletion tombstones nothing.
- `inviteLinks` — your invite links, for `chats moderate`.
- `groupSettings`, `adminRights`, `pickAdminRights`, `addsWithHistory`, `knowsAccountAge` — what your group
  commands can offer. `groupSettings` without `joinApproval`, `onlyAdminsSend`, `onlyAdminsEditInfo` or
  `disappearingSeconds` never offers them: they are not in the default list. Set `pickAdminRights: false` when
  every admin has every right; `admins add` then takes no `--can`.
- `savedChatId`, `partnerOf` — the notes-to-self chat, and the other person in a one-to-one chat.
- `quietPins`, `pinDurations`, `pinDefaultDuration`, `messageStars` — how pins work: `quietPins: false` when every
  pin tells the chat's members (each then counts toward the hourly limit, and `messages pin` takes no `--notify`);
  `pinDurations`, in seconds, when a pin ends by itself (`messages pin --expire-time`, passed to `pin` as
  `duration`); `pinDefaultDuration`, one of them, when a pin without `--expire-time` lasts that long — the help says
  so and `pin` is handed it; `messageStars: true` mounts `messages star` and `unstar` over `MessageStars`.
- `stickers`, `stickerFileBytes` — how a sticker is sent: `stickers: true` mounts `messages send --sticker <id>`
  for a sticker from a set (`stickers list`); `stickerFileBytes`, the largest file in bytes, mounts
  `messages send --sticker-file <file>` and the MCP `sticker_file` for a messenger whose sticker is an uploaded
  .webp. `send` then gets it as `stickerFile: { name, source }`, alone, read through the same file guard as
  `--file`.

## Required core and optional groups

`MessengerCore` is required: `self`, `me`, `resolve`, `chat`, `send`, `logout` and `close`. Every
other group is optional: `ServerReads`, `ChatReading`, `MessageEditing`,
`MessagePins`, `MessageStars`, `MessageReactions`, `ReadState`, `TopicReadState`, `MessagePolls`, `LiveUpdates`, `PassiveUpdates`, `PushedHistory`,
`MessageMedia`, `ScheduledMessages`, `GroupModeration`, `AccountTools`, `GroupAdmin`, `ChatFolders`, `ContactBook`
and `AccountEditing`.

- A command reaches an optional method through `capability()`. When your adapter does not have
  the method, the command fails with `validation_error` and "this messenger cannot …". It does not
  crash.
- `ServerReads` — `chats`, `history`, `around` and `contact` — is optional only for a messenger with
  `history: "store"`. With the default `"server"`, the shared reads call it, and an adapter without
  it gets "this messenger cannot list chats" on every read.
- With `history: "store"`, `resolve` and `people` see only what the store has no answer for: a chat or person named
  by a stored name never reaches them, and `watch` events get a missing `chatTitle` from the stored chats.
  Such an adapter needs no chat directory of its own to answer names. A stored chat named by its exact id still
  reaches `resolve`, and an answer under another id re-keys the stored chat to it, as a pushed `rekeys` entry would:
  answer another id only when the messenger now names that same chat by it.
- Prefer a whole group to part of one. Write `implements MessageEditing` on the class, so the
  compiler holds you to all of it. `ReadState` is `markRead` alone; `markTopicRead` is
  `TopicReadState`, for a messenger with forum topics.
- An adapter that needs what the store holds — WhatsApp addresses a message by its sender — reads it
  through `ConnectOptions.stored` in `connect`: `message(chatId, id)` and `newestIncoming(chatId, before?)`,
  over the command's own store handle. Optional `threadMessages(chatId, threadId, window)` reads a paged provider
  thread from that same store, scoped to the connected account. Never open a second one.
- `Attachment.providerRef` is yours alone: keep there what fetches the file again, keys included.
  No answer, live event or log prints it, and a later copy without it keeps the stored one.
- Set `readsComments: true` when the messenger can read stored comments but cannot send them. Keep
  `channelComments: false` to leave `messages send --comment-to` unavailable. When `readsComments` is unset,
  comment reads inherit the existing `channelComments` capability.
- An option your messenger cannot do is **refused with `validation_error`**. It is never dropped.
  For example, a messenger with no silent messages refuses `silent: true`.

## Ids

- Every id is a **string**: chats, messages, people, polls, folders. Never a number, not even inside
  the adapter's answers. Provider ids are often 64-bit, and a number loses digits.
- Shared code does not read an id. It does not check for digits and does no arithmetic. Your ids
  can have any shape, for example `123@s.whatsapp.net`.
- One exception: when `fetching.orderBy` is `"id"` (the default), `messages sync` and
  `messages download --all` key what they hold by the message id as a number. So either your message ids are whole numbers below 2^53, or you
  set `orderBy: "time"`. A contract case checks this.

## Send ids and an unknown outcome

Each `send` gets a `sendId`. It is the send's identity.

- Pass it to the messenger as the client's own message id, when the messenger has one. Then the
  server drops a repeat. `send` returns `{ message, sendId }` with the same `sendId`.
- When your messenger's own client makes a send id in a special form, implement `newSendId()`.
  MAX uses a millisecond timestamp, for example.
- When the request went out and no answer came back, throw `outcome_unknown`. Do not throw
  `network_error` or `timeout`, because they say the message did not go. After `outcome_unknown`,
  the person repeats the send with the same `sendId` and gets one message, not two.
- `forward` and `createPoll` take a `sendId` too, with the same rule.
- The message that `send`, `createPoll`, `forward` and `edit` return has the `chatId` the messenger answered with,
  in the form its live events carry. Do not echo the id you were given. cli-core saves the message, and creates
  its chat row with the typed chat's title, kind and privacy, under that id; an edited message stays in the row
  that holds it. When it differs from the id that was typed, the send journal records it as `resultChatId`. For
  example, WhatsApp answers a send to a re-keyed person's phone-form id with the LID chat; an echo of the
  phone-form id would create a second chat for the same person.

## Albums

`messages send` repeats `--photo` and `--file` (and its MCP tool takes a list for `photo` and `file`). More than
one attachment reaches `send` as `attachments`, photos first, then files, each in the order given: an album.

- Each photo or file counts as one send toward the hourly limit (`NEED-1660`). cli-core weighs it before `send` is
  called; the adapter does not count.
- An adapter whose messenger cannot send an album, or not this mix (a bot, a document beside a photo), throws
  `validation_error` before anything goes, saying what it can send. The refused attempt does not count.
- Send the album as one request under the send's `sendId`, so a repeat after `outcome_unknown` still makes one copy.
  Derive each item's own client id from the `sendId` where the messenger wants one per item.
- Return `message` as the first message of the album and `messages` as all of them, in order. cli-core saves each
  one and answers `messages send --json` with a `messages` list beside `message`. An adapter that leaves
  `messages` out still works; the answer then names the first message only.

## Errors

Throw a `CliError` from `@wirecat/cli-base` with a code from its closed list: `validation_error`,
`authentication_error`, `permission_error`, `not_found`, `rate_limited`, `timeout`,
`network_error`, `provider_error`, `provider_unavailable`, `invalid_response`, `outcome_unknown` and
the others in `errorCodes`.

- Translate every error from your library into one of these. A library error that crosses the
  adapter reaches the person as an unknown failure.
- An unknown chat or message is `not_found`. One exception: `resolve` may take a chat id it does not know as it
  is, a chat of kind `unknown` with that id and no title, so that a write the guard refuses never connects first.
- A name that matches more than one chat is `validation_error`, and lists the candidates. Use
  `pickChat` and `pickPerson`: they already do this.
- Shared code recognises an error by its name and code, not by its class. So a CLI with its own
  copy of cli-base still works.

## What never crosses the adapter

No type from your messenger's library goes above the adapter. Every answer is a domain type from
`.`, such as `Chat`, `Message` or `Page`. Put a field that only your messenger has into
`providerMetadata`. Never put a token or a phone number there.

The store merges a saved chat's `providerMetadata` into the one it holds, key by key. A key you leave out keeps its
stored value; a key set to `null` is removed. So leave a key out only when you do not know it, and send `null` when
it is gone or a flag turned false: `{ pinned: null }`, `{ username: null }`. `parentChatId` works the same way:
left out keeps the stored parent, `null` clears it. Every reader treats a `null` key as an absent one.

The same holds for `title`, `unreadCount`, `lastMessageAt` and `participantsCount` (the `ChatUpdate` that
`saveChats` and `HistoryBatch.chats` take): left out keeps the stored value, `null` stores none. So a push that knows
only part of a chat sends only that part, such as `{ id, kind, parentChatId: null }` for a group that left its
community. Send `null` only when the messenger says there is no value; a `null` sent for "not known" erases what the
store holds.

A chat's state on the phone follows it too. `muted`, `archived` and `markedUnread` left out keep the stored value.
`mutedUntil` is when a mute ends, in UTC: `muted: true` without it is for good, and `muted: false` clears it. A mute
whose end has passed reads as `muted: false`, with no write. Clear `markedUnread` yourself when the owner reads the
chat: a count of 0 does not, since a push may carry 0 for a chat that is marked unread. `inbox` leaves out muted and
archived chats unless they mention the owner, and takes in a chat marked unread, muted or not, with its newest
message from someone else.

`membershipState` follows the same rule: left out keeps it, a value sets it, `null` clears it. A chat marked left
stays left through a save that leaves membership out, such as a community notice. Any page of your adapter's `chats`
rejoins the chats it names, since the messenger lists only chats the account is in; a complete one also marks the
rest left. A client that saves its chat list itself calls `rejoinChats` with any part of it and `markChatsLeft`
with a complete one. An adapter that learns of a rejoin any other way, from a push or a lookup, such as the owner
added back to a group, sends `membershipState: "member"` with the chat: it takes off the "left" mark and keeps any
other state, such as "archived". `null` would clear that too. Leave `membershipState` out when the push does not say
whether the owner is in the chat. Your adapter's own `leave` and `join` need neither: after a `leave` that
succeeds, cli-core marks the chat left, and after a `join` that gets in, it takes the left mark off (`rejoinChats`,
so "archived" is kept). A chat marked left drops out of `chats list`; `chats show` and the stored reads of its
messages still find it, and an operation that acts on the live chat, such as `chats track`, refuses it.

## One socket per linked device

Some messengers allow one connection per linked device. A second one pushes the first one off.
WhatsApp over Baileys probably works like this; it has not been observed yet. For such a messenger, set
`Messenger.connection` to `"exclusive"`, and the shared package enforces the rest
([WC-LIFE-11](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/lifecycle.md#wc-life-11--run-commands-through-serve-when-the-messenger-allows-one-connection-per-account)):

- While `<cli> serve` holds the connection, it offers a relay on a private Unix socket. A command that reaches the
  messenger is sent there and runs on the held connection, with the client's environment, so the permissions and
  the read-only lock still hold (`src/cli/relay-route.ts`, `src/cli/messenger/serve-relay.ts`).
- Every command that connects does it through `connectFor` (`src/cli/messenger/context.ts`), your CLI's own
  commands included: a relayed run gets serve's adapter, and a run for another profile is refused. Never call
  `messenger.connect` from a command.
- With no live `serve`, the command connects on its own. `serve`, `server`, `bot`, logins, `--offline` and
  `mcp --http` are not relayed. There is no relay on Windows.

## History from the store

Some messengers push history to the client instead of answering a request for it. For them, set
`Messenger.history` to `"store"`. The default is `"server"`. The changelog says when it ships.

- With `"store"`, the shared services answer `chats`, `history`, `around` and `contact` from the
  local store. They do not call the adapter, so leave the `ServerReads` group out. Writes still
  connect.
- `messages sync` asks for older history, so it is refused — unless the messenger sets `historyOnDemand: true`:
  then `messages sync <chat>` (with `--last`, `--limit`, `--background`) reads that chat back through the adapter's
  `history(chat, { limit, before })`, a page at a time, at most `fetching.maxPageSize` a request. `--all` stays
  refused: there is no chat list to walk. An adapter whose phone or server does not answer throws `timeout`, not an
  empty page — an empty page means the chat's start.
- A messenger that reports a chat's unread count only now and then — a history push, a read on the phone — sets
  `unreadCounts: "store"`. Then each message from someone else that `watch` or `listen` saves for the first time, and
  that was sent after the count was taken, adds one to the chat's stored count. The count is taken as of the
  `lastMessageAt` that comes with it, or as of the save when none does. A chat never given a count is not counted, and
  `chats read` of the whole chat stores 0. A pushed batch adds nothing: send its count with its chats.
- A group's member list is still a server read. When the adapter has `members`, `chats members list`, `fetch`
  and `audit` connect and ask it; only `--offline` refuses `fetch` and `audit`, and `list` then reads the stored
  members. Without `members`, `list` reads the stored members and `fetch` and `audit` say the messenger cannot.
- Give the adapter the `PushedHistory` group. `feed(onBatch, signal)` hands over what the messenger
  pushes, as `HistoryBatch` objects: `{ chats?, people?, messages?, votes?, reactions?, stars?, deletions?, events? }`, any of them, for any chats. It
  ends when `signal` aborts.
- A vote in `votes` is `{ chatId, messageId, vote: { person, answers, votedAt } }` (`HistoryVote`): the poll
  message's chat and id, and the vote as `PollVoteEvent` carries it. `votedAt` is when the person voted, not when the
  push came: a voter's older vote never replaces a newer one, so a push dated now would hide a later change. No
  `answers` is a take-back. Send pushed votes here, not as `watch` events: only `serve`, `watch` and `listen` keep
  those.
- A reaction in `reactions` is `{ chatId, messageId, reaction: { person, own, reaction, reactedAt } }`
  (`HistoryReaction`): one person's reaction to the message, for a messenger that sends a reaction change at a time
  instead of totals. `reaction` is the emoji, or `null` when they took it back; `own` marks the owner's, which becomes
  `Reactions.mine`; `reactedAt` is when the person reacted, not when the push came, since a person's older reaction
  never replaces a newer one. A live one comes from `watch` as `{ event: "person_reaction", chatId, chatTitle,
  messageId, reaction }` (`PersonReactionEvent`). The store keeps each person's newest and writes the message's
  `reactions` as their totals, whenever the message is held — also when the reaction came first. Once a message has
  such rows, totals from the message itself or a `reaction` event no longer replace them; leave `Message.reactions`
  `null` on such a messenger.
- A star in `stars` is `{ chatId, messageId, starred }` (`HistoryStar`): the owner starred the message, or took the
  star off. A pushed message may carry `starred` itself instead; leave it out unless the messenger says, since an
  absent `starred` keeps what the store holds. A live one comes from `watch` as `{ event: "star", chatId, chatTitle,
  messageId, starred }` (`MessageStarEvent`). The same star twice is kept once; with no time on a star, the last one
  saved wins. `messages list <chat> starred:true` and `search messages is:starred` then read them.
- A deletion in `deletions` is `{ chatId, messageId }`: a tombstone from a synced snapshot. It applies after the
  batch's messages, only within the named chat. An older replay cannot restore the deleted content. Send these
  through history rather than presenting old deletions as new `watch` events.
- How far the owner's own message got in a one-to-one chat is `Message.delivery`: `delivered`, or `read` once the
  other person opened it. A pushed message carries it when the messenger says; leave it out otherwise, since an absent
  `delivery` keeps what the store holds. A live receipt comes from `watch` (and `listen`) as `{ event: "delivery",
  chatId, chatTitle, messageId, delivery, at }` (`MessageDeliveryEvent`), one per message. The store keeps it only on
  the owner's own message, and never moves it back: a late `delivered` after `read` changes nothing. A group's
  receipts arrive per person; the shared model has no field for them, so send none.
- A chat event in `events` is `{ chatId, change }` (`HistoryChatEvent`), `change` a `ChatEvent`: who joined, left, was
  added, removed, promoted or demoted, or a new title. A live one comes from `watch` as `{ event: "chat_event",
  chatId, chatTitle, change }` (`ChatEventNotice`). `change.messageId` names the event: the same event must always
  carry the same id, from the push and from `watch` alike, so that each is kept once. `chats events` then answers
  from the store, so the adapter needs no `chatEvents`.
- `serve` and `watch` run `feed` beside `watch`, on the same connection, and save each batch to the
  store. Chats are saved first, then people, then messages. A chat's votes, reactions and stars are saved in the same
  transaction as its messages, after them, so a message in the batch is held before them. Batches are saved in the order they come.
- A push names some chats, never all of them, so a chat left out of a batch is not marked as left.
  A pushed message does not lift a deletion the store already holds: the push may be older than it.
- A batch the store cannot take is a warning on stderr. It does not stop `serve`. A `feed` that
  rejects stops `serve` and `watch` with its error.
- New messages still come through `watch`, not through `feed`.
- When a stored chat can move to a new id that only your engine learns, give `PushedHistory` `storedChats(ids)` too.
  `serve` and `watch` call it once as `feed` starts, with every chat id the store holds for this account and no
  other's; a chat marked left is not in it. A second argument, `recipients`, is given when the profile's recipient
  list names chat or partner ids the store does not hold. They are ids the owner typed: map them from local data only,
  with no network lookup and no recording, and send a `rekeys` entry for each one you can map, so the entry moves.
  Ids only, never messages, in one call
  ([measured](https://github.com/WireCatLabs/cli-testing/tree/main/performance/store/stored-chat-ids)). Pick the ones
  to move and send each later as a batch's `rekeys` (`{ from, to }`), which the store already applies. One-shot
  commands and a connection lent by `serve` never call it. A reject is a `stored_chats_failed` warning; `feed` goes on.
  A call still running at exit is abandoned after the 5 s save wait, with the same warning.
- Give the adapter `PassiveUpdates` when the messenger delivers, on any connection, what it queued while nothing was
  connected, and cannot deliver it again. `listen(onEvent, signal)` hands on the same `MessageEvent`s as `watch`, from
  a connection opened without `{ listen: true }`, until `signal` aborts. It only listens: it must not connect or wait
  for the connection, since it starts as soon as the command has connected. Resolve once nothing more will be handed
  on. A command that does not watch (`messages send`, `doctor --online`, an MCP session) then saves those events to
  the store. A connection opened with `{ listen: true }` is never asked to `listen`: its `watch` saves them, and a
  command serve runs for a client borrows a connection without `listen`.
- When the messenger also pushes history to any connection once, give `PassiveUpdates` `listenHistory(onBatch,
  signal)` too. It hands on the same `HistoryBatch`es as `feed`, re-keys included, under the same rules as `listen`:
  only on a connection opened without `{ listen: true }`, never connecting or waiting for the connection, resolving
  once nothing more will be handed on after `signal` aborts. Each batch is saved as `feed`'s is. A connection that
  watches leaves it to `feed`, and a borrowed connection has no `listenHistory`. A logout or close that ends the
  connection must end `listenHistory` without an error, as it ends `listen`, or the command warns `listen_failed`.

## Running the contract cases

The `./testing` export has the kit. **It is not on the stable list yet**, so it can change in any
release ([README, "How often, and what may break"](../REFERENCE.md#how-often-and-what-may-break)).

- `contractSeed({ ids })` — a fixed set of chats, people and messages: a busy group with ten
  messages, a one-to-one chat, and two groups with the same title.
- `contractCases({ connect, ids, orderBy, history })` — the cases. `connect` gets the seed and returns a
  fresh adapter over **your own fake client**, filled from that seed. Each case calls it once and
  closes the adapter after.
- `fakeAdapter(seed)` — an adapter in memory that passes every case. Use it in command tests, or
  read it as an example. `fakeAdapter(seed, { feed: true })` also has `feed`: it pushes the seed's
  chats and people in one batch, then each chat's messages in a batch of their own.
- The `feed` case runs only when the adapter has `feed`. It checks that a batch arrives, that it
  holds only the seed's chats and messages with ids as strings, and that `feed` ends on abort.
- The `listen` cases run only when the adapter has `listen`. They check that `listen` on a signal already
  aborted resolves at once and does not reject, and that otherwise it keeps listening until the signal aborts and
  then resolves. They cannot see whether it connects; test that yourself. `fakeAdapter(seed, { listen: true })`
  also has `listen`.
- The `listenHistory` cases check the same of `listenHistory`, and run only when the adapter has it.
  `fakeAdapter(seed, { listenHistory: true })` has it: it hands on what its `feed` pushes.
- The `storedChats` case runs only when the adapter has `storedChats`. It checks that no ids, and the seed's ids with
  one it does not know, each resolve without rejecting. `fakeAdapter(seed, { storedChats: true })` has it.

Each case checks with `node:assert/strict`, so the kit does not depend on a test runner. Under
vitest, with `fakeAdapter` where your adapter over your own fake client goes:

```ts
import { contractCases, digitIds, fakeAdapter } from "@wirecat/cli-core/testing"
import { describe, it } from "vitest"

describe("the adapter keeps the port's promises", () => {
  for (const one of contractCases({ connect: (seed) => fakeAdapter(seed), ids: digitIds }))
    it(one.name, async (context) => {
      const result = await one.run()
      if (result) context.skip(result.skipped)
    })
})
```

- `ids` — how the seed names things. The default, `wordIds`, makes ids that are not digits.
  `digitIds` makes small whole numbers. When your messenger's ids have a shape of their own, pass an
  `IdMaker`; it gets the kind, a number, and the message's time.
- `orderBy` — the same value as your `fetching.orderBy`. With `"time"`, the cases page `history` by
  the oldest message's ISO time, not by its id.
- `history` — the same value as your `Messenger.history`. With `"server"`, the default, one case
  fails unless the adapter has every `ServerReads` method.
- A case for an optional method returns `{ skipped }` when your adapter does not have the method.
  The `ServerReads` cases go together: they are skipped when any of the four is missing.
- A case with `needs` asks more of your fake than holding the seed. For example, "a repeated send id
  leaves one message" needs a fake that drops a repeat, as the real server does.
- No case talks to a live service.

`close` is the one promise the cases cannot check. Test it yourself: after `close`, nothing keeps
the process alive.

A command test of a `history: "store"` messenger closes its connection the way a real run does: it
waits up to 5 s for a passive listen that does not end, and paces chat re-keys with real pauses. Shorten
both in the environment the test hands to `run()`, next to `keyring`:

```ts
await run(argv, definition, {
  env,
  keyring: memoryKeyring(),
  closeWaitMs: 10,
  rekeyPacing: { lockMs: 1000, pauseMs: 0 },
})
```

- `closeWaitMs` — how long the close waits on saves and passive listens before it gives them up with a warning.
- `rekeyPacing.lockMs` — how long one pass of re-keys may hold the store's write lock. A pass always does at least
  one re-key, so `0` means one re-key per transaction: hundreds of re-keys then outlast a short `closeWaitMs`, and
  the ones still queued are given up with `rekeys_not_applied`. Keep it long, as above.
- `rekeyPacing.pauseMs` — the pause between two passes. `0` takes the wait out.

A listen that hangs still warns `store_not_written`, only sooner. No flag, variable or MCP call sets them.

### MCP discovery and permissions

A permission changes what an agent may execute, not whether the command exists. CLI help and
`commands --json` retain the command catalogue. With a named profile, CLI help, text discovery,
`commands --json` and `commands info` also show current availability. Without a named profile,
discovery stays independent of account settings; help still works if settings need repair. MCP `tools_search` returns denied commands with
`availability: { available: false, reason, permission }`; permitted commands have
`availability: { available: true }`. Both complete listings and search results include this field.
Availability is read from current settings, and execution checks permissions again before opening a
connection or changing anything. A command being listed grants no permission to run it.

The shared MCP servers request `toolsFromCommands` with `includeUnavailable: true`. Existing callers
that use the helper as a filtered execution list can keep its default behavior; the public discovery
surfaces always include blocked commands.

Bot MCP includes `config show|set|unset` in the bot's scope. It omits the arguments that could select
personal or default settings, and supplies `--bot` internally. Changing limits requires
`mcp.authority`; the agent still cannot turn that key or `bot.api` on for itself. Commands requiring
an interactive terminal or an unbounded process keep their transport exclusions.

### Testing `mcp` over stdin and stdout

`mcpOverStdio(start)` drives your CLI's `mcp` the way an agent's client does, through your own
`run()`, with no child process. `start` gets two streams to pass to `run`; the helper answers
`initialize` first, and `close()` ends stdin and resolves with the exit code:

```ts
import { mcpOverStdio } from "@wirecat/cli-core/testing"

const mcp = await mcpOverStdio((streams) => run(["agent", "mcp"], { streams: captureStreams(), tty: false, ...streams }))
const { isError, body } = await mcp.call("wa_write", { command: "messages delete", arguments: { chat, messages } })
expect(await mcp.close()).toBe(0)
```

`mcp.request(method, params)` sends any other request; `mcp.tools()` lists the tool names. When
`run()` ends before an answer, the waiting call fails at once.
