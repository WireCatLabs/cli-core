import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CAPTION_CHARS, deliver, headOf, type Parcel, parseRoute } from "./deliver.js"
import type { Ran, RunOptions, ServerSystem } from "./system.js"

const sender = (answer: Partial<Ran> = {}) => {
  const sent: { argv: string[]; env: NodeJS.ProcessEnv; options?: RunOptions; file?: string }[] = []
  const system: ServerSystem = {
    platform: "linux",
    uid: 501,
    entry: [],
    spawn: () => 0,
    pause: async () => {},
    run: async (argv, env, options) => {
      const at = argv.indexOf("--file")
      sent.push({
        argv,
        env,
        ...(options ? { options } : {}),
        ...(at > 0 ? { file: readFileSync(argv[at + 1] ?? "", "utf8") } : {}),
      })
      return { code: 0, stdout: "", stderr: "", ...answer }
    },
  }
  return { system, sent }
}

const found = { find: (name: string) => `/bin/${name}`, errorOf: (_: string, code: number) => `exit ${code}` }

const report = (text: string): Parcel => {
  const path = join(mkdtempSync(join(tmpdir(), "deliver-")), "run.md")
  writeFileSync(path, text)
  return { title: "memo digest · 2026-11-06 08:30", file: { path, name: "digest-2026-11-06-08-30.md" } }
}

describe("a route", () => {
  it.each([
    ["telegram-bot:personal/user:123", { kind: "telegram-bot", profile: "personal", chat: "user:123" }],
    ["telegram-bot:alerts/-1001234", { kind: "telegram-bot", profile: "alerts", chat: "-1001234" }],
    ["email:work/me@example.com", { kind: "email", profile: "work", address: "me@example.com" }],
  ])("reads %s", (text, route) => {
    expect(parseRoute(text)).toEqual(route)
  })

  it.each([
    "telegram-bot:personal/Family chat",
    "telegram:personal/user:1",
    "email:work/a@example.com,b@example.com",
    "email:../x/me@example.com",
    "email:work",
  ])("refuses %s", (text) => {
    expect(() => parseRoute(text)).toThrow(/telegram-bot:<profile>/)
  })
})

describe("delivery", () => {
  it("sends a short report as one bot message, its text after --", async () => {
    const { system, sent } = sender()
    const env = { PATH: "/bin", TG_PROFILE: "other", MEMO_READ_ONLY: undefined }
    const done = await deliver(system, env, ["telegram-bot:personal/user:123"], report("--json and more\n"), found)

    expect(done).toEqual([{ to: "telegram-bot:personal/user:123", ok: true }])
    expect(sent[0]?.argv).toEqual([
      "/bin/tg",
      "personal",
      "--json",
      "--no-input",
      "bot",
      "messages",
      "send",
      "--",
      "user:123",
      "memo digest · 2026-11-06 08:30\n--json and more",
    ])
    expect(sent[0]?.env.TG_PROFILE).toBeUndefined()
  })

  it("sends a long report as a file with its head as the caption, and leaves no copy behind", async () => {
    const { system, sent } = sender()
    const long = Array.from({ length: 200 }, (_, n) => `line ${n} of the morning digest`).join("\n")
    await deliver(system, {}, ["telegram-bot:personal/user:123"], report(long), found)

    const argv = sent[0]?.argv ?? []
    const copy = argv[argv.indexOf("--file") + 1] ?? ""
    expect(copy.endsWith("digest-2026-11-06-08-30.md")).toBe(true)
    expect(sent[0]?.file).toBe(long)
    expect(existsSync(copy)).toBe(false)
    const caption = argv.at(-1) ?? ""
    expect(caption.length).toBeLessThanOrEqual(CAPTION_CHARS)
    expect(caption).toMatch(/^memo digest · 2026-11-06 08:30\nline 0 of/)
    expect(caption.endsWith("… the whole report is in the file")).toBe(true)
  })

  it("mails the whole report on stdin, with the title as the subject", async () => {
    const { system, sent } = sender()
    await deliver(system, {}, ["email:work/me@example.com"], report("# Today\nthree things\n"), found)

    expect(sent[0]?.argv).toEqual([
      "/bin/mail",
      "work",
      "--json",
      "--no-input",
      "messages",
      "send",
      "--to",
      "me@example.com",
      "--subject",
      "memo digest · 2026-11-06 08:30",
    ])
    expect(sent[0]?.options?.input).toBe("# Today\nthree things\n")
  })

  it("sends a failed run's one line and no file", async () => {
    const { system, sent } = sender()
    const line = "memo digest failed at 2026-11-06 08:30 (exit 1): auth_failed (credentials.unreachable)"
    await deliver(
      system,
      {},
      ["telegram-bot:personal/user:1", "email:work/me@example.com"],
      { title: "t", line },
      found,
    )

    expect(sent[0]?.argv.at(-1)).toBe(`t\n${line}`)
    expect(sent[0]?.argv).not.toContain("--file")
    expect(sent[1]?.options?.input).toBe(line)
  })

  it("sends nothing from a locked run or past a locked sending CLI, and says which lock", async () => {
    const { system, sent } = sender()
    const parcel = report("x")
    expect(
      await deliver(system, {}, ["email:work/me@example.com"], parcel, { ...found, locked: "MEMO_READ_ONLY" }),
    ).toEqual([{ to: "email:work/me@example.com", ok: false, reason: "delivery.read-only", error: "MEMO_READ_ONLY" }])
    expect(await deliver(system, { TG_READ_ONLY: "1" }, ["telegram-bot:p/user:1"], parcel, found)).toEqual([
      { to: "telegram-bot:p/user:1", ok: false, reason: "delivery.read-only", error: "TG_READ_ONLY" },
    ])
    expect(sent).toEqual([])
  })

  it("records each failed route by a dotted reason and goes on to the next", async () => {
    const failing = sender({ code: 2, stderr: "token 123:ABC refused\n" })
    const errorOf = (stderr: string, code: number) => (stderr.includes("{") ? "never" : `exit ${code}`)
    const done = await deliver(
      failing.system,
      {},
      ["fax:p/1", "telegram-bot:p/user:1", "email:work/me@example.com"],
      report("x"),
      { find: (name) => (name === "tg" ? "/bin/tg" : undefined), errorOf },
    )

    expect(done).toEqual([
      { to: "fax:p/1", ok: false, reason: "delivery.route-invalid" },
      { to: "telegram-bot:p/user:1", ok: false, reason: "delivery.failed", error: "exit 2" },
      { to: "email:work/me@example.com", ok: false, reason: "delivery.program-missing", error: "mail" },
    ])
    expect(JSON.stringify(done)).not.toContain("ABC")
    const timedOut = sender({ code: 124 })
    expect((await deliver(timedOut.system, {}, ["telegram-bot:p/user:1"], report("x"), found))[0]?.reason).toBe(
      "delivery.timeout",
    )
  })
})

describe("the caption", () => {
  it("keeps a short report whole and cuts a long one where a line ends", () => {
    expect(headOf("t", "  one\ntwo  ")).toBe("t\none\ntwo")
    const cut = headOf("t", `${"a".repeat(60)}\n${"b".repeat(60)}`, 100)
    expect(cut).toBe(`t\n${"a".repeat(60)}\n… the whole report is in the file`)
  })
})
