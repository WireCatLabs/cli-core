import { describe, expect, it } from "vitest"
import type { Asker, GuardRequest, SendGuard } from "./guard.js"
import { keyedGuard } from "./keyed-guard.js"
import type { Level } from "./permissions.js"

const fakeGuard = (levels: Record<string, Level>) => {
  const checked: string[] = []
  const build = (ask: Asker): SendGuard => ({
    check: (request) => {
      checked.push(request.key ?? "")
      if (levels[request.key ?? ""] === "deny") throw new Error(`refused ${request.key}`)
    },
    ask: async (request) => {
      if (levels[request.key ?? ""] === "ask") await ask(request.key ?? "", request)
    },
    record: () => undefined,
  })
  return { build, checked, levelOf: (key: string) => levels[key] ?? "allow" }
}

const write: GuardRequest = { chatId: null, kind: "edit", key: "events.create" }

describe("keyedGuard", () => {
  it("refuses on an extra key that denies before anything is asked", async () => {
    const { build, levelOf } = fakeGuard({ "events.create": "ask", "events.notify": "deny" })
    const asked: string[] = []
    const guard = keyedGuard(build, async (key) => void asked.push(key), levelOf, ["events.notify"])
    expect(() => guard.refuse(write)).toThrow("refused events.notify")
    await expect(guard.ask?.(write)).rejects.toThrow("refused events.notify")
    expect(asked).toEqual([])
  })

  it("asks once, naming every key at ask, and checks the extra keys as reads", async () => {
    const { build, checked, levelOf } = fakeGuard({ "events.create": "ask", "events.notify": "ask" })
    const asked: string[] = []
    const guard = keyedGuard(build, async (key) => void asked.push(key), levelOf, ["events.notify"])
    await guard.ask?.(write)
    expect(asked).toEqual(["events.create and events.notify"])
    guard.check(write)
    expect(checked).toEqual(["events.notify", "events.create"])
  })
})
