import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { listEnvelopeSchema } from "@wirecat/cli-base/standards"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { PNG } from "pngjs"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import type { LoadEngine } from "../../attachments/extract.js"
import { importEngine } from "../../attachments/extract.js"
import type { Attachment, Chat, Message } from "../../domain/models.js"
import { attachment } from "../../entities/attachment.js"
import { ENTITIES } from "../../entities/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { openCache } from "../../store/open.js"
import { openStore } from "../../store/store.js"
import { docx, pdf } from "../../testing/files.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import { attachmentsCommand } from "./attachments-command.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { searchCommand } from "./search-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const OWNER = { provider: "chat", account: "500" }
const SECRET = "Quarterly invoice"

const chat: Chat = {
  id: "7",
  title: "Work fixture",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
}
const message = (id: string, attachments: Attachment[]): Message => ({
  id,
  chatId: "7",
  senderId: "10",
  senderName: "Alice Synthetic",
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, Number(id))).toISOString(),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const adapter = (bytes: Uint8Array, history: Message[] = []): MessengerAdapter => ({
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat], hasMore: false }),
  history: async () => ({ items: history, hasMore: false }),
  resolve: async () => chat,
  chat: async () => ({ ...chat, members: [] }),
  send: async () => {
    throw new Error("never sends")
  },
  logout: async () => {},
  close: async () => {},
  download: async () => ({
    files: [
      {
        kind: "file",
        name: "fetched.txt",
        bytes: async function* () {
          yield bytes
        },
      },
    ],
    skipped: [],
  }),
})

/**
 * Chat 7: message 1 with notes.txt, 2 with deal.docx, 3 with scan.pdf (a text layer), 4 with an empty PDF,
 * 5 with a photo, 6 with a voice note, 7 with a file nobody downloaded.
 */
const setup = async ({ config, load, history }: { config?: object; load?: LoadEngine; history?: Message[] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "attachments-cli-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  if (config) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
  }
  rememberAccount(app, "default", "500", env)
  const files = join(root, "files")
  mkdirSync(files)
  const saved: [string, string, Uint8Array][] = [
    ["1", "notes.txt", new TextEncoder().encode(`${SECRET} for March`)],
    ["2", "deal.docx", docx(["Договор поставки"])],
    ["3", "scan.pdf", pdf("Delivery note 77")],
    ["4", "blank.pdf", pdf()],
    ["5", "5-1.jpg", new Uint8Array([0xff, 0xd8])],
    ["6", "6-1.ogg", new Uint8Array([0x4f, 0x67])],
  ]
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.chats.saveChats(OWNER, [chat])
  await store.messages.saveMessages(
    OWNER,
    "7",
    [
      ...saved.map(([id, name]) => message(id, [{ kind: id === "5" ? "photo" : id === "6" ? "voice" : "file", name }])),
      message("7", [{ kind: "file", name: "later.txt" }]),
    ],
    { via: "history" },
  )
  for (const [id, name, bytes] of saved) {
    writeFileSync(join(files, name), bytes)
    await store.attachments.keepDownloads(OWNER, "7", id, [
      { kind: id === "5" ? "photo" : id === "6" ? "voice" : "file", name, path: join(files, name) },
    ])
  }
  await store.close()
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => adapter(new TextEncoder().encode("fetched invoice text"), history),
    chatArgument: "a chat",
    ...(load
      ? {
          services: (base) => ({
            attachments: { ...base.attachments, extract: (options) => base.attachments.extract({ ...options, load }) },
          }),
        }
      : {}),
  }
  const keyring = memoryKeyring()
  const runs =
    (tty: boolean, stdin?: string) =>
    async (...argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        argv,
        {
          app,
          commands: () => [
            attachmentsCommand(messenger),
            messagesCommand(messenger),
            searchCommand(messenger),
            storeCommand(messenger),
          ],
        },
        {
          streams,
          tty,
          env: { ...env, NO_COLOR: "1" },
          keyring,
          ...(stdin === undefined ? {} : { stdin: Object.assign(Readable.from([stdin]), { isTTY: false }) }),
        },
      )
      if (code === 0 && argv[0] === "attachments" && argv.includes("--json")) {
        const schema =
          argv[1] === "extract"
            ? ENTITIES.attachment_extraction
            : argv[1] === "show"
              ? ENTITIES.attachment_bytes
              : argv[1] === "text"
                ? ENTITIES.attachment_text_change
                : undefined
        if (schema) v.parse(schema as v.GenericSchema, JSON.parse(streams.stdout.join("")).item)
      }
      return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
    }
  return { call: runs(false), pretty: runs(true), piped: (text: string) => runs(false, text), root, env, files }
}

const json = (result: { stdout: string }) => {
  const body = JSON.parse(result.stdout || "null")
  return body?.item ?? body
}
const hits = async (call: (...argv: string[]) => Promise<{ stdout: string }>, query: string) =>
  json(await call("search", "messages", query, "--json")).items.map(({ ref }: { ref: string }) => ref.split("/").at(-1))

describe("attachments extract", () => {
  it("projects transfer fields and refuses unknown fields before reading retained bytes", async () => {
    const fixture = await setup()
    const projected = await fixture.call("attachments", "show", "7", "1", "--json=ref,complete,total_bytes")
    expect(projected.code, projected.stderr).toBe(0)
    expect(Object.keys(json(projected)).sort()).toEqual(["complete", "ref", "total_bytes"])
    const unknown = await fixture.call("attachments", "show", "7", "1", "--json=unknown_field")
    expect(unknown.code).not.toBe(0)
    expect(JSON.parse(unknown.stderr).error.reason).toBe("output.unknown-field")
  })

  it("renders a retained PDF page as bounded PNG without connecting, extracting or storing text", async () => {
    const fixture = await setup()
    const done = await fixture.call("attachments", "show", "7", "3", "--page", "1", "--json")
    expect(done.code).toBe(0)
    const answer = json(done)
    expect(answer).toMatchObject({ mime_type: "image/png", complete: true, pdf: { page: 1, page_count: 1 } })
    expect(answer.pdf.source_sha256).not.toBe(answer.sha256)
    expect(Buffer.from(answer.base64, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(
      json(await fixture.call("attachments", "list", "chat:7", "is:needs_text", "--json")).items.some(
        (item: { message: string }) => item.message.endsWith("/3"),
      ),
    ).toBe(true)
    for (const extra of [
      ["--offset-bytes", "0"],
      ["--chunk-bytes", "20"],
      ["--expected-fingerprint", "0".repeat(64)],
    ]) {
      expect((await fixture.call("attachments", "show", "7", "3", "--page", "1", ...extra, "--json")).code).not.toBe(0)
    }
    expect((await fixture.call("attachments", "show", "7", "1", "--page", "1", "--json")).code).not.toBe(0)
  })

  it("transfers exact retained bytes as JSON", async () => {
    const fixture = await setup()
    const result = await fixture.call("attachments", "show", "7", "1", "--json", "--chunk-bytes", "8")
    expect(result.code).toBe(0)
    expect(json(result)).toMatchObject({
      read_bytes: 8,
      complete: false,
      next_offset_bytes: 8,
      base64: Buffer.from(SECRET).subarray(0, 8).toString("base64"),
    })
  })

  it("refuses retained file reads when either messages or attachment reads are denied", async () => {
    for (const permission of ["messages", "attachments.show"]) {
      const fixture = await setup({ config: { permissions: { [permission]: "deny" } } })
      const result = await fixture.call("attachments", "show", "7", "1", "--json")
      expect(result.code).not.toBe(0)
      expect(result.stdout).not.toContain(Buffer.from(SECRET).toString("base64"))
      const preview = await fixture.call("attachments", "show", "7", "3", "--page", "1", "--json")
      expect(preview.code).not.toBe(0)
      expect(preview.stdout).not.toContain('"mime_type":"image/png"')
    }
  })

  it("aborts a bulk OCR request at the command deadline and leaves no indexed answer", async () => {
    const { call, files } = await setup({
      config: {
        defaults: { models: { ocr: { provider: "openai", model: "fixture", base_url: "https://example.test/v1" } } },
      },
    })
    writeFileSync(join(files, "5-1.jpg"), PNG.sync.write(new PNG({ width: 2, height: 2 })))
    let signal: AbortSignal | null | undefined
    let started = () => {}
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal
          signal?.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true })
          started()
        }),
    )
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const pending = call(
        "attachments",
        "extract",
        "--ocr",
        "--concurrency",
        "1",
        "--limit",
        "1",
        "--timeout",
        "100ms",
        "--json",
      )
      await Promise.race([
        began,
        pending.then(() => {
          throw new Error("OCR command ended before starting the request")
        }),
      ])
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending
      expect(result.code).toBe(9)
      expect(signal?.aborted).toBe(true)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(result.stdout).toBe("")
      vi.useRealTimers()
      expect(await hits(call, "content:lateinvoice")).toEqual([])
    } finally {
      vi.useRealTimers()
      fetcher.mockRestore()
    }
  })
  it("validates OCR selection and offline/concurrency conflicts before any API call", async () => {
    const { call } = await setup()
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network allowed"))
    try {
      for (const flags of [
        ["--concurrency", "2"],
        ["--ocr", "--concurrency", "9"],
        ["--ocr", "--limit", "501"],
        ["--ocr", "--offline"],
      ]) {
        const result = await call("attachments", "extract", ...flags, "--json")
        expect(result.code).toBe(2)
        expect(result.stdout).toBe("")
      }
      const unconfigured = await call("attachments", "extract", "--ocr", "--json")
      expect(unconfigured.code).not.toBe(0)
      expect(unconfigured.stderr).toContain("models.ocr")
      expect(fetcher).not.toHaveBeenCalled()
      const denied = await setup({
        config: {
          defaults: {
            permissions: { messages: "deny", "attachments.extract": "allow" },
            models: { ocr: { provider: "openai", model: "fixture" } },
          },
        },
      })
      expect((await denied.call("attachments", "extract", "--ocr", "--json")).code).not.toBe(0)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })

  it("executes the selected OCR gateway from CLI and indexes its answer without printing it", async () => {
    const { call, env, files } = await setup({
      config: {
        defaults: {
          models: { ocr: { provider: "openai", model: "vision-fixture", base_url: "https://example.test/v1" } },
        },
      },
    })
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.messages.saveMessages(OWNER, "7", [message("8", [{ kind: "photo", name: "8.png" }])], {
      via: "history",
    })
    const path = join(files, "8.png")
    writeFileSync(path, PNG.sync.write(new PNG({ width: 2, height: 2 })))
    await store.attachments.keepDownloads(OWNER, "7", "8", [{ kind: "photo", name: "8.png", path }])
    await store.close()
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.messages.at(-1).content[0].type).toBe("image_url")
      expect(body.model).toBe("vision-fixture")
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: "bulkocrinvoice 42" } }],
        usage: { total_tokens: 12 },
      })
    })
    try {
      const result = await call("attachments", "extract", "--ocr", "--concurrency", "2", "--limit", "1", "--json")
      expect(result.code).toBe(0)
      expect(json(result)).toMatchObject({ extracted: 1, files: [{ ref: "msg:chat/500/7/8", ocr_pages: 1 }] })
      expect(result.stdout + result.stderr).not.toContain("bulkocrinvoice")
      expect(await hits(call, "content:bulkocrinvoice")).toEqual(["8"])
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.mockRestore()
    }
  })
  it("**reads every saved file's text layer into the store, answering what it did and never the text**", async () => {
    const { call } = await setup()
    const done = await call("attachments", "extract", "--json")

    expect(done.code).toBe(0)
    expect(done.stdout).not.toContain("Quarterly")
    expect(done.stderr).not.toContain("Quarterly")
    const answer = json(done)
    expect(answer).toMatchObject({
      extracted: 3,
      needs_agent: 2,
      failed: 0,
      unsupported: 1,
      not_downloaded: 1,
      complete: true,
    })
    expect(answer.files).toEqual([
      {
        ref: "msg:chat/500/7/5",
        attachment: 1,
        kind: "photo",
        name: "5-1.jpg",
        status: "needs-agent",
        extractor: "none",
        local_path: expect.stringMatching(/files[/\\]5-1\.jpg$/),
      },
      expect.objectContaining({
        ref: "msg:chat/500/7/4",
        status: "needs-agent",
        extractor: expect.stringMatching(/^pdf:unpdf@/),
      }),
      expect.objectContaining({ ref: "msg:chat/500/7/3", status: "extracted", chars: expect.any(Number) }),
      expect.objectContaining({
        ref: "msg:chat/500/7/2",
        status: "extracted",
        extractor: expect.stringMatching(/^docx:mammoth@/),
      }),
      {
        ref: "msg:chat/500/7/1",
        attachment: 1,
        kind: "file",
        name: "notes.txt",
        status: "extracted",
        extractor: "plain",
        chars: 27,
      },
    ])

    expect(await hits(call, "content:invoice")).toEqual(["1"])
    expect(await hits(call, "content:договор")).toEqual(["2"])
    expect(await hits(call, 'content:"delivery note"')).toEqual(["3"])
    expect(await hits(call, "text:invoice")).toEqual([])
  })

  it("**a second run reads nothing unchanged; a file of another size is read again**", async () => {
    const { call, files } = await setup()
    await call("attachments", "extract", "--json")
    expect(json(await call("attachments", "extract", "--json"))).toMatchObject({
      extracted: 0,
      unchanged: 5,
      files: [],
    })

    writeFileSync(join(files, "notes.txt"), "Revised estimate")
    expect(json(await call("attachments", "extract", "--json"))).toMatchObject({ extracted: 1, unchanged: 4 })
    expect(await hits(call, "content:estimate")).toEqual(["1"])
    expect(await hits(call, "content:invoice")).toEqual([])
  })

  it("**--limit stops after that many files read, and the next run continues**", async () => {
    const { call } = await setup()
    expect(json(await call("attachments", "extract", "--limit", "2", "--json"))).toMatchObject({
      complete: false,
      files: [{}, {}],
    })
    expect(json(await call("attachments", "extract", "--json"))).toMatchObject({
      complete: true,
      extracted: 3,
      unchanged: 2,
    })
  })

  it("**--limit moves on past photos: a photo is noted once, for an agent, and not read again**", async () => {
    const { call, env, files } = await setup()
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.messages.saveMessages(
      OWNER,
      "7",
      [message("8", [{ kind: "photo" }]), message("9", [{ kind: "photo" }])],
      {
        via: "history",
      },
    )
    for (const id of ["8", "9"]) {
      writeFileSync(join(files, `${id}-1.jpg`), new Uint8Array([0xff, 0xd8]))
      await store.attachments.keepDownloads(OWNER, "7", id, [{ kind: "photo", path: join(files, `${id}-1.jpg`) }])
    }
    await store.close()

    const seen: string[] = []
    for (let run = 0; run < 3; run += 1) {
      const { files: items } = json(await call("attachments", "extract", "--limit", "1", "--json"))
      seen.push(...items.map(({ ref }: { ref: string }) => ref))
    }
    expect(seen).toEqual(["msg:chat/500/7/9", "msg:chat/500/7/8", "msg:chat/500/7/5"])
    const needs = json(await call("attachments", "list", "is:needs_text", "--json")).items
    expect(needs.slice(0, 3)).toMatchObject(
      ["9", "8", "5"].map((id) => ({
        message: `msg:chat/500/7/${id}`,
        extraction: { extractor: "none", error: "no_text" },
      })),
    )
  })

  it("names a file that is gone, and reads only one chat's files with --chat", async () => {
    const { call, files } = await setup()
    writeFileSync(join(files, "notes.txt"), "")
    const { rmSync } = await import("node:fs")
    rmSync(join(files, "notes.txt"))
    const answer = json(await call("attachments", "extract", "--chat", "Work fixture", "--json"))
    expect(answer.files.find(({ ref }: { ref: string }) => ref === "msg:chat/500/7/1")).toMatchObject({
      status: "missing",
    })
    expect(json(await call("attachments", "extract", "--chat", "7", "--json")).extracted).toBe(0)
  })

  it("**says once which package could not be loaded, and reads those files on a later run**", async () => {
    const without: LoadEngine = async (name) => {
      if (name === "unpdf")
        throw Object.assign(new Error("Cannot find package 'unpdf'"), { code: "ERR_MODULE_NOT_FOUND" })
      return importEngine(name)
    }
    const { call } = await setup({ load: without })
    const done = await call("attachments", "extract", "--json")
    expect(json(done)).toMatchObject({ engines_missing: ["unpdf"], extracted: 2 })
    expect(done.stderr.match(/package unpdf, which ships with chat, could not be loaded/g)).toHaveLength(1)
  })

  it("**names the missing package on each file it could not read**, as `messages download --extract` reports it", async () => {
    const without: LoadEngine = async (name) => {
      if (name === "unpdf")
        throw Object.assign(new Error("Cannot find package 'unpdf'"), { code: "ERR_MODULE_NOT_FOUND" })
      return importEngine(name)
    }
    const { call } = await setup({ load: without })
    const done = json(await call("attachments", "extract", "--json"))
    const pdf = done.files.find(({ status }: { status: string }) => status === "engine-missing")
    expect(pdf.issue.message).toContain("the package unpdf, which ships with this tool, could not be loaded")
  })

  it("prints one line per file in a terminal, and the summary on stderr", async () => {
    const { pretty } = await setup()
    const done = await pretty("attachments", "extract")
    expect(done.stdout).toContain("extracted  msg:chat/500/7/1 #1  notes.txt")
    expect(done.stdout).not.toContain("Quarterly")
    expect(done.stderr).toContain("3 extracted")
  })

  it("**--download saves the files nobody saved, records where, and reads them**", async () => {
    const { call, root } = await setup()
    const into = join(root, "fetched")
    const answer = json(await call("attachments", "extract", "--download", "--output-dir", into, "--json"))
    expect(answer).toMatchObject({ not_downloaded: 0, extracted: 4 })
    expect(await hits(call, "content:fetched")).toEqual(["7"])
    const database = await openCache(join(root, "m.db"))
    const row = database.prepare("SELECT local_path FROM attachments WHERE name = 'later.txt'").get()
    database.close()
    expect(row?.local_path).toBe(join(into, "fetched.txt"))
  })

  it("refuses --download without a folder, a folder without --download, and a read-only profile", async () => {
    const { call } = await setup()
    expect((await call("attachments", "extract", "--download")).stderr).toContain("--output-dir")
    expect((await call("attachments", "extract", "--output-dir", "x")).stderr).toContain("add --download")
    const locked = await setup({ config: { profiles: { default: { permissions: { attachments: "readonly" } } } } })
    const refused = await locked.call("attachments", "extract")
    expect(refused.code).toBe(5)
    expect(refused.stderr).toContain("permissions.attachments.extract allow")
  })

  it("**store rebuild rebuilds the files' word index**", async () => {
    const { call } = await setup()
    await call("attachments", "extract")
    expect(json(await call("store", "rebuild", "--json"))).toMatchObject({ file_texts: 3 })
    expect(await hits(call, "content:invoice")).toEqual(["1"])
  })
})

describe("extraction follow-ups", () => {
  it("continues extraction from its cursor and supports --all extraction", async () => {
    const { call, root } = await setup({ history: [message("7", [{ kind: "file", name: "later.txt" }])] })
    const first = json(await call("attachments", "extract", "--limit", "1", "--json"))
    expect(first).toMatchObject({ complete: false, cursor: expect.any(String) })
    const resumed = json(await call("attachments", "extract", "--cursor", first.cursor, "--json"))
    expect(resumed).toMatchObject({ complete: true, extracted: 3 })
    expect((await call("attachments", "extract", "--cursor", "invalid")).code).toBe(2)
    const all = await call(
      "messages",
      "download",
      "7",
      "--all",
      "--extract",
      "--output-dir",
      join(root, "all"),
      "--json",
    )
    expect(all.code).toBe(0)
    expect(json(all)).toMatchObject({ extraction: { extracted: 1, complete: true } })
    expect(await hits(call, "content:fetched")).toEqual(["7"])
  })

  it("hashes a same-size replacement and replaces content hits", async () => {
    const { call, files } = await setup()
    await call("attachments", "extract", "--json")
    writeFileSync(join(files, "notes.txt"), "Updated estimate for March!")
    expect(json(await call("attachments", "extract", "--json"))).toMatchObject({ extracted: 1 })
    expect(await hits(call, "content:estimate")).toEqual(["1"])
    expect(await hits(call, "content:invoice")).toEqual([])
  })

  it("matches one scoped directory and refuses symlinks before extraction", async () => {
    const { call, files, root } = await setup()
    expect(json(await call("attachments", "extract", "--chat", "7", "--from-dir", files, "--json"))).toMatchObject({
      extracted: 3,
    })
    expect((await call("attachments", "extract", "--from-dir", files)).code).toBe(2)
    expect((await call("attachments", "extract", "--chat", "7", "--from-dir", files, "--download")).code).toBe(2)
    const outside = join(root, "outside.txt")
    writeFileSync(outside, "synthetic outside text")
    symlinkSync(outside, join(files, "escape.txt"))
    expect((await call("attachments", "extract", "--chat", "7", "--from-dir", files)).stderr).toContain(
      "symbolic links",
    )
  })

  it("extracts just the downloaded message, retaining all other files untouched", async () => {
    const { call, root } = await setup()
    const result = await call(
      "messages",
      "download",
      "7",
      "7",
      "--extract",
      "--output-dir",
      join(root, "download"),
      "--json",
    )
    expect(result.code).toBe(0)
    expect(json(result)).toMatchObject({ extraction: { extracted: 1, complete: true } })
    expect(await hits(call, "content:fetched")).toEqual(["7"])
    expect(await hits(call, "content:Quarterly")).toEqual([])
  })

  it("denies extraction before downloading, while ordinary download still works", async () => {
    const { call, root } = await setup({
      config: { profiles: { default: { permissions: { "attachments.extract": "deny" } } } },
    })
    const result = await call(
      "messages",
      "download",
      "7",
      "7",
      "--extract",
      "--output-dir",
      join(root, "refused"),
      "--json",
    )
    expect(result.code).toBe(5)
    expect(existsSync(join(root, "refused"))).toBe(false)
  })
})

describe("an agent's text for a file", () => {
  it("**lists what needs reading, keeps what the agent read, and content: finds it**", async () => {
    const { call, piped, root } = await setup()
    await call("attachments", "extract")
    const needs = v.parse(
      listEnvelopeSchema(attachment),
      json(await call("attachments", "list", "is:needs_text", "--json")),
    )
    expect(needs.page).toMatchObject({ has_more: false })
    expect(needs.items.map(({ message }) => message)).toEqual(["msg:chat/500/7/5", "msg:chat/500/7/4"])
    expect(needs.items[1]).toMatchObject({
      position: 1,
      name: "blank.pdf",
      extraction: { origin: "extracted", chars: 0, error: "no_text" },
    })
    expect(json(await call("attachments", "list", "is:needs_text", "name:blank*", "--json")).items).toHaveLength(1)
    expect(json(await call("attachments", "list", "-is:needs_text", "name:blank*", "--json")).items).toEqual([])

    const textFile = join(root, "read.txt")
    writeFileSync(textFile, "Акт сверки за март")
    const kept = json(await call("attachments", "update", "Work fixture", "4", "--text-file", textFile, "--json"))
    expect(kept).toEqual({
      ref: "msg:chat/500/7/4",
      attachment: 1,
      origin: "agent",
      chars: 18,
      replaced: "extracted",
    })
    const fromStdin = await piped("Фото доски: план релиза")("attachments", "update", "msg:chat/500/7/5", "--json")
    expect(json(fromStdin)).toMatchObject({ ref: "msg:chat/500/7/5", replaced: "extracted" })
    expect(fromStdin.stderr).not.toContain("релиза")

    expect(await hits(call, "content:сверки")).toEqual(["4"])
    expect(await hits(call, 'content:"план релиза"')).toEqual(["5"])
    expect(json(await call("attachments", "list", "is:needs_text", "--json")).items).toEqual([])
    expect(json(await call("attachments", "list", 'chat:"Work fixture"', "--limit", "2", "--json"))).toMatchObject({
      page: { limit: 2, has_more: true },
    })

    await call("attachments", "extract")
    expect(await hits(call, "content:сверки")).toEqual(["4"])
  })

  it("refuses empty text, a message the store lacks, an unknown file number, another account and read-only", async () => {
    const { piped, env } = await setup()
    expect((await piped("  ")("attachments", "update", "7", "4")).stderr).toContain("empty")
    expect((await piped("x")("attachments", "update", "7", "99")).code).toBe(6)
    expect((await piped("x")("attachments", "update", "7", "4", "--attachment", "2")).stderr).toContain(
      "no file number 2",
    )
    expect((await piped("x")("attachments", "update", "msg:chat/501/7/4")).stderr).toContain("another account")
    expect((await piped("x")("attachments", "update", "7")).stderr).toContain("which message")
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.messages.saveMessages(OWNER, "7", [message("8", [{ kind: "photo" }, { kind: "photo" }])], {
      via: "history",
    })
    await store.close()
    expect((await piped("x")("attachments", "update", "7", "8")).stderr).toContain("has 2 files")
    expect(json(await piped("x")("attachments", "update", "7", "8", "--attachment", "2", "--json"))).toMatchObject({
      attachment: 2,
    })
    const locked = await setup({
      config: { profiles: { default: { permissions: { "attachments.update": "readonly" } } } },
    })
    expect((await locked.piped("x")("attachments", "update", "7", "4")).code).toBe(5)
  })
})

describe("a search hit's files", () => {
  it("names the files on a hit, by the position the other commands take", async () => {
    const { call, env } = await setup()
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.messages.saveMessages(
      OWNER,
      "7",
      [
        message("9", [
          { kind: "webpage", url: "https://example.org" },
          { kind: "file", name: "terms.pdf", size: 2048 },
        ]),
      ],
      { via: "history" },
    )
    await store.close()
    const found = json(await call("search", "messages", "message", "--json")).items
    const byId = (list: { ref: string; untrusted?: string[] }[], id: string) =>
      list.find(({ ref }) => ref.endsWith(`/${id}`))
    expect(byId(found, "9")).toMatchObject({
      attachments: [{ position: 2, kind: "file", name: "terms.pdf", size: 2048 }],
    })
    expect(byId(found, "1")).toMatchObject({ attachments: [{ position: 1, kind: "file", name: "notes.txt" }] })
    expect(byId(found, "9")?.untrusted).toContain("attachments.name")
    for (const hit of found) v.parse(ENTITIES["message.hit"], hit)
    const all = json(await call("search", "all", "message", "--json")).items
    expect(byId(all, "9")).toMatchObject({ attachments: [{ position: 2, name: "terms.pdf" }] })
    for (const hit of all) v.parse(ENTITIES.hit, hit)
  })

  it("--offline copies a held file by its locator and leaves the store pointing at its own copy", async () => {
    const { call, root, files } = await setup()
    const into = join(root, "out")
    const done = await call("messages", "download", "msg:chat/500/7/1", "--offline", "--output-dir", into, "--json")
    expect(done.code).toBe(0)
    const answer = json(done)
    v.parse(ENTITIES.message_download, answer)
    expect(answer.files).toEqual([{ kind: "file", path: join(into, "notes.txt"), bytes: SECRET.length + 10 }])
    expect(readFileSync(join(into, "notes.txt"), "utf8")).toBe(`${SECRET} for March`)
    const listed = json(await call("attachments", "list", "--json")).items
    expect(listed.find(({ message }: { message: string }) => message.endsWith("/1"))?.local_path).toBe(
      join(files, "notes.txt"),
    )
    const again = await call("messages", "download", "7", "1", "--attachment", "1", "--offline", "--output-dir", into)
    expect(again.stderr).toContain("already exists")
  })

  it("--offline refuses a file not saved here, a wrong position, another account, --all and --attachment online", async () => {
    const { call, root } = await setup()
    const into = join(root, "out")
    const missing = await call("messages", "download", "msg:chat/500/7/7", "--offline", "--output-dir", into)
    expect(missing.code).toBe(6)
    expect(missing.stderr).toContain("not saved on this computer")
    expect(existsSync(into)).toBe(false)
    expect((await call("messages", "download", "7", "1", "--attachment", "2", "--offline")).stderr).toContain(
      "no file at position 2",
    )
    expect((await call("messages", "download", "msg:chat/501/7/1", "--offline")).stderr).toContain("another account")
    expect((await call("messages", "download", "7", "--all", "--offline")).stderr).toContain("leave out --all")
    expect((await call("messages", "download", "7", "1", "--attachment", "1")).stderr).toContain("add --offline")
  })

  it("downloads by locator over the network as by chat and id", async () => {
    const { call, root } = await setup()
    const into = join(root, "net")
    const done = await call("messages", "download", "msg:chat/500/7/7", "--output-dir", into, "--json")
    expect(done.code).toBe(0)
    expect(json(done).files).toEqual([expect.objectContaining({ path: join(into, "fetched.txt") })])
    expect((await call("messages", "download", "msg:other/500/7/7")).stderr).toContain("another messenger")
  })

  it("messages link lists the message's files, each with no link of its own", async () => {
    const { call } = await setup()
    const linked = json(await call("messages", "link", "msg:chat/500/7/1", "--offline", "--json"))
    v.parse(ENTITIES.message_link, linked)
    expect(linked).toMatchObject({
      ref: "msg:chat/500/7/1",
      url: null,
      reason: "offline",
      files: [{ position: 1, kind: "file", name: "notes.txt", url: null, reason: "unsupported_provider" }],
    })
  })
})
