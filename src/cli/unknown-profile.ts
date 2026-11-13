import { CliError, isCliError } from "@wirecat/cli-base"
import type { Settings } from "./settings.js"

// gcal-cli raised its own oauth.missing before cli-core merged it into session.missing (FIND-2583).
const NOT_SIGNED_IN = new Set([undefined, "session.missing", "oauth.missing"])
const TYPED = /^(?:first word|[A-Z0-9_]+_PROFILE)$/

/**
 * A "not signed in" failure for a first word this computer has never seen as a profile is most likely a typo: it
 * answers `not_found` with the profiles here (FIND-2583), and keeps the sign-in hint for a profile that is new on
 * purpose. Only after a command failed, so a working profile and the `setup` or `session start` that makes a new one
 * never reach it. The first word and `<PREFIX>_PROFILE` are checked, since a typo in either is as likely; a bot gets
 * its token with `bot auth set` under any new name.
 */
export const unknownProfile = (
  error: unknown,
  settingsOf: () =>
    | (Pick<Settings, "profile"> & Partial<Pick<Settings, "sources" | "profilesHere" | "kind">>)
    | undefined,
): unknown => {
  if (!isCliError(error) || error.code !== "authentication_error") return error
  if (!NOT_SIGNED_IN.has(error.details.reason as string | undefined)) return error
  const settings = settingsOf()
  const here = settings?.profilesHere
  if (!settings || !here || settings.kind === "bot" || !TYPED.test(settings.sources?.profile ?? "")) return error
  if (here.includes(settings.profile)) return error
  // A CLI that checks its own profiles already says "no profile named …".
  const sayTheRefusal = !/no profile named/i.test(error.message)
  return new CliError(
    "not_found",
    `no profile named ${settings.profile} on this computer — profiles here: ${here.join(", ") || "none"}` +
      (sayTheRefusal ? `; if ${settings.profile} is a new one: ${error.message}` : ""),
    { reason: "profile.unknown", profiles: here },
  )
}
