import type { Asker, GuardRequest, SendGuard } from "./guard.js"
import { type Level, type PermissionKey, stops } from "./permissions.js"

export type KeyedGuard = SendGuard & {
  /** Refuses the write when one of its keys denies it or is read-only; asks nothing. */
  refuse(request: GuardRequest): void
}

/**
 * A guard over a write's main key and its extra keys. A key that refuses refuses before anything is asked, so nobody
 * answers yes to a write that a stricter key then stops, and one question names every key at `ask`. The extra keys are
 * probed as reads, never journaled or counted: the write itself holds the one journal line.
 */
export const keyedGuard = (
  build: (ask: Asker) => SendGuard,
  ask: Asker,
  levelOf: (key: PermissionKey) => Level,
  extra: readonly PermissionKey[],
): KeyedGuard => {
  let question: string | undefined
  let answered = false
  const guard = build(async (key, request) => {
    if (answered) return
    await ask(question || key, request)
    answered = true
  })
  const probes = new WeakMap<GuardRequest, GuardRequest[]>()
  const all = (request: GuardRequest) => {
    let found = probes.get(request)
    if (!found) {
      found = extra.map((key): GuardRequest => ({ chatId: null, kind: "read", key }))
      probes.set(request, found)
    }
    return [request, ...found]
  }
  const levelOfRequest = ({ key }: GuardRequest) => levelOf(key ?? "")
  const refuse = (request: GuardRequest) => {
    const refused = all(request).find((one) => stops(levelOfRequest(one), one.key ?? ""))
    if (refused) guard.check(refused, { reserve: false })
  }
  return {
    refuse,
    ask: async (request) => {
      refuse(request)
      question = all(request)
        .filter((one) => levelOfRequest(one) === "ask")
        .map(({ key }) => key)
        .join(" and ")
      for (const one of all(request)) await guard.ask?.(one)
    },
    check: (request, options) => {
      for (const one of all(request).slice(1)) guard.check(one, { reserve: false })
      guard.check(request, options)
    },
    ...(guard.reserve ? { reserve: guard.reserve } : {}),
    record: (entry) => guard.record(entry),
  }
}
