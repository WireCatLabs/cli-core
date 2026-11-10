import type { Account, Chat, Contact, Id, Member, Message } from "../domain/models.js"
import { SEED_PEOPLE } from "../domain/test-data.js"

/** What the shared cases read. An adapter's test puts it into its own fake, by whatever that fake takes. */
export interface Seed {
  /** `null` is a profile that never logged in. */
  account: Account | null
  people: Contact[]
  /** Newest activity first, as `chats` lists them. */
  chats: Chat[]
  /** Who is in each chat, by chat id. */
  members: Record<Id, Member[]>
  /** Every chat's messages, each chat's oldest first. */
  messages: Message[]
  /** A group with more messages than three pages of `BUSY_PAGE`. */
  busy: Id
  /** A one-to-one chat with `person`. */
  dialog: Id
  person: Id
  /** A title two groups share, so a chat named by it is ambiguous. */
  twins: string
}

export type IdKind = "chat" | "message" | "person"

/** An id for the `n`th thing of a kind; `time` is when a message was sent, for a messenger whose ids carry it. */
export type IdMaker = (kind: IdKind, n: number, time: Date) => Id

export const BUSY_PAGE = 3
const BUSY_MESSAGES = 10

/** Ids that are not numbers, so no code may take them for one. */
export const wordIds: IdMaker = (kind, n) => `${kind}-${n}`

/** Whole numbers within 2^53, for a messenger whose store pages by id. */
export const digitIds: IdMaker = (kind, n) => String({ person: 100, chat: 200, message: 1000 }[kind] + n)

const START = Date.parse("2026-09-01T09:00:00.000Z")

/**
 * The fixed world the cases expect: the owner, two people, a busy group, a one-to-one chat and two
 * groups with one title. `ids` names everything, so a messenger whose ids have a shape of their own
 * can seed its fake with them.
 */
export const contractSeed = ({ ids = wordIds, loggedIn = true }: { ids?: IdMaker; loggedIn?: boolean } = {}): Seed => {
  const at = (minute: number) => new Date(START + minute * 60_000)
  const [owner, ann, bob] = SEED_PEOPLE.map(
    ({ name, username }, index): Contact => ({
      id: ids("person", index + 1, at(0)),
      name,
      username,
      description: null,
      lastMessagedAt: null,
    }),
  ) as [Contact, Contact, Contact]

  let messageNumber = 0
  const message = (chatId: Id, minute: number, from: Contact, text: string): Message => {
    messageNumber += 1
    return {
      id: ids("message", messageNumber, at(minute)),
      chatId,
      senderId: from.id,
      senderName: from.name,
      timestamp: at(minute).toISOString(),
      editedAt: null,
      text,
      outgoing: from.id === owner.id,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    }
  }
  const group = (n: number, title: string, minute: number): Chat => ({
    id: ids("chat", n, at(0)),
    title,
    kind: "group",
    unreadCount: 0,
    lastMessageAt: at(minute).toISOString(),
    participantsCount: 3,
  })

  const busy = group(1, "Book club", 40)
  const dialog: Chat = {
    ...group(2, "Ann Lee", 30),
    kind: "dialog",
    participantsCount: 2,
    unreadCount: 1,
  }
  const twinA = group(3, "Twins", 20)
  const twinB = group(4, "Twins", 10)

  const messages = [
    ...[twinB, twinA].map((chat, index) => message(chat.id, 10 * (index + 1), bob, `hello from ${chat.title}`)),
    message(dialog.id, 29, owner, "are you coming?"),
    message(dialog.id, 30, ann, "yes"),
    ...Array.from({ length: BUSY_MESSAGES }, (_, index) =>
      message(busy.id, 31 + index, [owner, ann, bob][index % 3] as Contact, `chapter ${index + 1}`),
    ),
  ]
  const everyone = [owner, ann, bob].map(({ id, name, username }) => ({ id, name, username }))

  return {
    account: loggedIn ? { id: owner.id, name: owner.name, username: owner.username } : null,
    people: [{ ...ann, lastMessagedAt: dialog.lastMessageAt }, bob],
    chats: [busy, dialog, twinA, twinB],
    members: {
      [busy.id]: everyone,
      [dialog.id]: everyone.slice(0, 2),
      [twinA.id]: everyone,
      [twinB.id]: everyone,
    },
    messages,
    busy: busy.id,
    dialog: dialog.id,
    person: ann.id,
    twins: "Twins",
  }
}
