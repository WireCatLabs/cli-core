import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { listed } from "../../cli/paging.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { type AnyTool, READ, tool } from "../tool.js"

const person = v.pipe(v.string(), v.minLength(1))
const id = v.pipe(v.string(), v.minLength(1))
const text = v.pipe(v.string(), v.minLength(1), v.maxLength(100_000))
const LOCAL = { readOnlyHint: false, openWorldHint: false }

export const privatePeopleTools = (messenger: Messenger): Record<string, AnyTool> => ({
  contacts_alias_set: tool({
    title: "Set a private contact alias",
    description: "Set a display name only in this account's local store; never rename a messenger contact.",
    input: v.object({ person, alias: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) }),
    annotations: { ...LOCAL, idempotentHint: true, destructiveHint: false },
    stored: (store, account, args, defaults) =>
      servicesFor(storedDeps(messenger, store, account, defaults.guard)).privatePeople.alias(args.person, args.alias),
  }),
  contacts_alias_rm: tool({
    title: "Remove a private contact alias",
    description: "Remove only this account's local alias.",
    input: v.object({ person }),
    annotations: { ...LOCAL, idempotentHint: true, destructiveHint: true },
    stored: (store, account, args, defaults) =>
      servicesFor(storedDeps(messenger, store, account, defaults.guard)).privatePeople.alias(args.person, null),
  }),
  contacts_notes_list: tool({
    title: "Private notes on a contact",
    description: "User-authored notes stored locally for this account; they are separate from the person's public bio.",
    input: v.object({ person }),
    annotations: { ...READ, openWorldHint: false },
    stored: async (store, account, args, defaults) =>
      listed(
        (await servicesFor(storedDeps(messenger, store, account, defaults.guard)).privatePeople.show(args.person))
          .notes,
      ),
  }),
  contacts_notes_show: tool({
    title: "Read a private contact note",
    description: "Read one account-scoped note and its revision.",
    input: v.object({ person, id }),
    annotations: { ...READ, openWorldHint: false },
    stored: (store, account, args, defaults) =>
      servicesFor(storedDeps(messenger, store, account, defaults.guard)).privatePeople.note(args.person, args.id),
  }),
  contacts_notes_add: tool({
    title: "Add a private contact note",
    description: "Save the user's note locally with a stable id; nothing is sent to the person.",
    input: v.object({ person, text }),
    annotations: { ...LOCAL, idempotentHint: false, destructiveHint: false },
    stored: (store, account, args, defaults) =>
      servicesFor(storedDeps(messenger, store, account, defaults.guard)).privatePeople.add(args.person, args.text),
  }),
  contacts_notes_edit: tool({
    title: "Edit a private contact note",
    description: "Replace note text only if its revision still matches the one read.",
    input: v.object({ person, id, text, revision: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
    annotations: { ...LOCAL, idempotentHint: false, destructiveHint: true },
    stored: (store, account, args, defaults) =>
      servicesFor(storedDeps(messenger, store, account, defaults.guard)).privatePeople.edit(
        args.person,
        args.id,
        args.text,
        args.revision,
      ),
  }),
  contacts_notes_remove: tool({
    title: "Delete a private contact note",
    description: "Delete this local note's text; the contact and source messages remain.",
    input: v.object({ person, id }),
    annotations: { ...LOCAL, idempotentHint: false, destructiveHint: true },
    stored: (store, account, args, defaults) =>
      servicesFor(storedDeps(messenger, store, account, defaults.guard)).privatePeople.remove(args.person, args.id),
  }),
  metadata_get: tool({
    title: "Cached channel metadata",
    description: "Read locally stored group/channel title, username, description and refresh time.",
    input: v.object({ chat: person }),
    annotations: { ...READ, openWorldHint: false },
    stored: (store, account, args, defaults) =>
      servicesFor(storedDeps(messenger, store, account, defaults.guard)).metadata.get(args.chat),
  }),
  metadata_refresh: tool({
    title: "Refresh channel metadata",
    description: "Read a group/channel description from the messenger and cache it locally. No remote mutation.",
    input: v.object({ chat: person }),
    annotations: { ...LOCAL, idempotentHint: true, destructiveHint: false },
    stored: async (store, account, args, defaults, connect) => {
      if (!connect) throw new CliError("validation_error", "metadata refresh needs a connection")
      const deps = {
        ...storedDeps(messenger, store, account, defaults.guard),
        offline: defaults.settings.offline ?? false,
        withConnection: connect,
      }
      return { items: [await servicesFor(deps).metadata.refresh(args.chat)], hasMore: false }
    },
  }),
  tags_auto: tool({
    title: "Classify cached channels",
    description:
      "Derive local keyword tags from title, username and description, preserving manual tags. Refresh is explicit. Dry-run uses cached data only.",
    input: v.object({
      chats: v.optional(v.array(person)),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
      refresh_metadata: v.optional(v.boolean()),
      dry_run: v.optional(v.boolean()),
    }),
    annotations: { ...LOCAL, idempotentHint: true, destructiveHint: false },
    stored: async (store, account, args, defaults, connect) => {
      const deps = {
        ...storedDeps(messenger, store, account, defaults.guard),
        offline: args.refresh_metadata ? (defaults.settings.offline ?? false) : true,
        withConnection: connect,
      }
      return servicesFor(deps).metadata.auto({
        chats: args.chats,
        limit: args.limit,
        refresh: args.refresh_metadata,
        dryRun: args.dry_run,
      })
    },
  }),
})
