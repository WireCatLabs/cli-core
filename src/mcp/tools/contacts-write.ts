import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, tool, WRITE } from "../tool.js"

const person = v.pipe(v.string(), v.minLength(1), v.description("person id, or part of a known name"))

/** The address book's writes, and the owner's profile. `contacts import` has no tool: it takes phone numbers, from a file the owner names. */
export const contactWriteTools = (messenger: Messenger): Record<string, AnyTool> => {
  const people = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).people
  const simple = (name: "add" | "remove" | "block" | "unblock", title: string, description: string): AnyTool =>
    tool({
      title,
      description: `${description} Only when the owner asked, for this person.`,
      input: v.object({ person }),
      annotations: WRITE,
      permission: "contacts",
      online: async (adapter, args, { guard }) => itemOf(snakeKeys(await people(adapter, guard)[name](args.person))),
    })
  return {
    contacts_add: simple("add", "Add a contact", "Add a person to the owner's contacts."),
    contacts_remove: simple("remove", "Remove a contact", "Remove a person from the owner's contacts; the chat stays."),
    contacts_block: simple("block", "Block a person", "Stop a person from writing to the owner."),
    contacts_unblock: simple("unblock", "Unblock a person", "Let a blocked person write to the owner again."),
    account_update: tool({
      title: "Change the owner's profile",
      description:
        "Change the name or the description everyone sees on the owner's profile. Only when the owner asked " +
        "for this exact change.",
      input: v.object({
        first_name: v.optional(v.pipe(v.string(), v.minLength(1))),
        last_name: v.optional(v.string()),
        description: v.optional(v.string()),
      }),
      annotations: WRITE,
      permission: "profile",
      online: (adapter, args, { guard }) =>
        servicesFor(onlineDeps(messenger, adapter, guard)).account.update({
          ...(args.first_name === undefined ? {} : { firstName: args.first_name }),
          ...(args.last_name === undefined ? {} : { lastName: args.last_name }),
          ...(args.description === undefined ? {} : { description: args.description }),
        }),
    }),
    contacts_rename: tool({
      title: "Rename a contact",
      description: "Give a person a name only the owner sees. Only when the owner asked for this name.",
      input: v.object({
        person,
        first_name: v.pipe(v.string(), v.minLength(1)),
        last_name: v.optional(v.string()),
      }),
      annotations: WRITE,
      permission: "contacts",
      online: async (adapter, args, { guard }) =>
        itemOf(snakeKeys(await people(adapter, guard).rename(args.person, args.first_name, args.last_name))),
    }),
  }
}
