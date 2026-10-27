import { globSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { holdLock, lockPath, readLock } from "../../background/lock.js"
import { relayCommand, relayPath } from "../../background/relay.js"
import type { Message, MessageEvent } from "../../domain/models.js"
import type { MessengerAdapter, SendOptions } from "../../ports/messenger.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { environmentOf } from "../context.js"
import { logsInOrOut, REMOTE_WRITE, reachesOtherService } from "../effects.js"
import { type RunOptions, run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import { recipientsCommand } from "./guard-commands.js"
import { imagesCommand } from "./images-command.js"
import { mcpCommand } from "./mcp-command.js"
import { messagesCommand } from "./messages-command.js"
import { serveCommand } from "./serve-command.js"
import { lentConnection } from "./serve-relay.js"
import { watchCommand } from "./watch-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const chat = { id: "7", title: "Book club", kind: "group" as const, lastMessageAt: null }
const message: Message = {
  id: "11",
  chatId: "7",
  senderId: "500",
  senderName: "Owner",
  timestamp: "2026-10-17T10:00:00.000Z",
  editedAt: null,
  text: "hi",
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "relay-"))
  const env = {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_REQUESTS_PER_MINUTE: "0",
    MESSAGING_STORE: join(root, "m.db"),
  }
  rememberAccount(app, "default", "500", env)
  return { root, env }
}

/** serve's one connection: what it was asked to send, and a way to push an event to whoever listens. */
const held = () => {
  const sent: { text: string; options: SendOptions }[] = []
  let push: ((event: MessageEvent) => void) | undefined
  let sendGate: Promise<void> = Promise.resolve()
  const adapter = {
    self: () => "500",
    me: async () => ({ id: "500", name: "Owner", username: null }),
    resolve: async () => chat,
    send: async (_chat: string, text: string, options: SendOptions) => {
      await sendGate
      sent.push({ text, options })
      return { message: { ...message, text }, sendId: options.sendId }
    },
    watch: async (onEvent: (event: MessageEvent) => void, stop: AbortSignal, onReady?: () => void) => {
      push = onEvent
      onReady?.()
      await new Promise((resolve) => stop.addEventListener("abort", resolve, { once: true }))
    },
    close: async () => {},
  } as unknown as MessengerAdapter
  return {
    adapter,
    sent,
    push: (event: MessageEvent) => push?.(event),
    holdSends: () => {
      sendGate = new Promise(() => {})
    },
  }
}

const messengerOver = (connect: Messenger["connect"]): Messenger => ({
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect,
  chatArgument: "a chat",
  connection: "exclusive",
})

const definitionFor = (messenger: Messenger, extra: () => Command[] = () => []) => ({
  app,
  commands: () => [
    serveCommand(messenger),
    messagesCommand(messenger),
    watchCommand(messenger),
    mcpCommand(messenger),
    recipientsCommand(messenger),
    ...extra(),
  ],
})

/** A client never connects on its own while serve holds the profile. */
const refuseOwnConnection: Messenger["connect"] = async () => {
  throw new Error("the client opened a connection of its own")
}

const startServe = async (env: NodeJS.ProcessEnv, extra?: () => Command[]) => {
  const connection = held()
  const stop = new AbortController()
  const streams = captureStreams()
  const done = run(
    ["serve"],
    definitionFor(
      messengerOver(async () => connection.adapter),
      extra,
    ),
    {
      streams,
      tty: false,
      env,
      signal: stop.signal,
    },
  )
  await vi.waitFor(() => expect(readLock(lockPath(app, "default", env))?.relay).toBeDefined(), { interval: 5 })
  return {
    ...connection,
    streams,
    stop: () => stop.abort(),
    done,
    lock: () => readLock(lockPath(app, "default", env)),
  }
}

const client = async (argv: string[], env: NodeJS.ProcessEnv, options: Partial<RunOptions> = {}) => {
  const streams = captureStreams()
  const code = await run(argv, definitionFor(messengerOver(refuseOwnConnection)), {
    streams,
    tty: false,
    env,
    ...options,
  })
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

describe("commands through serve's relay", () => {
  it("**sends on serve's connection, and the guard journals it once, in serve**", async () => {
    const { env } = setup()
    const serve = await startServe(env)

    const answer = await client(["messages", "send", "Book", "hello", "--json"], env)

    expect(answer.code).toBe(0)
    expect(JSON.parse(answer.stdout[0] ?? "{}").item.message).toMatchObject({ text: "hello", chat_id: "7" })
    expect(serve.sent.map((one) => one.text)).toEqual(["hello"])
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([{ outcome: "sent" }])
    expect(serve.lock()?.relay?.path).toMatch(/default\.sock$/)
    serve.stop()
    expect(await serve.done).toBe(0)
  })

  it("**warns once on stderr, naming both versions, when serve runs another version of the CLI**", async () => {
    const { env } = setup()
    const serve = await startServe(env)
    const same = await client(["messages", "send", "Book", "one", "--json"], env)
    expect(same.stderr.join("\n")).not.toContain("serve runs")

    const path = lockPath(app, "default", env)
    holdLock(path, { ...(readLock(path) as NonNullable<ReturnType<typeof readLock>>), version: "0.9.0" })
    const skewed = await client(["messages", "send", "Book", "two", "--json"], env)

    expect(skewed.code).toBe(0)
    expect(skewed.stderr.filter((line) => line.includes("serve runs 0.9.0, this is 1.0.0"))).toHaveLength(1)
    expect(serve.sent.map((one) => one.text)).toEqual(["one", "two"])
    serve.stop()
    expect(await serve.done).toBe(0)
  })

  it("keeps the client's read-only lock: serve refuses the write it forwards", async () => {
    const { env } = setup()
    const serve = await startServe(env)

    const refused = await client(["messages", "send", "Book", "hello"], { ...env, CHAT_READ_ONLY: "1" })

    expect(refused.code).not.toBe(0)
    expect(refused.stderr.join("\n")).toContain("permission_error")
    expect(serve.sent).toEqual([])
    serve.stop()
    await serve.done
  })

  it.each([undefined, "0"])("retains serve's read-only lock when the client supplies %s", async (value) => {
    const { env } = setup()
    const serve = await startServe({ ...env, CHAT_READ_ONLY: "1" })
    try {
      const refused = await client(["messages", "send", "Book", "hello"], { ...env, CHAT_READ_ONLY: value })
      expect(refused.code).not.toBe(0)
      expect(refused.stderr.join("\n")).toContain("permission_error")
      expect(serve.sent).toEqual([])
    } finally {
      serve.stop()
      await serve.done
    }
  })

  it("never relays a logout into serve, which would log out serve's own connection", async () => {
    const { env } = setup()
    const serve = await startServe(env)
    const ran: (string | undefined)[] = []
    const logout = logsInOrOut(annotate(new Command("end"), { effects: REMOTE_WRITE })).action(function (
      this: Command,
    ) {
      ran.push(environmentOf(this).relayed?.profile)
    })

    const code = await run(
      ["session", "end"],
      { app, commands: () => [new Command("session").addCommand(logout)] },
      {
        streams: captureStreams(),
        tty: false,
        env,
      },
    )

    expect(code).toBe(0)
    expect(ran).toEqual([undefined])
    serve.stop()
    await serve.done
  })

  it("**runs `images embed` in serve**, whose connection downloads the pictures", async () => {
    const { env } = setup()
    const embedded: string[] = []
    const embedding = (where: string): Messenger => ({
      ...messengerOver(refuseOwnConnection),
      services: (base) => ({
        pictures: {
          ...base.pictures,
          embed: async () => {
            embedded.push(where)
            return { model: "synthetic", embedded: 0, skipped: 0, failed: 0, more: false }
          },
        },
      }),
    })
    const serve = await startServe(env, () => [imagesCommand(embedding("serve"))])

    const code = await run(
      ["images", "embed", "--json"],
      { app, commands: () => [imagesCommand(embedding("client"))] },
      { streams: captureStreams(), tty: false, env },
    )

    expect(code).toBe(0)
    expect(embedded).toEqual(["serve"])
    serve.stop()
    await serve.done
  })

  it("never relays a command whose remote side is another service: serve has no connection to lend it", async () => {
    const { env } = setup()
    const serve = await startServe(env)
    const ran: (string | undefined)[] = []
    const embed = reachesOtherService(annotate(new Command("embed"), { effects: REMOTE_WRITE })).action(function (
      this: Command,
    ) {
      ran.push(environmentOf(this).relayed?.profile)
    })

    const code = await run(
      ["conversations", "embed"],
      { app, commands: () => [new Command("conversations").addCommand(embed)] },
      { streams: captureStreams(), tty: false, env },
    )

    expect(code).toBe(0)
    expect(ran).toEqual([undefined])
    serve.stop()
    await serve.done
  })

  it("**refuses a logout an older client relays**, and never runs it on serve's connection", async () => {
    const { env } = setup()
    const ran: string[] = []
    const session = () => [
      new Command("session").addCommand(
        logsInOrOut(annotate(new Command("end"), { effects: REMOTE_WRITE })).action(() => {
          ran.push("end")
        }),
      ),
    ]
    const serve = await startServe(env, session)
    const streams = captureStreams()
    const stdin = new PassThrough()
    stdin.end()

    const code = await relayCommand(
      serve.lock()?.relay?.path ?? "",
      { argv: ["--json", "session", "end"], env: { ...env }, cwd: process.cwd(), tty: false, stdinTty: false },
      {
        streams,
        stdin,
        stdout: new PassThrough(),
        signal: new AbortController().signal,
        writes: true,
        holder: "serve",
      },
    )

    expect(code).toBe(5)
    expect(JSON.parse(streams.stderr[0] ?? "{}").error).toMatchObject({ code: "permission_error" })
    expect(streams.stderr.join("\n")).toContain("chat default server stop")
    expect(ran).toEqual([])
    serve.stop()
    await serve.done
  })

  it("adds a recipient through serve, which resolves the chat on its own connection", async () => {
    const { env } = setup()
    const serve = await startServe(env)

    const added = await client(["--json", "recipients", "add", "Book"], env)

    expect(added.code, added.stderr.join("\n")).toBe(0)
    expect(JSON.parse(added.stdout[0] ?? "{}").item).toMatchObject({ id: "7" })
    serve.stop()
    await serve.done
  })

  it("reads a relative path against the client's directory, not serve's", async () => {
    const { root, env } = setup()
    writeFileSync(join(root, "note.txt"), "words")
    const serve = await startServe(env)

    const answer = await client(
      ["messages", "send", "Book", "--file", relative(process.cwd(), join(root, "note.txt"))],
      env,
    )

    expect(answer.code).toBe(0)
    expect(serve.sent[0]?.options.attachments).toMatchObject([{ name: "note.txt" }])
    serve.stop()
    await serve.done
  })

  it("streams what serve's connection hears to a relayed watch", async () => {
    const { env } = setup()
    const serve = await startServe(env)
    const stop = new AbortController()
    const streams = captureStreams()
    const watching = run(["watch", "--jsonl"], definitionFor(messengerOver(refuseOwnConnection)), {
      streams,
      tty: false,
      env,
      signal: stop.signal,
    })
    await vi.waitFor(() => expect(streams.stderr.join("\n")).toContain("listening"), { interval: 5 })

    serve.push({ event: "message", message: { ...message, chatTitle: "Book club", text: "news" } })
    await vi.waitFor(() => expect(streams.stdout).toHaveLength(1), { interval: 5 })
    stop.abort()

    expect(await watching).toBe(0)
    expect(JSON.parse(streams.stdout[0] ?? "{}")).toMatchObject({ type: "item", data: { text: "news" } })
    serve.stop()
    await serve.done
  })

  it("ends a relayed run with 0 when its reader goes away, and serve goes on", async () => {
    const { env } = setup()
    const serve = await startServe(env)
    const streams = captureStreams()
    const stdout = new PassThrough()
    const watching = run(["watch", "--jsonl"], definitionFor(messengerOver(refuseOwnConnection)), {
      streams,
      stdout,
      tty: false,
      env,
    })
    await vi.waitFor(() => expect(streams.stderr.join("\n")).toContain("listening"), { interval: 5 })

    stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))

    expect(await watching).toBe(0)
    expect((await client(["messages", "send", "Book", "after"], env)).code).toBe(0)
    serve.stop()
    expect(await serve.done).toBe(0)
  })

  it("ends a relayed watch that fails, and serve goes on keeping what arrives", async () => {
    const { env } = setup()
    const serve = await startServe(env)
    const streams = captureStreams()
    const watching = run(
      ["watch", "--jsonl", "--max-output-bytes", "10"],
      definitionFor(messengerOver(refuseOwnConnection)),
      { streams, tty: false, env },
    )
    await vi.waitFor(() => expect(streams.stderr.join("\n")).toContain("listening"), { interval: 5 })

    serve.push({ event: "message", message: { ...message, chatTitle: "Book club", text: "too long for ten bytes" } })
    serve.push({ event: "message", message: { ...message, id: "12", chatTitle: "Book club", text: "again" } })

    expect(await watching).not.toBe(0)
    expect(streams.stderr.join("\n")).toContain("output.too-large")
    expect((await client(["messages", "send", "Book", "after"], env)).code).toBe(0)
    serve.stop()
    expect(await serve.done).toBe(0)
    expect(JSON.parse(serve.streams.stdout[0] ?? "{}").item).toMatchObject({ kept: { message: 2 } })
  })

  it("serves an MCP session over the relay", async () => {
    const { env } = setup()
    const serve = await startServe(env)
    const stdin = new PassThrough()
    const out: string[] = []
    const stdout = new Writable({
      write: (chunk, _encoding, done) => {
        out.push(String(chunk))
        done()
      },
    })
    const session = client(["mcp", "serve"], env, { stdin, stdout })
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      })}\n`,
    )
    await vi.waitFor(() => expect(out.join("")).toContain('"id":1'), { interval: 5 })
    stdin.end()

    expect((await session).code).toBe(0)
    expect(JSON.parse(out.join("").split("\n")[0] ?? "{}").result.serverInfo).toBeDefined()
    serve.stop()
    await serve.done
  })

  it("refuses a request for another profile, and serve goes on", async () => {
    const { env } = setup()
    const serve = await startServe(env)
    const path = serve.lock()?.relay?.path ?? ""

    const lines = await new Promise<string>((resolve) => {
      let got = ""
      const socket = connect(path, () => {
        socket.write(
          `${JSON.stringify({
            v: 1,
            run: {
              argv: ["other", "messages", "send", "Book", "x"],
              env: { ...env, CHAT_PROFILE: "other" },
              cwd: process.cwd(),
              tty: false,
              stdinTty: true,
            },
          })}\n`,
        )
      })
      socket.on("data", (chunk) => {
        got += String(chunk)
      })
      socket.on("close", () => resolve(got))
    })

    expect(lines).toContain("does not run commands for profile other")
    expect(lines).toMatch(/"exit":[1-9]/)
    expect(serve.sent).toEqual([])
    expect((await client(["messages", "send", "Book", "still here"], env)).code).toBe(0)
    serve.stop()
    await serve.done
  })

  it("says a write's outcome is unknown when serve stops before answering", async () => {
    const { env, root } = setup()
    const serve = await startServe(env)
    serve.holdSends()

    const sending = client(["messages", "send", "Book", "hello"], env)
    await vi.waitFor(() => expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toHaveLength(1), {
      interval: 5,
    })
    serve.stop()

    const answer = await sending
    expect(answer.stderr.join("\n")).toContain("outcome_unknown")
    expect(answer.code).not.toBe(0)
    await serve.done
    // serve's own run for the relayed send ends after serve does, and would write into a folder the sandbox removed.
    await vi.waitFor(
      () => {
        const runs = globSync("state/runs/*/*/run.json", { cwd: root })
        expect(runs).toHaveLength(2)
        for (const file of runs) expect(JSON.parse(readFileSync(join(root, file), "utf8")).status).not.toBe("running")
      },
      { interval: 5 },
    )
  })

  it("connects on its own when no serve holds the profile", async () => {
    const { env } = setup()
    const connection = held()

    const streams = captureStreams()
    const code = await run(
      ["messages", "send", "Book", "alone"],
      definitionFor(messengerOver(async () => connection.adapter)),
      { streams, tty: false, env },
    )

    expect(code).toBe(0)
    expect(connection.sent.map((one) => one.text)).toEqual(["alone"])
  })
})

it.skipIf(process.platform === "win32")("keeps the relay socket path short when TMPDIR is deep too", () => {
  vi.stubEnv("TMPDIR", `/var/${"deep/".repeat(20)}`)
  try {
    const path = relayPath(`/home/${"state/".repeat(20)}tg-personal.lock`)
    expect(path.length).toBeLessThanOrEqual(100)
    expect(path.startsWith("/tmp/wirecat-relay-")).toBe(true)
  } finally {
    vi.unstubAllEnvs()
  }
})

describe("a lent connection", () => {
  it("never listens on its own: serve already saves what its connection hears", () => {
    const own = {
      self: () => "1",
      close: async () => {},
      listen: async () => {},
      listenHistory: async () => {},
      feed: async () => {},
      storedChats: async () => {},
    } as unknown as MessengerAdapter

    expect(lentConnection(own).listen).toBeUndefined()
    expect(lentConnection(own).listenHistory).toBeUndefined()
    expect(lentConnection(own).feed).toBeUndefined()
    expect(lentConnection(own).storedChats).toBeUndefined()
  })
})
