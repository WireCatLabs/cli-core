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
| `@wirecat/cli-core/testing` | the messenger contract kit: `contractSeed`, `contractCases`, `fakeAdapter` |
| `@wirecat/cli-core/meetings` | `MeetingSource` and `MeetingStore`, for a meeting provider ([MEETING-PROVIDERS.md](MEETING-PROVIDERS.md)) |
| `@wirecat/cli-core/meetings/testing` | the meeting contract kit: `meetingStoreContract`, `fakeMeetingSource`, `memoryMeetingStore` |
| `@wirecat/cli-core/files` | native ordinary-file identity checks and directory syncing |
| `@wirecat/cli-core/speech/wav` | bounded PCM16 WAV preflight and 16 kHz streaming, without loading a speech model |
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
- `groupSettings`, `adminRights`, `addsWithHistory`, `knowsAccountAge` — what your group commands
  can offer.
- `savedChatId`, `partnerOf` — the notes-to-self chat, and the other person in a one-to-one chat.

## Required core and optional groups

`MessengerCore` is required: `self`, `me`, `resolve`, `chat`, `send`, `logout` and `close`. Every
other group is optional: `ServerReads`, `ChatReading`, `MessageEditing`,
`MessagePins`, `MessageReactions`, `ReadState`, `MessagePolls`, `LiveUpdates`, `PushedHistory`,
`MessageMedia`, `ScheduledMessages`, `GroupModeration`, `AccountTools`, `GroupAdmin`, `ChatFolders`, `ContactBook`
and `AccountEditing`.

- A command reaches an optional method through `capability()`. When your adapter does not have
  the method, the command fails with `validation_error` and "this messenger cannot …". It does not
  crash.
- `ServerReads` — `chats`, `history`, `around` and `contact` — is optional only for a messenger with
  `history: "store"`. With the default `"server"`, the shared reads call it, and an adapter without
  it gets "this messenger cannot list chats" on every read.
- Prefer a whole group to part of one. Write `implements MessageEditing` on the class, so the
  compiler holds you to all of it.
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

## One socket per linked device

Some messengers allow one connection per linked device. A second one pushes the first one off.
WhatsApp over Baileys probably works like this; it has not been observed yet. For such a messenger:

- A one-shot command must not open its own connection while `<cli> serve` holds one.
- Reads come from the local store. Writes go through the process that holds the connection, as
  max-cli's commands go through `max serve`.

This is the adapter's work. The shared package does not enforce it.

## History from the store

Some messengers push history to the client instead of answering a request for it. For them, set
`Messenger.history` to `"store"`. The default is `"server"`. The changelog says when it ships.

- With `"store"`, the shared services answer `chats`, `history`, `around` and `contact` from the
  local store. They do not call the adapter, so leave the `ServerReads` group out. Writes still
  connect.
- Give the adapter the `PushedHistory` group. `feed(onBatch, signal)` hands over what the messenger
  pushes, as `HistoryBatch` objects: `{ chats?, people?, messages? }`, any of them, for any chats. It
  ends when `signal` aborts.
- `serve` and `watch` run `feed` beside `watch`, on the same connection, and save each batch to the
  store. Chats are saved first, then people, then messages. Batches are saved in the order they come.
- A push names some chats, never all of them, so a chat left out of a batch is not marked as left.
  A pushed message does not lift a deletion the store already holds: the push may be older than it.
- A batch the store cannot take is a warning on stderr. It does not stop `serve`. A `feed` that
  rejects stops `serve` and `watch` with its error.
- New messages still come through `watch`, not through `feed`.

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

Each case checks with `node:assert/strict`, so the kit does not depend on a test runner. Under
vitest:

```ts
import { contractCases, digitIds } from "@wirecat/cli-core/testing"
import { describe, it } from "vitest"

describe("the adapter keeps the port's promises", () => {
  for (const one of contractCases({ connect: (seed) => adapterOver(fakeClient(seed)), ids: digitIds }))
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
