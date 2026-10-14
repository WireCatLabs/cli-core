import { describe, expect, it, vi } from "vitest"
import type { MediaOption, Messenger } from "../cli/messenger/context.js"
import { editCommand } from "../cli/messenger/messages-edit-command.js"
import { sendCommand } from "../cli/messenger/messages-send-command.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { onlineDeps } from "./deps.js"
import { messagesService } from "./messages.js"

const photo = [
  { kind: "photo" as const, name: "synthetic.jpg", source: { kind: "bytes" as const, bytes: new Uint8Array([1]) } },
]

const setup = (mediaOptions?: readonly MediaOption[]) => {
  const messenger = { provider: "test", chatArgument: "a chat", ...(mediaOptions ? { mediaOptions } : {}) } as Messenger
  const send = vi.fn(async (chatId: string, text: string, options: { sendId: string }) => ({
    sendId: options.sendId,
    message: { id: "4", chatId, text } as never,
  }))
  const adapter = {
    self: () => "500",
    resolve: async () => ({ id: "7", title: "Synthetic", kind: "group" }),
    send,
  } as unknown as MessengerAdapter
  const guard = { check: () => {}, record: () => {} } as unknown as SendGuard
  const deps = onlineDeps(messenger, adapter, guard)
  const connection = vi.fn(deps.connection)
  return { service: messagesService({ ...deps, connection }), send, connection }
}

describe("media options on a send", () => {
  it("passes a spoiler and the caption placement to a messenger that lists them", async () => {
    const { service, send } = setup(["spoiler", "captionAbove"])
    await service.send({ chat: "7", text: "look", attachments: photo, spoiler: true, captionAbove: true })
    expect(send).toHaveBeenCalledWith("7", "look", expect.objectContaining({ spoiler: true, captionAbove: true }))
  })

  it.each([
    [undefined, { spoiler: true }, "no --spoiler"],
    [["spoiler"] as const, { captionAbove: true }, "no --caption-above"],
    [["spoiler", "captionAbove"] as const, { spoiler: true, attachments: [] }, "needs a --photo or --file"],
  ])("refuses before connecting: %j %j", async (listed, asked, message) => {
    const { service, connection, send } = setup(listed)
    await expect(service.send({ chat: "7", text: "look", attachments: photo, ...asked })).rejects.toThrow(message)
    expect(connection).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("leaves a plain send without the options", async () => {
    const { service, send } = setup()
    await service.send({ chat: "7", text: "look", attachments: photo })
    expect(send.mock.calls[0]?.[2]).not.toHaveProperty("spoiler")
    expect(send.mock.calls[0]?.[2]).not.toHaveProperty("captionAbove")
  })
})

describe("the send command's media flags", () => {
  const flags = (mediaOptions?: readonly MediaOption[]) =>
    sendCommand({ provider: "test", chatArgument: "a chat", ...(mediaOptions ? { mediaOptions } : {}) } as Messenger)
      .options.map(({ long }) => long)
      .filter((flag) => flag === "--spoiler" || flag === "--caption-above")

  it("**shows only the flags the messenger lists**, so the parity check sees what each CLI can do", () => {
    expect(flags()).toEqual([])
    expect(flags(["spoiler"])).toEqual(["--spoiler"])
    expect(flags(["spoiler", "captionAbove"])).toEqual(["--spoiler", "--caption-above"])
  })

  it("offers --filename and --html only where the messenger has them, --html on edit too", () => {
    const offered = (messenger: Partial<Messenger>, command = sendCommand) =>
      command({ provider: "test", chatArgument: "a chat", ...messenger } as Messenger)
        .options.map(({ long }) => long)
        .filter((flag) => flag === "--filename" || flag === "--html")

    expect(offered({})).toEqual([])
    expect(offered({ mediaOptions: ["fileName"], html: true })).toEqual(["--filename", "--html"])
    expect(offered({}, editCommand)).toEqual([])
    expect(offered({ html: true }, editCommand)).toEqual(["--html"])
  })
})
