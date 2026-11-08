import { c, id } from "./columns.mjs"

export const templateTables = [
  {
    name: "templates",
    doc: "A message template the owner wrote over the one cli-core ships, per key, channel and language. Every WireCat tool renders with it; a template that fails at send time falls back to the shipped one for that channel. Deleting the row (`templates reset`) brings the shipped one back.",
    cols: [
      c("key", "text", { notnull: true, note: "what the template renders, such as `report/morning-digest`" }),
      c("channel", "text", { notnull: true, note: "`telegram`, `email` or `text`" }),
      c("language", "text", { notnull: true, note: "ISO 639-1 code" }),
      c("body", "text", { notnull: true, note: "the Liquid source, checked before it was saved" }),
      c("updated_at", "integer", { notnull: true }),
      c("updated_by", "text", { notnull: true, note: "the command that saved it, such as `memo`" }),
    ],
    keys: ["PRIMARY KEY (key, channel, language)"],
  },
  {
    name: "templates_history",
    doc: "Every template body a save or a reset replaced, so an edit can be undone. Append-only.",
    cols: [
      id(),
      c("key", "text", { notnull: true }),
      c("channel", "text", { notnull: true }),
      c("language", "text", { notnull: true }),
      c("body", "text", { notnull: true, note: "the body as it was before the change" }),
      c("saved_at", "integer", { notnull: true, note: "when that body had been saved" }),
      c("saved_by", "text", { notnull: true }),
      c("replaced_at", "integer", { notnull: true }),
    ],
    keys: ["INDEX (key, channel, language, id)"],
  },
]
