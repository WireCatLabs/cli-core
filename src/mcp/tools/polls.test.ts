import { expect, it } from "vitest"
import type { Messenger } from "../../cli/messenger/context.js"
import { pollWriteTools } from "./polls.js"

const messenger = { chatArgument: "a chat" } as unknown as Messenger

it("offers polls_close unless the messenger's polls cannot be closed", () => {
  expect(Object.keys(pollWriteTools(messenger))).toContain("polls_close")
  expect(Object.keys(pollWriteTools({ ...messenger, pollClose: false }))).not.toContain("polls_close")
})
