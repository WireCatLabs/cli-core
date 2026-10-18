import { CliError } from "@wirecat/cli-base"
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
  "messages pin": ["pin", "pin a message"],
  "messages unpin": ["unpin", "unpin a message"],
}

/** The commands the store answers for a messenger whose history is pushed to it, so the method is not needed there. */
const STORE_ANSWERS: ReadonlySet<string> = new Set(["chats events"])

interface Lacking {
  lacks?: readonly (keyof MessengerAdapter)[]
  history?: "server" | "store"
}

/** The one method this command needs and this messenger never has; none when it has it or the store answers. */
export const lackedNeed = (messenger: Lacking | undefined, path: string): Need | undefined => {
  const need = COMMAND_NEEDS[path]
  if (!need || !messenger?.lacks?.includes(need[0])) return undefined
  return messenger.history === "store" && STORE_ANSWERS.has(path) ? undefined : need
}

/** Refuses, before a connection, a command whose one method this messenger never has. */
export const refuseLacking = (messenger: Lacking | undefined, path: readonly string[]) => {
  const need = lackedNeed(messenger, path.join(" "))
  if (need) throw new CliError("validation_error", `this messenger cannot ${need[1]}`)
}
