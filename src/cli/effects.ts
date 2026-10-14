import { stepTargets } from "@wirecat/cli-base/commands"
import type { Effects, StepInput } from "@wirecat/cli-base/standards"
import type { Command } from "commander"

/** Reads the messenger; a page it keeps on the way is incidental. */
export const REMOTE_READ: Effects = { remote: "read", local: "read" }
/** Reads the messenger to keep what it read on this machine: a sync, a download, a refresh of the store. */
export const FETCH: Effects = { remote: "read", local: "write" }
/** Changes something on the service; a guarded write also records itself here. */
export const REMOTE_WRITE: Effects = { remote: "write", local: "write" }
export const LOCAL_READ: Effects = { remote: "none", local: "read" }
export const LOCAL_WRITE: Effects = { remote: "none", local: "write" }
export const NO_EFFECTS: Effects = { remote: "none", local: "none" }

/**
 * The effects a retry or an unasked step is judged on (NEED-1073): only what the service sees. Running a sync or a
 * cached read twice rewrites the same local rows, so a local write alone never makes either unsafe. Unknown stays
 * unknown, which cli-base counts as a write.
 */
export const judgedEffects = (effects: Effects | undefined): Effects | undefined =>
  effects && { remote: effects.remote, local: "none" }

/** `stepTargets`, with each command's effects judged as above. */
export const judgedTargets = (root: Command): NonNullable<StepInput["targets"]> => {
  const targets = stepTargets(root)
  return (command) => {
    const target = targets(command)
    if (!target) return undefined
    const effects = judgedEffects(target.effects)
    return { names: target.names, ...(effects ? { effects } : {}) }
  }
}
