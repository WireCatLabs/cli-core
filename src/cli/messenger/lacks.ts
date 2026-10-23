import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import type { MessengerAdapter } from "../../ports/messenger.js"

type Need = readonly [method: keyof MessengerAdapter, what: string]

/**
 * The commands that do one thing only an adapter method can, with the words `capability()` refuses in.
 * `Messenger.lacks` names the methods a messenger never has, so these refuse before anything connects;
 * a test holds each entry to the live refusal it stands in for.
 */
export const COMMAND_NEEDS: Readonly<Record<string, Need>> = {
  "account update": ["updateProfile", "change the profile"],
  "account sessions list": ["sessions", "list the account's sessions"],
  "account sessions end": ["endOtherSessions", "end other sessions"],
  "chats events": ["chatEvents", "read who joined or left"],
  "chats inspect": ["inspect", "read a link"],
  "chats folders list": ["folders", "list its folders"],
  "chats folders show": ["folders", "list its folders"],
  "chats folders create": ["createFolder", "create a folder"],
  "chats folders update": ["updateFolder", "change a folder"],
  "chats folders delete": ["deleteFolder", "delete a folder"],
  "contacts add": ["addContact", "add a contact"],
  "contacts remove": ["removeContact", "remove a contact"],
  "contacts rename": ["renameContact", "rename a contact"],
  "contacts import": ["importContacts", "import contacts"],
  "messages comments": ["comments", "read comments on a channel post"],
  "messages pin": ["pin", "pin a message"],
  "messages unpin": ["unpin", "unpin a message"],
}

/** The commands the store answers for a messenger whose history is pushed to it, so the method is not needed there. */
const STORE_ANSWERS: ReadonlySet<string> = new Set(["chats events"])

interface Lacking {
  channelComments?: boolean
  lacks?: readonly (keyof MessengerAdapter)[]
  never?: readonly (keyof MessengerAdapter)[]
  history?: "server" | "store"
}

/** The one method this command needs and this messenger never has; none when it has it or the store answers. */
export const lackedNeed = (messenger: Lacking | undefined, path: string): Need | undefined => {
  const need = COMMAND_NEEDS[path]
  if (!need) return undefined
  if (path === "messages comments" && messenger?.channelComments === false) return need
  if (!messenger?.lacks?.includes(need[0]) && !messenger?.never?.includes(need[0])) return undefined
  return messenger.history === "store" && STORE_ANSWERS.has(path) ? undefined : need
}

/** Refuses, before a connection, a command whose one method this messenger never has. */
export const refuseLacking = (messenger: Lacking | undefined, path: readonly string[]) => {
  const need = lackedNeed(messenger, path.join(" "))
  if (need) throw new CliError("validation_error", `this messenger cannot ${need[1]}`)
}

/**
 * Hides under `group` each command whose one method this messenger can `never` have, from help, `commands` and MCP;
 * typed anyway, it still refuses. A method it only `lacks` keeps its command in sight, since it may come.
 */
export const hideNever = <T extends Command>(messenger: Lacking, group: T): T => {
  const walk = (command: Command, path: readonly string[]) => {
    for (const child of command.commands) {
      const at = [...path, child.name()]
      const need = COMMAND_NEEDS[at.join(" ")]
      if (need && messenger.never?.includes(need[0])) (child as Command & { _hidden: boolean })._hidden = true
      walk(child, at)
    }
  }
  walk(group, [group.name()])
  return group
}
