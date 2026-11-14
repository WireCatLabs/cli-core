import type { EventEmitter } from "node:events"
import type { Command } from "commander"

const GIVEN = new Set(["cli", "env", "config"])

/**
 * commander gives a flag that the root and the command both declare (`--yes`, `--timeout`, `--dry-run`) to the root,
 * so the command's own option stays empty (BUG-760). The value goes to the command's option too, through its own
 * parser, so `--timeout 2m` on an option that takes seconds still arrives as seconds.
 */
export const shareShadowedOptions = (action: Command): void => {
  const ancestors: Command[] = []
  for (let at = action.parent; at; at = at.parent) ancestors.push(at)
  for (const option of action.options) {
    const key = option.attributeName()
    if (GIVEN.has(action.getOptionValueSource(key) ?? "")) continue
    const holder = ancestors.find((one) => GIVEN.has(one.getOptionValueSource(key) ?? ""))
    if (!holder) continue
    const value: unknown = holder.getOptionValue(key)
    const takesValue = option.required || option.optional
    if (typeof value === "boolean" && !takesValue) action.setOptionValueWithSource(key, value, "cli")
    // commander's own handler parses and validates it, as when typed; its types leave out that a Command is an emitter.
    else if (typeof value === "string" && takesValue)
      (action as unknown as EventEmitter).emit(`option:${option.name()}`, value)
  }
}
