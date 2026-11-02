import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatKind, Message } from "../domain/models.js"
import { type AccountKey, historyStartKey, type MessageStore, openStore } from "../store/store.js"

export const NOW = Date.parse("2026-11-02T10:00:00.000Z")
/** The day the owner first asked for the money. */
export const D = "2026-10-19"
export const CLIENT = { provider: "max", account: "11" }
export const CONTRACTOR = { provider: "telegram", account: "22" }

const at = (date: string, time = "09:00") => `${date}T${time}:00.000Z`

export interface Said {
  id: number
  at: string
  from: "me" | string
  text: string
  sender?: string
  extra?: Partial<Message>
}

export const said = (chatId: string, { id, at: when, from, text, sender, extra }: Said): Message => ({
  id: String(id),
  chatId,
  senderId: from === "me" ? "1" : (sender ?? from.toLowerCase()),
  senderName: from === "me" ? "Owner" : from,
  timestamp: when,
  editedAt: null,
  text,
  outgoing: from === "me",
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

export interface FixtureChat {
  account: AccountKey
  id: string
  title: string
  kind: ChatKind
  role?: string
  /** Held from its first message; otherwise only part of it is held. */
  whole: boolean
  messages: Said[]
}

/** The chats of HRB, a fake harbour site project: a client group, a client dialog, a contractor and a leads group. */
export const HARBOUR: FixtureChat[] = [
  {
    account: CLIENT,
    id: "-900",
    title: "Harbour group",
    kind: "group",
    role: "client",
    whole: true,
    messages: [
      { id: 1, at: at("2026-10-12"), from: "Ana", sender: "31", text: "Что с интеграцией 1C? Ждём новостей" },
      { id: 2, at: at("2026-10-14"), from: "me", text: "1C подключим, как только закроем счёт" },
      { id: 3, at: at(D), from: "me", text: "Напоминаю: оплатите, пожалуйста, счёт на 1 200 € за сентябрь" },
      { id: 4, at: at("2026-10-20"), from: "Kai", sender: "40", text: "Привет всем, макет почти готов" },
      { id: 5, at: at("2026-10-26", "08:00"), from: "me", text: "Повторно: счёт 1 200 € ждёт оплаты" },
      {
        id: 6,
        at: at("2026-10-26", "15:02"),
        from: "Ana",
        sender: "31",
        text: "Kai, ты посмотришь макет до пятницы",
        extra: { mentions: ["40"] },
      },
    ],
  },
  {
    account: CLIENT,
    id: "501",
    title: "Ana",
    kind: "dialog",
    role: "client",
    whole: true,
    messages: [
      { id: 1, at: at("2026-10-17"), from: "Ana", sender: "31", text: "Пришлите договор, пожалуйста" },
      { id: 2, at: at("2026-10-18"), from: "me", text: "Ана, договор у вас на почте, жду подписи" },
    ],
  },
  {
    account: CONTRACTOR,
    id: "555",
    title: "Lev",
    kind: "dialog",
    role: "contractor",
    whole: false,
    messages: [
      { id: 10, at: at("2026-10-20"), from: "me", text: "Лев, как там отчёт за сентябрь?" },
      { id: 11, at: at("2026-10-21"), from: "Lev", sender: "77", text: "Пришлю отчёт завтра" },
      { id: 12, at: at("2026-10-28"), from: "Lev", sender: "77", text: "Отчёт готов. Когда оплата 300 €?" },
    ],
  },
  {
    account: CLIENT,
    id: "-950",
    title: "Leads",
    kind: "group",
    whole: true,
    messages: [{ id: 1, at: at("2026-11-01"), from: "Visitor", sender: "88", text: "Хочу заказать сайт" }],
  },
]

export const openTestStore = async (): Promise<MessageStore> =>
  openStore({ path: join(mkdtempSync(join(tmpdir(), "project-status-")), "m.db") })

export const seedChat = async (store: MessageStore, chat: FixtureChat, project: string) => {
  const messages = chat.messages.map((one) => said(chat.id, one))
  await store.chats.saveChats(chat.account, [
    {
      id: chat.id,
      title: chat.title,
      kind: chat.kind,
      unreadCount: 0,
      lastMessageAt: messages.at(-1)?.timestamp ?? null,
      participantsCount: chat.kind === "dialog" ? 2 : 5,
    },
  ])
  await store.messages.saveMessages(chat.account, chat.id, messages, { via: "test" })
  const ids = chat.messages.map((one) => one.id)
  await store.sync.markRange(chat.account, chat.id, Math.min(...ids), Math.max(...ids))
  if (chat.whole) await store.sync.setSyncState(chat.account, historyStartKey(chat.id), String(Math.min(...ids)))
  await store.knowledge.relate(null, {
    from: `chat:${chat.account.provider}/${chat.account.account}/${chat.id}`,
    to: project,
    kind: "member-of",
    confirmed: true,
    ...(chat.role ? { role: chat.role } : {}),
  })
}

/** A store holding HRB and its four chats; every name and number in it is made up. */
export const harbourStore = async (chats: FixtureChat[] = HARBOUR) => {
  const store = await openTestStore()
  const project = await store.knowledge.addProject({ name: "Harbour site", key: "HRB" })
  for (const chat of chats) await seedChat(store, chat, project.ref)
  return { store, project: project.ref }
}
