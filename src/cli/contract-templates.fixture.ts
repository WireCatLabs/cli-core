import type { SharedContractOverride } from "./shared-contracts.js"
export const SEARCH_SHELL: readonly SharedContractOverride[] = [
  {
    command: ["search"],
    field: "summary",
    before: "search the local archive",
    after: null,
    reason: "This standalone source searches imported documents only.",
  },
  {
    command: ["search"],
    field: "description",
    before:
      "find things by text: one resource when you know it (messages, notes), or search all across messages and notes; for mail, the separate memo CLI: memo search mail",
    after: "imported document search",
    reason: "This standalone source searches imported documents only.",
  },
  {
    command: ["search"],
    field: "options",
    before: [],
    after: [
      {
        flags: "--limit <n>",
        description: "result count",
        takes_value: true,
        mandatory: false,
      },
    ],
    reason: "This standalone source searches imported documents only.",
  },
  {
    command: ["search"],
    field: "children",
    before: ["all", "messages", "notes", "conversations", "runs"],
    after: [],
    reason: "This standalone source searches imported documents only.",
  },
]
