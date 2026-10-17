import { expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { onlineDeps } from "./deps.js"
import { messagesService } from "./messages.js"

it("**BUG-272: download hands the adapter the chat's id, not the name typed**", async () => {
  const download = vi.fn(async () => ({ files: [], skipped: [] }))
  const adapter = {
    resolve: async (chat: string) => ({ id: chat === "Book club" ? "7" : chat, title: "Book club", kind: "group" }),
    download,
  } as unknown as MessengerAdapter
  const service = messagesService(onlineDeps({ provider: "test" } as Messenger, adapter, {} as SendGuard))

  await service.download("Book club", "40")

  expect(download).toHaveBeenCalledWith("7", "40")
})
