import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { GuardRequest, SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { adminService } from "./admin.js"
import { onlineDeps } from "./deps.js"

const chat = { id: "-1007", title: "synthetic group", kind: "group" as const }

const fixture = (capable = true) => {
  const records: Omit<SendEntry, "at" | "profile">[] = []
  const checked: GuardRequest[] = []
  const guard = {
    check: (attempt: GuardRequest) => checked.push(attempt),
    record: (entry) => records.push(entry),
  } as SendGuard
  const createInviteLink = vi.fn(async (_chatId: string, options: { approval: boolean; maxUses?: number }) => ({
    link: "https://t.me/+synthetic",
    approval: options.approval,
    expiresAt: null,
    maxUses: options.maxUses ?? null,
  }))
  const adapter = {
    resolve: async () => chat,
    ...(capable ? { createInviteLink } : {}),
  } as unknown as MessengerAdapter
  const deps = onlineDeps({ provider: "test" } as Messenger, adapter, guard)
  return { service: adminService(deps), deps, createInviteLink, records, checked }
}

describe("another invite link", () => {
  it("is made through the guard with a use limit and an expiry as an ISO minute", async () => {
    const f = fixture()
    const made = await f.service.createLink("synthetic group", { approval: false, expires: "7d", maxUses: 5 })
    expect(made).toMatchObject({ chatId: "-1007", link: "https://t.me/+synthetic", approval: false, maxUses: 5 })
    const [, options] = f.createInviteLink.mock.calls[0] ?? []
    expect(options).toMatchObject({ approval: false, maxUses: 5, expiresAt: expect.stringMatching(/:00\.000Z$/) })
    expect(f.checked).toEqual([expect.objectContaining({ chatId: "-1007", kind: "chat", action: "link.create" })])
    expect(f.records).toMatchObject([{ action: "link.create", outcome: "sent" }])
  })

  it("passes no expiry or limit when none is given", async () => {
    const f = fixture()
    await f.service.createLink("synthetic group", { approval: false })
    expect(f.createInviteLink).toHaveBeenCalledWith("-1007", { approval: false })
  })

  it.each([
    [{ maxUses: 0 }, "--max-uses takes a whole number from 1 to 99999"],
    [{ maxUses: 100_000 }, "--max-uses takes a whole number from 1 to 99999"],
    [{ approval: true, maxUses: 5 }, "a link that asks first takes no use limit"],
    [{ expires: "soon" }, "--expire-time takes a time like"],
    [{ expires: "2020-01-01T00:00" }, "--expire-time has to be at least a minute from now"],
  ])("refuses %j before connecting", async (options, message) => {
    const f = fixture()
    const connection = vi.fn(f.deps.connection)
    const service = adminService({ ...f.deps, connection })
    await expect(service.createLink("synthetic group", { approval: false, ...options })).rejects.toThrow(message)
    expect(connection).not.toHaveBeenCalled()
  })

  it("is refused offline, and by a messenger without extra links, recording nothing", async () => {
    const f = fixture()
    await expect(
      adminService({ ...f.deps, offline: true }).createLink("synthetic group", { approval: true }),
    ).rejects.toThrow("not with --offline")
    await expect(fixture(false).service.createLink("synthetic group", { approval: true })).rejects.toThrow(
      "cannot make another invite link",
    )
    expect(f.records).toEqual([])
  })
})

describe("listing and revoking invite links", () => {
  const link = { link: "https://t.me/+synthetic", approval: false, expiresAt: null, maxUses: null, pending: 1 }

  it("lists the owner's links, and revokes one through the guard", async () => {
    const f = fixture()
    const inviteLinks = vi.fn(async () => ({ items: [link], hasMore: false }))
    const revokeInviteLink = vi.fn(async () => ({ ...link, revoked: true }))
    const adapter = { resolve: async () => chat, inviteLinks, revokeInviteLink } as unknown as MessengerAdapter
    const service = adminService(onlineDeps({ provider: "test" } as Messenger, adapter, f.deps.guard))

    expect(await service.links("synthetic group", { limit: 5, revoked: true })).toEqual({
      chatId: "-1007",
      items: [link],
      hasMore: false,
    })
    expect(inviteLinks).toHaveBeenCalledWith("-1007", { limit: 5, revoked: true })
    expect(await service.revokeLink("synthetic group", " https://t.me/+synthetic ")).toMatchObject({ revoked: true })
    expect(revokeInviteLink).toHaveBeenCalledWith("-1007", "https://t.me/+synthetic")
    expect(f.records).toMatchObject([{ action: "link.revoke", outcome: "sent" }])
  })

  it("refuses a blank link, and a messenger that cannot list or revoke", async () => {
    const f = fixture()
    await expect(f.service.revokeLink("synthetic group", " ")).rejects.toThrow("which link")
    await expect(f.service.links("synthetic group", { limit: 5, revoked: false })).rejects.toThrow(
      "cannot list invite links",
    )
    await expect(f.service.revokeLink("synthetic group", "https://t.me/+x")).rejects.toThrow("cannot revoke")
  })
})

describe("changing an invite link", () => {
  const link = { link: "https://t.me/+synthetic", approval: false, expiresAt: null, maxUses: null }
  const fixtureWith = () => {
    const f = fixture()
    const updateInviteLink = vi.fn(async (_chatId: string, _link: string, change: object) => ({ ...link, ...change }))
    const connection = vi.fn(
      async () => ({ resolve: async () => chat, updateInviteLink }) as unknown as MessengerAdapter,
    )
    return { ...f, updateInviteLink, connection, service: adminService({ ...f.deps, connection }) }
  }

  it("sends only the fields given, through the guard", async () => {
    const f = fixtureWith()
    const changed = await f.service.updateLink("synthetic group", " https://t.me/+synthetic ", {
      approval: false,
      maxUses: 5,
    })
    expect(changed).toMatchObject({ chatId: "-1007", maxUses: 5, approval: false })
    expect(f.updateInviteLink).toHaveBeenCalledWith("-1007", "https://t.me/+synthetic", { approval: false, maxUses: 5 })
    expect(f.checked).toEqual([expect.objectContaining({ kind: "chat", action: "link.update" })])
    expect(f.records).toMatchObject([{ action: "link.update", outcome: "sent" }])
  })

  it("turns an expiry into an ISO minute", async () => {
    const f = fixtureWith()
    await f.service.updateLink("synthetic group", "https://t.me/+synthetic", { expires: "7d" })
    expect(f.updateInviteLink.mock.calls[0]?.[2]).toEqual({ expiresAt: expect.stringMatching(/:00\.000Z$/) })
  })

  it("takes never as no expiry, and still checks the use limit", async () => {
    const f = fixtureWith()
    await f.service.updateLink("synthetic group", "https://t.me/+synthetic", { expires: "never" })
    expect(f.updateInviteLink.mock.calls[0]?.[2]).toEqual({ expiresAt: null })
    await expect(
      f.service.updateLink("synthetic group", "https://t.me/+synthetic", { expires: "never", maxUses: 0 }),
    ).rejects.toThrow("--max-uses")
  })

  it.each([
    [{}, "nothing to change"],
    [{ maxUses: 0 }, "--max-uses takes a whole number from 1 to 99999"],
    [{ expires: "soon" }, "--expire-time takes a time like"],
  ])("refuses %j before connecting", async (change, message) => {
    const f = fixtureWith()
    await expect(f.service.updateLink("synthetic group", "https://t.me/+synthetic", change)).rejects.toThrow(message)
    await expect(f.service.updateLink("synthetic group", " ", { approval: true })).rejects.toThrow("which link")
    expect(f.connection).not.toHaveBeenCalled()
  })

  it("is refused by a messenger that cannot change links", async () => {
    await expect(
      fixture().service.updateLink("synthetic group", "https://t.me/+x", { approval: true }),
    ).rejects.toThrow("cannot change an invite link")
  })
})
