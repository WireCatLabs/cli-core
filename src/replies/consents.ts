import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import * as v from "valibot"
import type { AppIdentity } from "../cli/app.js"

const shape = v.strictObject({
  provider: v.nullable(v.pipe(v.string(), v.minLength(1))),
  deniedChats: v.array(v.pipe(v.string(), v.minLength(1))),
})
export type ReplyConsent = v.InferOutput<typeof shape>
export const replyConsentPathFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env) =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config, `${profile}.replies-consents.json`)

export const readReplyConsent = (path: string): ReplyConsent => {
  if (!existsSync(path)) return { provider: null, deniedChats: [] }
  try {
    return v.parse(shape, JSON.parse(readFileSync(path, "utf8")))
  } catch {
    throw new CliError("configuration_error", "reply model consent is invalid; fix its file before granting consent")
  }
}
export const writeReplyConsent = (path: string, consent: ReplyConsent) =>
  writeSecurely(path, `${JSON.stringify(v.parse(shape, consent), null, 2)}\n`, 0o600)
export const replyModelIdentity = (provider: string, baseUrl: string) => `${provider}:${baseUrl.replace(/\/+$/, "")}`
export const mayModelReply = (path: string, provider: string, chat: string) => {
  const consent = readReplyConsent(path)
  return consent.provider === provider && !consent.deniedChats.includes(chat)
}
