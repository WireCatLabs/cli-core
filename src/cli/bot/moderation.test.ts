import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { beforeEach, describe, expect, it } from "vitest"
import type { GroupMember, Message } from "../../domain/models.js"
import { ModerationRules, moderationPathFor } from "../../moderation/rules.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { botCommand } from "./command.js"
import { botCopy } from "./copy.js"
import type { BotAdapter, BotMessenger } from "./port.js"
import { botFiles, ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)

let root: string
let env: NodeJS.ProcessEnv
let keyring: ReturnType<typeof memoryKeyring>
let calls: string[]
let joins: GroupMember[] | undefined
let now: number

const invite = (id: string, at: number): Message => ({
  id,
  chatId: "-100",
  senderId: "42",
  senderName: "Spammer",
  timestamp: new Date(at).toISOString(),
  editedAt: null,
  text: "join https://max.ru/join/other",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const adapterFor = ({ history = true } = {}): BotAdapter => ({
  me: async () => ({ id: "900", name: "Helper", username: "helper_bot" }),
  close: async () => {},
  ...(history
    ? {
        historySince: async (chat: string, since: number) => {
          calls.push(`history ${chat} ${since > 0}`)
          return { messages: [invite("2", now - 600_000)], more: false }
        },
      }
    : {}),
  admins: async () => [],
  delete: async (chat, ids) => {
    calls.push(`delete ${chat} ${ids.join(",")}`)
  },
  removeMember: async (chat, person, { block }) => {
    calls.push(`remove ${chat} ${person}${block ? " block" : ""}`)
  },
})

let adapter: BotAdapter

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  resolveSettings: config.resolveSettings,
  connect: async () => adapter,
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
  joinsSince: () => joins,
}

const call = async (argv: string[], answer?: (question: string) => string) => {
  const streams = captureStreams()
  const code = await run(
    ["sales", "bot", "chats", ...argv],
    { app, commands: () => [botCommand(bot)] },
    { streams, tty: false, env, ...(answer ? { answer } : {}) },
  )
  const out = streams.stdout.join("\n")
  return { code, answer: out ? JSON.parse(out) : undefined, stderr: streams.stderr.join("\n") }
}
const rules = () => new ModerationRules(moderationPathFor(app, "sales", env))
const rows = (answer: { item: { rows: { rule: string; action: string; outcome: string }[] } }) => answer.item.rows

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-moderate-"))
  env = {
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "store.db"),
  }
  keyring = memoryKeyring()
  calls = []
  joins = []
  now = Date.now()
  adapter = adapterFor()
  new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring }).write("token")
  new ChatRegistry(app, "sales", env).observe([{ id: "-100", title: "Team", kind: "group" }])
})

describe("bot chats moderate", () => {
  it("**with no rules, only reports**, and says where joins come from", async () => {
    joins = undefined
    const { code, answer, stderr } = await call(["moderate", "Team", "--json"])

    expect(code).toBe(0)
    expect(rows(answer)).toEqual([expect.objectContaining({ rule: "invites", action: "report", outcome: "reported" })])
    expect(stderr).toContain("no rules yet")
    expect(stderr).toContain("chat sales bot watch")
    expect(calls).toEqual(["history -100 true"])
  })

  it("**removes what a rule allows, banning unless --no-block**", async () => {
    rules().set("-100", null, "invites", "remove")
    rules().set("-100", null, "consent.remove", "allow")
    const since = new Date(now - 3_600_000).toISOString()

    await call(["moderate", "-100", "--since-time", since, "--json"])
    await call(["moderate", "-100", "--since-time", since, "--no-block", "--json"])

    expect(calls.filter((one) => one.startsWith("remove"))).toEqual(["remove -100 42 block", "remove -100 42"])
  })

  it("**deletes at level ask only with --allow-dangerous**, or with an in-process answer under --json", async () => {
    rules().set("-100", null, "invites", "delete")

    expect(rows((await call(["moderate", "-100", "--json"])).answer)[0]).toMatchObject({ outcome: "planned" })
    expect(calls.filter((one) => one.startsWith("delete"))).toEqual([])
    expect(
      rows((await call(["moderate", "-100", "--allow-dangerous", "--since-time", "2h", "--json"])).answer)[0],
    ).toMatchObject({
      outcome: "done",
    })
    expect(rows((await call(["moderate", "-100", "--since-time", "2h", "--json"], () => "y")).answer)[0]).toMatchObject(
      {
        outcome: "done",
      },
    )
    expect(calls.filter((one) => one.startsWith("delete"))).toEqual(["delete -100 2", "delete -100 2"])
  })

  it("acts no more than --max-actions times, and names the bot's own command for the rest", async () => {
    rules().set("-100", null, "invites", "delete")

    const { answer } = await call(["moderate", "-100", "--allow-dangerous", "--max-actions", "0", "--json"])

    expect(rows(answer)).toEqual([
      expect.objectContaining({
        outcome: "skipped",
        reason: "over the limit of 0 actions per check",
        command: "chat sales bot messages delete -100 2 --allow-dangerous",
      }),
    ])
  })

  it("refuses a --max-actions that is not a whole number, before asking the messenger", async () => {
    const { code, stderr } = await call(["moderate", "-100", "--max-actions", "two", "--json"])

    expect(code).toBe(2)
    expect(stderr).toContain("--max-actions")
    expect(calls).toEqual([])
  })

  it("**judges the joins the messenger kept**", async () => {
    rules().set("-100", null, "blocked", "55")
    joins = [{ id: "55", name: "Blocked One", username: null, registeredAt: null, lastSeenAt: null }]

    const { answer, stderr } = await call(["moderate", "-100", "--json"])

    expect(rows(answer)).toContainEqual(expect.objectContaining({ kind: "member", rule: "blocked", person_id: "55" }))
    expect(stderr).not.toContain("no joins kept")
  })

  it("**without history from the messenger, judges the local copy** and says so", async () => {
    adapter = adapterFor({ history: false })
    await botCopy("chat-bot").keep("900", [invite("7", now - 60_000)], "watch", () => {})

    const { answer, stderr } = await call(["moderate", "-100", "--json"])

    expect(rows(answer)).toEqual([expect.objectContaining({ rule: "invites", message_id: "7" })])
    expect(stderr).toContain("gives a bot no history")
  })

  it("**keeps its saved point where max-cli keeps a bot's**, apart from the rules", async () => {
    rules().set("-100", null, "invites", "report")
    await call(["moderate", "-100", "--json"])

    expect(botFiles(app, "sales", env).checks).toBe(join(root, "state", "bots", "checks", "sales.json"))
    expect(JSON.parse(readFileSync(botFiles(app, "sales", env).checks, "utf8")).points["-100"]).toBe(
      new Date(now - 600_000).toISOString(),
    )
  })
})

describe("bot chats rules", () => {
  it("**sets and shows a group's rules by its title**, in the file the personal profile of that name uses", async () => {
    const set = await call(["rules", "set", "Team", "links", "delete", "--json"])
    const shown = await call(["rules", "show", "-100", "--json"])

    expect(set.code).toBe(0)
    expect(shown.answer.item).toMatchObject({ chat_id: "-100", title: "Team", saved: true, rules: { links: "delete" } })
    expect(shown.answer.item.file).toBe(join(root, "state", "profiles", "sales.moderation.json"))
  })

  it("puts one rule back to its default with unset, leaving the others", async () => {
    await call(["rules", "set", "-100", "links", "delete"])
    await call(["rules", "set", "-100", "invites", "remove"])
    const defaults = (await call(["rules", "show", "-200", "--json"])).answer.item.rules

    const unset = await call(["rules", "unset", "-100", "links", "--json"])

    expect(unset.answer.item.rules).toMatchObject({ links: defaults.links, invites: "remove" })
    expect(defaults.links).not.toBe("delete")
    expect(calls).toEqual([])
  })

  it("refuses newAccount: a bot is not told how old an account is", async () => {
    expect((await call(["rules", "set", "-100", "newAccount.days", "3"])).code).toBe(2)
  })
})
