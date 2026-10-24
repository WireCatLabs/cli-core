import { defineQuery } from "@wirecat/cli-base/query"

export const EVENT_QUERY = defineQuery({
  entity: "event",
  backend: "sql",
  fields: [
    { name: "id", type: "num", operators: ["term", "range"], example: "id:1" },
    { name: "origin", type: "enum", operators: ["term"], values: ["auto", "owner"], example: "origin:owner" },
    ...["starts_at", "ends_at", "created_at", "updated_at"].map((name) => ({
      name,
      type: "time" as const,
      operators: ["term", "range"] as ("term" | "range")[],
      example: `${name}>=2026-01-01`,
    })),
  ],
})
