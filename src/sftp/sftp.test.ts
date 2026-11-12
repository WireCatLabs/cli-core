import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { Duplex } from "node:stream"
import { CliError, isCliError, type SleepLike } from "@wirecat/cli-base"
import { type Connection, Server, utils } from "ssh2"
import { afterEach, describe, expect, it } from "vitest"
import type { RequestEvent } from "../runs/events.js"
import { openSftp, type SftpOptions, sftpHostKey } from "./index.js"

const { STATUS_CODE } = utils.sftp

/**
 * Two connected streams with no network. Node's `duplexPair` hands a write to the other side in the same tick, and
 * ssh2 then reads the client's next key-exchange packet before it has finished the one it is answering.
 */
const socketPair = (): [Duplex, Duplex] => {
  const ends: Duplex[] = []
  const end = (other: () => Duplex) =>
    new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        setImmediate(() => other().push(chunk))
        done()
      },
      final(done) {
        setImmediate(() => other().push(null))
        done()
      },
      destroy(error, done) {
        setImmediate(() => other().destroy())
        done(error)
      },
    })
  ends.push(
    end(() => ends[1] as Duplex),
    end(() => ends[0] as Duplex),
  )
  return [ends[0] as Duplex, ends[1] as Duplex]
}
const PASSWORD = "secret-marker-7f3a"

const hostKeys = utils.generateKeyPairSync("ed25519")
const blob = (publicKey: string) => {
  const parsed = utils.parseKey(publicKey)
  if (parsed instanceof Error) throw parsed
  return (Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH()
}
const FINGERPRINT = `SHA256:${createHash("sha256").update(blob(hostKeys.public)).digest("base64").replace(/=+$/, "")}`
const OTHER = utils.generateKeyPairSync("ed25519")
const clientKeys = utils.generateKeyPairSync("ed25519")

const MTIME = Date.UTC(2026, 10, 12, 10, 0, 0) / 1000
const recording = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 251))
const FILES: Record<string, Buffer> = {
  "/rec/out-89161234567.wav": recording,
  "/rec/small.txt": Buffer.from("hello"),
}
const DIRS = new Set(["/", "/rec", "/rec/empty"])
const FILE_MODE = 0o100644
const DIR_MODE = 0o040755

const attrsOf = (path: string) => ({
  mode: DIRS.has(path) ? DIR_MODE : FILE_MODE,
  uid: 0,
  gid: 0,
  size: FILES[path]?.length ?? 4096,
  atime: MTIME,
  mtime: MTIME,
})

interface Behaviour {
  /** Connections to drop before the SSH greeting, as a busy server does. */
  dropFirst?: number
  /** Leaves this SFTP request unanswered. */
  silent?: "STAT" | "OPENDIR"
  /** A different host key than the pinned one. */
  otherKey?: boolean
  acceptKey?: boolean
}

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

const serve = (behaviour: Behaviour = {}) => {
  const seen = { connections: 0, authAttempts: 0, closed: 0, passwords: [] as string[] }
  const server = new Server({ hostKeys: [behaviour.otherKey ? OTHER.private : hostKeys.private] }, (client) =>
    session(client, behaviour, seen),
  )
  servers.push(server)
  const socket = () => {
    seen.connections += 1
    const [ours, theirs] = socketPair()
    if (seen.connections <= (behaviour.dropFirst ?? 0)) {
      theirs.end()
      return ours
    }
    theirs.on("close", () => {
      seen.closed += 1
    })
    server.injectSocket(theirs as never)
    return ours
  }
  return { socket, seen }
}

const session = (client: Connection, behaviour: Behaviour, seen: { authAttempts: number; passwords: string[] }) => {
  client.on("error", () => {})
  client.on("authentication", (context) => {
    seen.authAttempts += 1
    if (context.method === "password") {
      seen.passwords.push(context.password)
      return context.password === PASSWORD ? context.accept() : context.reject()
    }
    if (context.method === "publickey" && behaviour.acceptKey) {
      const ours = context.key.data.equals(blob(clientKeys.public))
      return ours ? context.accept() : context.reject()
    }
    context.reject(["password", "publickey"])
  })
  client.on("ready", () =>
    client.on("session", (accept) =>
      accept().on("sftp", (open) => {
        const sftp = open()
        const handles = new Map<number, { path: string; listed?: boolean }>()
        let next = 1
        const handleOf = (path: string, extra = {}) => {
          const id = next++
          handles.set(id, { path, ...extra })
          const handle = Buffer.alloc(4)
          handle.writeUInt32BE(id)
          return handle
        }
        const stateOf = (handle: Buffer) => handles.get(handle.readUInt32BE(0))
        const stat = (id: number, path: string) => {
          if (behaviour.silent === "STAT") return
          if (!DIRS.has(path) && !FILES[path]) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE)
          if (path === "/secret") return sftp.status(id, STATUS_CODE.PERMISSION_DENIED)
          sftp.attrs(id, attrsOf(path))
        }
        sftp.on("STAT", stat)
        sftp.on("LSTAT", stat)
        sftp.on("OPENDIR", (id, path) => {
          if (behaviour.silent === "OPENDIR") return
          if (path === "/secret") return sftp.status(id, STATUS_CODE.PERMISSION_DENIED)
          if (!DIRS.has(path)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE)
          sftp.handle(id, handleOf(path))
        })
        sftp.on("READDIR", (id, handle) => {
          const state = stateOf(handle)
          if (!state || state.listed) return sftp.status(id, STATUS_CODE.EOF)
          state.listed = true
          const children = [...DIRS, ...Object.keys(FILES)].filter((one) => one !== "/" && dirname(one) === state.path)
          const names = [
            ...[".", ".."].map((filename) => ({ filename, longname: filename, attrs: attrsOf(state.path) })),
            ...children.map((one) => ({ filename: basename(one), longname: basename(one), attrs: attrsOf(one) })),
          ]
          sftp.name(id, names)
        })
        sftp.on("OPEN", (id, path) => {
          if (!FILES[path] && !DIRS.has(path)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE)
          sftp.handle(id, handleOf(path))
        })
        sftp.on("FSTAT", (id, handle) => sftp.attrs(id, attrsOf(stateOf(handle)?.path ?? "")))
        sftp.on("READ", (id, handle, offset, length) => {
          const data = FILES[stateOf(handle)?.path ?? ""] ?? Buffer.alloc(0)
          if (offset >= data.length) return sftp.status(id, STATUS_CODE.EOF)
          // Half of what was asked, at most, to exercise short reads.
          sftp.data(id, data.subarray(offset, offset + Math.min(length, 20_000)))
        })
        sftp.on("CLOSE", (id, handle) => {
          handles.delete(handle.readUInt32BE(0))
          sftp.status(id, STATUS_CODE.OK)
        })
        sftp.on("REALPATH", (id, path) => sftp.name(id, [{ filename: path, longname: path, attrs: attrsOf(path) }]))
      }),
    ),
  )
}

/** Retries wait for nothing; a deadline passes only for the timeout a test names. */
const clock = (expiring?: number) => {
  const waits: { ms: number; reason?: string }[] = []
  const sleep: SleepLike = (ms, signal, reason) => {
    waits.push({ ms, ...(reason ? { reason } : {}) })
    if (reason !== "timeout" || ms === expiring) return Promise.resolve()
    return new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    )
  }
  return { sleep, waits }
}

const connect = (server: ReturnType<typeof serve>, extra: Partial<SftpOptions> = {}) => {
  const events: RequestEvent[] = []
  const time = clock(extra.operationTimeoutMs)
  const options: SftpOptions = {
    host: "pbx.example",
    username: "recordings",
    auth: { password: PASSWORD },
    hostKey: FINGERPRINT,
    socket: server.socket,
    events: (event) => events.push(event),
    sleep: time.sleep,
    random: () => 0.5,
    ...extra,
  }
  return { open: () => openSftp(options), events, waits: time.waits }
}

const failure = async (promise: Promise<unknown>): Promise<CliError> => {
  try {
    await promise
  } catch (error) {
    if (isCliError(error)) return error
    throw error
  }
  throw new Error("expected a failure")
}

describe("openSftp", () => {
  it("lists, stats and reads files, tracing each operation without a path", async () => {
    const server = serve()
    const { open, events } = connect(server)
    const client = await open()

    const listed = await client.list("/rec")
    expect(listed.map((one) => [one.name, one.kind])).toEqual([
      ["empty", "directory"],
      ["out-89161234567.wav", "file"],
      ["small.txt", "file"],
    ])
    expect(listed[1]).toMatchObject({ size: recording.length, modifiedAt: "2026-11-12T10:00:00.000Z" })
    expect(await client.stat("/rec/small.txt")).toEqual({
      name: "small.txt",
      kind: "file",
      size: 5,
      modifiedAt: "2026-11-12T10:00:00.000Z",
    })
    expect(Buffer.from(await client.readFile("/rec/out-89161234567.wav", { maxBytes: 1_000_000 }))).toEqual(recording)
    expect(Buffer.from(await client.readFile("/rec/small.txt", { maxBytes: 5 })).toString()).toBe("hello")
    await client.close()

    expect(events.filter((one) => one.event === "response").map((one) => [one.operation, one.outcome])).toEqual([
      ["sftp.connect", "ok"],
      ["sftp.list", "ok"],
      ["sftp.stat", "ok"],
      ["sftp.read", "ok"],
      ["sftp.read", "ok"],
    ])
    expect(events.find((one) => one.operation === "sftp.list" && one.event === "response")).toMatchObject({
      transport: "sftp",
      level: "wire",
      attempt: 1,
      ids: { host: "pbx.example" },
      counts: { entries: 3 },
    })
    expect(events.find((one) => one.operation === "sftp.read")).toBeDefined()
    const trace = JSON.stringify(events)
    expect(trace).not.toContain("89161234567")
    expect(trace).not.toContain("/rec")
    expect(trace).not.toContain(PASSWORD)
    await expect.poll(() => server.seen.closed).toBe(1)
  })

  it("signs in with a private key", async () => {
    const server = serve({ acceptKey: true })
    const client = await connect(server, { auth: { privateKey: clientKeys.private } }).open()
    expect((await client.stat("/rec")).kind).toBe("directory")
    await client.close()
  })

  it("refuses a file larger than maxBytes before reading it", async () => {
    const { open } = connect(serve())
    const client = await open()
    const error = await failure(client.readFile("/rec/out-89161234567.wav", { maxBytes: 1000 }))
    expect(error).toMatchObject({ code: "validation_error", details: { reason: "sftp.too-large", max_bytes: 1000 } })
    expect(error.message).not.toContain("89161234567")
    await client.close()
  })

  it("maps a missing file, a denied path and a folder read without retrying", async () => {
    const server = serve()
    const { open, waits } = connect(server)
    const client = await open()
    expect(await failure(client.stat("/rec/gone.wav"))).toMatchObject({
      code: "not_found",
      details: { reason: "file.not-found" },
    })
    expect(await failure(client.list("/secret"))).toMatchObject({
      code: "permission_error",
      details: { reason: "file.denied" },
    })
    expect(await failure(client.readFile("/rec", { maxBytes: 10 }))).toMatchObject({
      details: { reason: "file.not-a-file" },
    })
    expect(waits.filter((one) => one.reason === "retry")).toEqual([])
    expect(server.seen.connections).toBe(1)
    await client.close()
  })

  it("refuses a host key that is not the pinned one before sending a credential", async () => {
    const server = serve({ otherKey: true })
    const { open, waits } = connect(server)
    const error = await failure(open())
    expect(error).toMatchObject({ code: "authentication_error", details: { reason: "sftp.host-key-mismatch" } })
    expect(error.message).toContain("ssh-ed25519 SHA256:")
    expect(server.seen.authAttempts).toBe(0)
    expect(server.seen.connections).toBe(1)
    expect(waits.filter((one) => one.reason === "retry")).toEqual([])
  })

  it("refuses to connect without a pinned host key or a credential", async () => {
    const server = serve()
    expect(await failure(connect(server, { hostKey: "" }).open())).toMatchObject({
      code: "configuration_error",
      details: { reason: "sftp.host-key-missing" },
    })
    expect(await failure(connect(server, { auth: { password: "" } }).open())).toMatchObject({
      details: { reason: "sftp.auth-missing" },
    })
    expect(server.seen.connections).toBe(0)
  })

  it("refuses an unreadable private key before connecting, without quoting it", async () => {
    const server = serve()
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-key-marker\n-----END OPENSSH PRIVATE KEY-----"
    const error = await failure(connect(server, { auth: { privateKey: key } }).open())
    expect(error).toMatchObject({ code: "configuration_error", details: { reason: "sftp.key-invalid" } })
    expect(error.message).not.toContain("not-a-key-marker")
    expect(server.seen.connections).toBe(0)
  })

  it("does not retry a refused password, and keeps it out of the error and the trace", async () => {
    const server = serve()
    const { open, events, waits } = connect(server, { auth: { password: "not-the-password" } })
    const error = await failure(open())
    expect(error).toMatchObject({ code: "authentication_error", details: { reason: "auth.failed" } })
    expect(server.seen.connections).toBe(1)
    expect(waits.filter((one) => one.reason === "retry")).toEqual([])
    expect(JSON.stringify({ message: error.message, details: error.details, events })).not.toContain("not-the-password")
  })

  it("retries a dropped connection with backoff over a fresh connection", async () => {
    const server = serve({ dropFirst: 2 })
    const { open, events, waits } = connect(server)
    const client = await open()
    expect((await client.stat("/rec")).kind).toBe("directory")
    await client.close()
    expect(server.seen.connections).toBe(3)
    expect(waits.filter((one) => one.reason === "retry").map((one) => one.ms)).toEqual([250, 500])
    expect(
      events.filter((one) => one.operation === "sftp.connect" && one.event === "response").map((one) => one.outcome),
    ).toEqual(["error", "error", "ok"])
    expect(events.filter((one) => one.event === "request" && one.operation === "sftp.connect").at(-1)).toMatchObject({
      attempt: 3,
      waitMs: 500,
    })
  })

  it("gives up after the retries with the attempts counted", async () => {
    const server = serve({ dropFirst: 10 })
    const error = await failure(connect(server).open())
    expect(error).toMatchObject({ code: "network_error", details: { retryable: true, attempts: 3 } })
    expect(server.seen.connections).toBe(3)
  })

  it("times out an unanswered request, closes that connection and retries on a new one", async () => {
    const server = serve({ silent: "STAT" })
    const { open, events } = connect(server, { operationTimeoutMs: 7000 })
    const client = await open()
    const error = await failure(client.stat("/rec"))
    expect(error).toMatchObject({ code: "timeout", details: { reason: "sftp.timeout", attempts: 3 } })
    expect(server.seen.connections).toBe(3)
    expect(events.filter((one) => one.operation === "sftp.stat" && one.event === "response")).toHaveLength(3)
    await client.close()
  })

  it("stops on the run's signal and closes the connection", async () => {
    const server = serve({ silent: "OPENDIR" })
    const controller = new AbortController()
    const client = await connect(server, { signal: controller.signal }).open()
    const listing = client.list("/rec")
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    expect(await failure(listing)).toMatchObject({ code: "cancelled" })
    await expect.poll(() => server.seen.closed).toBe(1)
    expect(server.seen.connections).toBe(1)
    await client.close()
  })

  it("keeps the runner's own reason when it stops the run", async () => {
    const server = serve({ silent: "OPENDIR" })
    const controller = new AbortController()
    const client = await connect(server, { signal: controller.signal }).open()
    const listing = client.list("/rec")
    const reason = new CliError("timeout", "the command ran past its deadline", { reason: "command.timed-out" })
    controller.abort(reason)
    expect(await failure(listing)).toBe(reason)
    await client.close()
  })
})

describe("sftpHostKey", () => {
  it("returns the server's key without signing in", async () => {
    const server = serve()
    expect(await sftpHostKey({ host: "pbx.example", socket: server.socket, sleep: clock().sleep })).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: FINGERPRINT,
    })
    expect(server.seen.authAttempts).toBe(0)
  })

  it("is the fingerprint that openSftp accepts, with or without its prefix", async () => {
    const server = serve()
    const client = await connect(server, { hostKey: FINGERPRINT.replace("SHA256:", "") }).open()
    await client.close()
  })
})

describe("the ssh2 boundary", () => {
  it("is imported only by the adapter (WC-ARCH-3)", () => {
    const root = join(import.meta.dirname, "..")
    const importers = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => /from "ssh2"|import\("ssh2"\)/.test(readFileSync(join(root, name), "utf8")))
    expect(importers).toEqual([join("sftp", "ssh2.ts")])
  })
})
