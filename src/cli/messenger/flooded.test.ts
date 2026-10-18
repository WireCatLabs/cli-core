import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { FloodMemory } from "../../sends/flood.js"
import { Pacer } from "../../sends/pace.js"
import { flooded } from "./flooded.js"

const wait = (seconds: number) =>
  new CliError("rate_limited", `wait ${seconds} s`, { retry_after_ms: seconds * 1000, provider_error: "FLOOD_WAIT" })

const setup = (
  answers: Partial<
    Record<"history" | "send" | "watch" | "feed" | "listen" | "listenHistory", () => Promise<unknown>>
  > = {},
) => {
  const memory = new FloodMemory(join(mkdtempSync(join(tmpdir(), "flooded-")), "p.json"))
  const inner = {
    self: () => "1",
    history: vi.fn(answers.history ?? (async () => ({ items: [] }))),
    send: vi.fn(answers.send ?? (async () => ({ message: { id: "5" }, sendId: "9" }))),
    watch: vi.fn(answers.watch ?? (async () => {})),
    feed: vi.fn(answers.feed ?? (async () => {})),
    listen: vi.fn(answers.listen ?? (async () => {})),
    listenHistory: vi.fn(answers.listenHistory ?? (async () => {})),
  }
  const warnings: string[] = []
  const adapter = flooded(inner as unknown as MessengerAdapter, memory, {
    name: "Chat",
    warn: (line) => warnings.push(line),
  })
  return { adapter, inner, memory, warnings }
}

describe("a call the messenger asked to hold off on", () => {
  it("**is refused without asking again, with the time left**, once a wait was answered", async () => {
    const { adapter, inner, memory, warnings } = setup({ history: () => Promise.reject(wait(300)) })

    await expect(adapter.history?.("42", { limit: 1 })).rejects.toMatchObject({ code: "rate_limited" })
    expect(memory.owed("history", "42")).toMatchObject({ operation: "history", chatId: "42" })
    expect(warnings[0]).toMatch(/^Chat asked to wait before history again — until /)

    const refused = adapter.history?.("42", { limit: 1 })
    await expect(refused).rejects.toMatchObject({
      code: "rate_limited",
      details: { remembered: true, provider_error: "FLOOD_WAIT", retry_after_ms: expect.any(Number) },
    })
    await expect(refused).rejects.toThrow(/nothing was sent to Chat/)
    expect(inner.history).toHaveBeenCalledTimes(1)
  })

  it("keeps a chat by id only — a typed name may be a title", async () => {
    const { adapter, memory } = setup({ history: () => Promise.reject(wait(60)) })

    await expect(adapter.history?.("Mum", { limit: 1 })).rejects.toThrow()
    expect(memory.read().deadlines).toEqual([expect.not.objectContaining({ chatId: expect.anything() })])
  })

  it("**never repeats a send**: the caller repeats it, with its own send id", async () => {
    const { adapter, inner } = setup({ send: () => Promise.reject(wait(5)) })

    await expect(adapter.send("42", "hi", { sendId: "9" })).rejects.toMatchObject({ code: "rate_limited" })
    await expect(adapter.send("42", "hi", { sendId: "9" })).rejects.toMatchObject({ details: { remembered: true } })
    expect(inner.send).toHaveBeenCalledTimes(1)
  })

  it("a refusal saying the account may not write holds every write; other errors are left alone", async () => {
    const frozen = new CliError("permission_error", "frozen", { standing: { state: "frozen", hint: "it is frozen" } })
    const { adapter, memory, warnings } = setup({ send: () => Promise.reject(frozen) })

    await expect(adapter.send("42", "hi", { sendId: "9" })).rejects.toBe(frozen)
    expect(memory.sendBlock()).toMatchObject({ state: "frozen", hint: "it is frozen" })
    expect(memory.read().deadlines).toEqual([])
    expect(warnings[0]).toMatch(/^writes from this profile are held until .*: it is frozen$/)
  })

  it("**a ban with no end holds writes until lifted**, and the warning says so", async () => {
    const banned = new CliError("permission_error", "banned", { standing: { state: "banned", hint: "it is banned" } })
    const { adapter, memory, warnings } = setup({ send: () => Promise.reject(banned) })

    await expect(adapter.send("42", "hi", { sendId: "9" })).rejects.toBe(banned)
    expect(memory.sendBlock()).toMatchObject({ state: "banned", until: null })
    expect(warnings).toEqual(["writes from this profile are held until lifted: it is banned"])
  })

  it("**a ban that ends a watch still holds the profile's writes**", async () => {
    const banned = new CliError("permission_error", "banned", { standing: { state: "banned", hint: "it is banned" } })
    const { adapter, memory } = setup({ watch: () => Promise.reject(banned) })

    await expect(adapter.watch?.(() => {}, new AbortController().signal)).rejects.toBe(banned)
    expect(memory.sendBlock()).toMatchObject({ state: "banned" })
  })

  it("a wait that ends a feed is remembered, and a remembered one never stops the next feed", async () => {
    const { adapter, inner, memory } = setup({ feed: () => Promise.reject(wait(60)) })

    await expect(adapter.feed?.(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "rate_limited" })
    expect(memory.read().deadlines).toMatchObject([{ operation: "feed" }])
    await expect(adapter.feed?.(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "rate_limited" })
    expect(inner.feed).toHaveBeenCalledTimes(2)
  })

  it("a listen runs while a remembered wait holds the profile, as it only receives", async () => {
    const { adapter, inner } = setup({
      history: () => Promise.reject(wait(60)),
      listen: () => Promise.reject(wait(60)),
    })

    await expect(adapter.history?.("42", { limit: 1 })).rejects.toMatchObject({ code: "rate_limited" })
    await expect(adapter.listen?.(() => {}, new AbortController().signal)).rejects.toMatchObject({
      code: "rate_limited",
    })
    await expect(adapter.listen?.(() => {}, new AbortController().signal)).rejects.toMatchObject({
      code: "rate_limited",
    })
    expect(inner.listen).toHaveBeenCalledTimes(2)
  })

  it("a history listen runs while a remembered wait holds the profile, as it only receives", async () => {
    const { adapter, inner } = setup({
      history: () => Promise.reject(wait(60)),
      listenHistory: () => Promise.reject(wait(60)),
    })

    await expect(adapter.history?.("42", { limit: 1 })).rejects.toMatchObject({ code: "rate_limited" })
    for (let turn = 0; turn < 2; turn += 1)
      await expect(adapter.listenHistory?.(() => {}, new AbortController().signal)).rejects.toMatchObject({
        code: "rate_limited",
      })
    expect(inner.listenHistory).toHaveBeenCalledTimes(2)
  })

  it("a remembered wait that cannot be written warns, and the messenger's own error still comes through", async () => {
    const failure = wait(60)
    const { adapter, memory, warnings } = setup({ history: () => Promise.reject(failure) })
    vi.spyOn(memory, "remember").mockImplementation(() => {
      throw new Error("read-only")
    })

    await expect(adapter.history?.("42", { limit: 1 })).rejects.toBe(failure)
    expect(warnings).toEqual(["could not remember Chat's wait (read-only)"])
  })
})

describe("the profile's pace", () => {
  const paced = (path: string, answers: Parameters<typeof setup>[0] = {}) => {
    const built = setup(answers)
    const pacer = new Pacer(path, { perMinute: 6_000, burst: 1 })
    return {
      ...built,
      adapter: flooded(built.inner as unknown as MessengerAdapter, built.memory, {
        name: "Chat",
        warn: () => {},
        pacer,
      }),
    }
  }

  it("spaces calls past the burst, across two adapters on one profile", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "paced-")), "pace.json")
    const one = paced(path)
    const two = paced(path)
    const started = Date.now()
    await Promise.all(
      [1, 2, 3].flatMap(() => [one.adapter.history?.("1", { limit: 1 }), two.adapter.history?.("2", { limit: 1 })]),
    )

    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
  })

  it("refuses at once while a wait the messenger asked for holds the profile longer than a run waits", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "paced-")), "pace.json")
    const flood = paced(path, { history: () => Promise.reject(wait(600)) })
    await expect(flood.adapter.history?.("1", { limit: 1 })).rejects.toMatchObject({ code: "rate_limited" })
    const other = paced(path)

    await expect(other.adapter.send?.("2", "hi", { sendId: "1" } as never)).rejects.toMatchObject({
      code: "rate_limited",
      details: { remembered: true },
    })
    expect(other.inner.send).not.toHaveBeenCalled()
  })
})
