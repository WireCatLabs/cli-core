// Phase 4 item 5, by hand: a real agent links the IRC dev split through the same service as
// `conversations batches next` and `links add`, and the result is scored against the rules alone.
//
//   agent.ts prepare <split>                  one store per file under $DISENTANGLE_DATA/agent/<split>/
//   agent.ts status <split> <file>            what is left, as `batches status`
//   agent.ts next <split> <file> <size>       one batch as JSON, or null, as `batches next`
//   agent.ts add <split> <file> <batch>       the answer on stdin, as `links add`
//   agent.ts score <split>                    writes rules and agent graphs and clusters for run.sh's scorers
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Messenger } from "../../src/cli/messenger/context.ts"
import type { Message } from "../../src/domain/models.ts"
import type { SendGuard } from "../../src/sends/guard.ts"
import { parse } from "./corpus.ts"

const { linkMessages } = await import("../../dist/conversations/link.js")
const { conversationsService } = await import("../../dist/services/conversations.js")
const { storedDeps } = await import("../../dist/services/deps.js")
const { openStore } = await import("../../dist/store/index.js")

const data = process.env.DISENTANGLE_DATA
if (!data) throw new Error("set DISENTANGLE_DATA to a clone of irc-disentanglement (run.sh does it)")
const [action, split = "dev", file, arg] = process.argv.slice(2)

const FIRST_ANNOTATED = 1000
// The agent reads from here: 100 lines of context before the annotated ones, not the 1,000 the corpus has.
const FIRST_LOADED = 900
const account = { provider: "irc", account: "bench" }
const CHAT = "1"

const files = () =>
  readdirSync(join(data, "data", split))
    .filter((name) => name.endsWith(".ascii.txt"))
    .sort()
    .map((name) => name.replace(".ascii.txt", ""))
const loaded = (name: string) =>
  parse(name, readFileSync(join(data, "data", split, `${name}.ascii.txt`), "utf8")).filter(
    ({ id }) => Number(id) >= FIRST_LOADED,
  )
const dbOf = (name: string) => join(data, "agent", split, `${name}.db`)

const service = async (name: string) => {
  const store = await openStore({ path: dbOf(name) })
  const conversations = conversationsService(
    storedDeps({ provider: "irc", app: { command: "irc" } } as Messenger, store, account, {} as SendGuard),
  )
  return { store, conversations }
}

const toMessage = ({ id, senderId, text, timestamp }: ReturnType<typeof loaded>[number]): Message => ({
  id,
  chatId: CHAT,
  senderId,
  senderName: senderId,
  ...(senderId ? { senderUsername: senderId } : {}),
  timestamp,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const write = (out: string, variant: string, parentsPerFile: [string, Map<string, string | null>][]) => {
  const graphs: string[] = []
  const clusters: string[] = []
  for (const [name, parents] of parentsPerFile) {
    const conversation = new Map<string, string>()
    for (const [id, parent] of parents) {
      conversation.set(id, parent === null ? id : (conversation.get(parent) ?? id))
      if (Number(id) >= FIRST_ANNOTATED) graphs.push(`${name}:${id} ${parent ?? id} -`)
    }
    const groups = new Map<string, string[]>()
    for (const [id, root] of conversation) if (Number(id) >= FIRST_ANNOTATED) groups.set(root, [...(groups.get(root) ?? []), id])
    for (const ids of groups.values()) clusters.push(`${name}:${ids.join(" ")}`)
  }
  writeFileSync(join(out, `${variant}.graphs.txt`), `${graphs.join("\n")}\n`)
  writeFileSync(join(out, `${variant}.clusters.txt`), `${clusters.join("\n")}\n`)
}

if (action === "prepare") {
  mkdirSync(join(data, "agent", split), { recursive: true })
  for (const name of files()) {
    const { store, conversations } = await service(name)
    await store.chats.saveChats(account, [
      { id: CHAT, title: name, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(account, CHAT, loaded(name).map(toMessage), { via: "history" })
    await conversations.build(CHAT)
    console.log(name, JSON.stringify(await conversations.batchStatus(CHAT, 50)))
    await store.close()
  }
} else if (action === "status" || action === "next" || action === "add") {
  if (!file) throw new Error("name the file")
  const { store, conversations } = await service(file)
  if (action === "status") console.log(JSON.stringify(await conversations.batchStatus(CHAT, Number(arg ?? 50))))
  if (action === "next") console.log(JSON.stringify((await conversations.nextBatch(CHAT, Number(arg ?? 50))) ?? null))
  if (action === "add") {
    if (!arg) throw new Error("name the batch")
    // readFileSync(0) throws EAGAIN when stdin is a non-blocking pipe.
    let input = ""
    for await (const chunk of process.stdin) input += chunk
    console.log(JSON.stringify(await conversations.addAnswers(arg, JSON.parse(input))))
  }
  await store.close()
} else if (action === "score") {
  const out = join(data, "out", `${split}-agent`)
  mkdirSync(out, { recursive: true })
  const rules: [string, Map<string, string | null>][] = []
  const agent: [string, Map<string, string | null>][] = []
  let answered = 0
  for (const name of files()) {
    const messages = loaded(name)
    const handles = new Map(
      messages.flatMap(({ senderId }) => (senderId ? [[senderId.toLowerCase(), senderId] as const] : [])),
    )
    const db = new DatabaseSync(dbOf(name), { readOnly: true })
    const rows = db
      .prepare(`SELECT m.native_id AS id, p.native_id AS parent FROM message_links l
        JOIN messages m ON m.pk = l.message_pk LEFT JOIN messages p ON p.pk = l.parent_pk
        WHERE l.source = 'agent' AND l.stale_at IS NULL`)
      .all() as { id: string; parent: string | null }[]
    db.close()
    answered += rows.length
    const answers = new Map(rows.map(({ id, parent }) => [id, parent]))
    rules.push([name, linkMessages(messages, { handles }).parents])
    agent.push([name, linkMessages(messages, { handles, answers }).parents])
  }
  write(out, "rules", rules)
  write(out, "agent", agent)
  console.error(`${answered} agent answers; scores in ${out}`)
}
