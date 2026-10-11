import { CliError } from "@wirecat/cli-base"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import { capability } from "../cli/messenger/port.js"
import type { Button, Id } from "../domain/models.js"
import type { SendGuard } from "./guard.js"
import { guardedWrite, type Operated } from "./guarded.js"
import { newOperationId, newSendId } from "./send-id.js"

export interface Pressed {
  chatId: Id
  messageId: Id
  button: Button
}

const REFUSED: Partial<Record<Button["kind"], string>> = {
  contact: "it would hand your phone number to the bot",
  location: "it would hand your location to the bot",
  link: "it only opens its link, which `messages show` prints",
  message: "it only sends its text — use `messages send` with it",
  app: "it opens the bot's mini app — use `chats app`",
  clipboard: "it only copies its text",
}

/** The button by its number, counted from 1 across the rows as `messages show` prints them, or by its exact text. */
export const pickButton = (keyboard: Button[][], typed: string): { row: number; column: number; button: Button } => {
  const all = keyboard.flatMap((buttons, row) => buttons.map((button, column) => ({ row, column, button })))
  if (all.length === 0) throw new CliError("not_found", "this message has no buttons")
  const wanted = typed.trim()
  if (/^\d+$/.test(wanted)) {
    const found = all[Number(wanted) - 1]
    if (!found) throw new CliError("validation_error", `there are ${all.length} buttons; ${wanted} is not one of them`)
    return found
  }
  const named = all.filter(({ button }) => button.text === wanted)
  if (named.length === 0) throw new CliError("not_found", `no button reads "${wanted}"; give its number instead`)
  if (named.length > 1)
    throw new CliError("validation_error", `${named.length} buttons read "${wanted}"; give its number`)
  return named[0] as (typeof named)[number]
}

/** A press reaches only the bot, like a vote reaches only the poll: guarded as a reaction. */
export const guardedPress = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, message, button: typed }: { chat: string; message: string; button: string },
): Promise<Operated<Pressed>> => {
  const buttons = capability(connection, "buttons", "read a message's buttons")
  const press = capability(connection, "pressButton", "press a bot's button")
  const { id: chatId } = await connection.resolve(chat)
  const { row, column, button } = pickButton(await buttons(chatId, message), typed)
  const refused = REFUSED[button.kind]
  if (refused)
    throw new CliError("validation_error", `not pressed: "${button.text}" is a ${button.kind} button — ${refused}`)
  if (button.kind !== "callback")
    throw new CliError(
      "validation_error",
      `not pressed: "${button.text}" is a ${button.kind} button, which this CLI cannot press`,
    )
  const operationId = newOperationId()
  await guardedWrite(guard, { operationId, chatId, kind: "reaction", messageId: message, key: "messages.press" }, () =>
    press(chatId, message, row, column),
  )
  return { operationId, chatId, messageId: message, button }
}

/** Starting a bot sends it a message — its start command — so it is guarded like one. */
export const guardedStart = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, payload, sendId }: { chat: string; payload?: string; sendId?: string },
): Promise<Operated<{ chatId: Id; started: true }>> => {
  const start = capability(connection, "startBot", "start a bot")
  const linked = await connection.botByLink?.(chat)
  const chatId = linked?.chatId ?? (await connection.resolve(chat)).id
  const given = payload ?? linked?.payload
  const id = sendId ?? connection.newSendId?.() ?? newSendId()
  await guardedWrite(
    guard,
    { chatId, kind: "message", sendId: id, operationId: id, length: given?.length ?? 0, key: "chats.start" },
    () => start(chatId, { sendId: id, ...(given === undefined ? {} : { payload: given }) }),
  )
  return { operationId: id, chatId, started: true }
}

/** The mini app's address signs the owner in, so asking for it is guarded like a press, and it is printed only here. */
export const guardedApp = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, startParam }: { chat: string; startParam?: string },
): Promise<Operated<{ chatId: Id; url: string }>> => {
  const app = capability(connection, "botApp", "open a bot's mini app")
  const { id: chatId } = await connection.resolve(chat)
  const operationId = newOperationId()
  const { url } = await guardedWrite(guard, { operationId, chatId, kind: "reaction", key: "chats.app" }, () =>
    app(chatId, startParam === undefined ? {} : { startParam }),
  )
  return { operationId, chatId, url }
}
