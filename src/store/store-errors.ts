import { CliError } from "@wirecat/cli-base"
import { rehearsing } from "./sqlite/transaction.js"

/** Drizzle wraps whatever a query throws in its own `DrizzleQueryError`; a store refusal under it is the answer. */
const refusalOf = (error: unknown): unknown =>
  error instanceof Error && error.name === "DrizzleQueryError" && error.cause instanceof CliError ? error.cause : error

/**
 * A store area whose methods throw a store refusal (`store.dry-run`) as it was raised, not inside Drizzle's query
 * error, so `reason`, exit codes and agents see it. Spies on the area still see every call. Only a dry run raises
 * one, so outside it a call goes straight through, its promise untouched.
 */
const wrapped = new WeakMap<object, object>()

export const storeErrors = <T>(area: T): T => {
  if (typeof area !== "object" || area === null || area instanceof Promise) return area
  const held = wrapped.get(area)
  if (held) return held as T
  const proxy = new Proxy(area as object, {
    get: (target, name) => {
      const value = Reflect.get(target, name, target)
      // An area bound to an account is the area's member: its methods answer the same way.
      if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype)
        return storeErrors(value)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        if (!rehearsing()) return Reflect.apply(value, target, args)
        let answer: unknown
        try {
          answer = Reflect.apply(value, target, args)
        } catch (error) {
          throw refusalOf(error)
        }
        return answer instanceof Promise
          ? answer.catch((error: unknown) => {
              throw refusalOf(error)
            })
          : answer
      }
    },
  })
  wrapped.set(area, proxy)
  return proxy as T
}
