import type { Renderer } from "@wirecat/cli-base"
import type { AppIdentity } from "../app.js"
import { recordLogFor } from "../runs/record-log.js"
import { currentRun } from "../runs/scope.js"
import type { MessengerContext } from "./context.js"

/** Something `serve` reports: a code and ids for its log, and the sentence a person at a terminal reads. */
export interface ServeNotice {
  code: string
  text: string
  chatId?: string
  errorCode?: string
}

type Severity = "info" | "warn" | "error"

const record = (context: MessengerContext, app: AppIdentity, severity: Severity, attributes: object) =>
  recordLogFor(context.streams.diagnostic, app, { command: currentRun().command || "serve" })[severity](attributes)

/** At a terminal the sentence; off one a record with the code and ids, never the sentence. */
export const noticeFor =
  (context: MessengerContext, app: AppIdentity, severity: Severity = "warn") =>
  ({ text, ...attributes }: ServeNotice): void => {
    if (context.format === "pretty") {
      if (severity === "info") context.renderer.note(text)
      else if (severity === "warn") context.renderer.warn(text)
      else context.renderer.failure(text)
      return
    }
    if (context.settings.quiet && severity === "info") return
    record(context, app, severity, { event: severity === "info" ? "serve.note" : "serve.warning", ...attributes })
  }

/**
 * A serve left running writes its diagnostics to a log file, so off a terminal each one is a log record with
 * its time and run. A sentence handed to the renderer may quote an error or a chat, so the record keeps only
 * which kind of line it was; serve's own reports go through `noticeFor` with a code. The renderer is changed
 * in place, so the send guard, bound to it before serve started, writes records too.
 */
export const recordDiagnostics = (context: MessengerContext, app: AppIdentity): MessengerContext => {
  if (context.format === "pretty") return context
  const say =
    (severity: Severity, event: string, always = false) =>
    (_text: string) => {
      if (context.settings.quiet && !always) return
      record(context, app, severity, { event })
    }
  const renderer: Renderer = context.renderer
  renderer.note = say("info", "serve.note")
  renderer.success = say("info", "serve.success")
  renderer.warn = say("warn", "serve.warning")
  renderer.failure = say("error", "serve.failure", true)
  return context
}
