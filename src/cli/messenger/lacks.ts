import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { hide, isHidden } from "../commander-internals.js"

type Need = readonly [method: keyof MessengerAdapter, what: string]

/**
 * The commands that do one thing only an adapter method can, with the words `capability()` refuses in.
 * `Messenger.lacks` names the methods a messenger never has, so these refuse before anything connects;
 * a test holds each entry to the live refusal it stands in for.
 * @experimental
 */
export const COMMAND_NEEDS: Readonly<Record<string, Need>> = {
  "account update": ["updateProfile", "change the profile"],
  "account devices list": ["sessions", "list the account's devices"],
  "account devices end": ["endOtherSessions", "log out other devices"],
  "chats events": ["chatEvents", "read who joined or left"],
  "chats inspect": ["inspect", "read a link"],
  "chats folders list": ["folders", "list its folders"],
  "chats folders show": ["folders", "list its folders"],
  "chats folders create": ["createFolder", "create a folder"],
  "chats folders update": ["updateFolder", "change a folder"],
  "chats folders delete": ["deleteFolder", "delete a folder"],
  "chats links show": ["group", "read a group"],
  "chats links reset": ["resetInviteLink", "replace an invite link"],
  "chats requests list": ["joinRequests", "read join requests"],
  "chats requests confirm": ["answerJoinRequest", "answer join requests"],
  "chats requests reject": ["answerJoinRequest", "answer join requests"],
  "chats admins add": ["addAdmin", "make someone an admin"],
  "chats admins remove": ["removeAdmin", "take admin rights back"],
  "contacts add": ["addContact", "add a contact"],
  "contacts remove": ["removeContact", "remove a contact"],
  "contacts rename": ["renameContact", "rename a contact"],
  "contacts import": ["importContacts", "import contacts"],
  "contacts block": ["block", "block a person"],
  "contacts unblock": ["unblock", "unblock a person"],
  "messages forward": ["forward", "forward a message"],
  "messages comments": ["comments", "read comments on a channel post"],
  "messages pin": ["pin", "pin a message"],
  "messages unpin": ["unpin", "unpin a message"],
  "messages scheduled cancel": ["cancelScheduled", "cancel a scheduled message"],
  "messages scheduled edit": ["editScheduled", "edit a scheduled message"],
  "messages scheduled send": ["sendScheduled", "send a scheduled message now"],
}

/** The commands the store answers for a messenger whose history is pushed to it, so the method is not needed there. */
const STORE_ANSWERS: ReadonlySet<string> = new Set(["chats events"])

interface Lacking {
  channelComments?: boolean
  readsComments?: boolean
  lacks?: readonly (keyof MessengerAdapter)[]
  never?: readonly (keyof MessengerAdapter)[]
  history?: "server" | "store"
}

/** The one method this command needs and this messenger never has; none when it has it or the store answers. */
export const lackedNeed = (messenger: Lacking | undefined, path: string): Need | undefined => {
  const need = COMMAND_NEEDS[path]
  if (!need) return undefined
  if (path === "messages comments" && (messenger?.readsComments ?? messenger?.channelComments) === false) return need
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
 * typed anyway, it still refuses. A group left with nothing in sight is hidden too, since an empty group lists
 * nothing to run. A method it only `lacks` keeps its command in sight, since it may come.
 */
export const hideNever = <T extends Command>(messenger: Lacking, group: T): T => {
  const walk = (command: Command, path: readonly string[]) => {
    for (const child of command.commands) {
      const at = [...path, child.name()]
      const need = COMMAND_NEEDS[at.join(" ")]
      if (need && messenger.never?.includes(need[0])) hide(child)
      walk(child, at)
      if (child.commands.length > 0 && child.commands.every(isHidden)) hide(child)
    }
  }
  walk(group, [group.name()])
  return group
}
