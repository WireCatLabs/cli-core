import { CliError, isCliError } from "@wirecat/cli-base"
import type { Settings } from "./settings.js"

// gcal-cli raised its own oauth.missing before cli-core merged it into session.missing (FIND-2583).
const NOT_SIGNED_IN = new Set([undefined, "session.missing", "oauth.missing"])
const FROM_ENV = /^[A-Z0-9_]+_PROFILE$/
const SIGN_INS = new Set(["session start", "setup"])
/** A sign-in names a new profile on purpose: a refusal there is the provider's, never an unknown profile. */
export const isSignIn = (path: string) => SIGN_INS.has(path)

// A script's `<PREFIX>_PROFILE` on a computer with no profile yet names a new one, not a mistyped one.
const typo = (source: string | undefined, here: readonly string[]) =>
  source === "first word" || (source !== undefined && FROM_ENV.test(source) && here.length > 0)

/**
 * A "not signed in" failure for a first word this computer has never seen as a profile is most likely a typo: it
 * answers `not_found` with the profiles here (FIND-2583), and keeps the sign-in hint for a profile that is new on
 * purpose. Only after a command failed, and never for `setup` or `session start`, which make a new one. The first word and `<PREFIX>_PROFILE` are checked, since a typo in either is as likely; a bot gets
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
  if (!settings || !here || settings.kind === "bot" || !typo(settings.sources?.profile, here)) return error
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
