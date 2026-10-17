import * as v from "valibot"
import { itemOf } from "../../cli/envelope.js"
import { accountAnswer, sessionAnswer, wholeList } from "../../cli/messenger/chat-answers.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../ports/messenger.js"
import { maskedAccount } from "../../services/people.js"
import { type AnyTool, nameOf, READ, tool } from "../tool.js"

export const accountTools = (messenger: Messenger): Record<string, AnyTool> => {
  const name = nameOf(messenger)
  return {
    account_show: tool({
      title: "Who this is",
      description: `The ${name} account this server is logged in as.`,
      input: v.object({}),
      annotations: { ...READ, idempotentHint: true },
      output: { entity: "account", list: false },
      // An agent has no reason to hold the owner's number (max-cli NEED-209).
      online: async (adapter) => itemOf(accountAnswer(messenger.provider, maskedAccount(await adapter.me()))),
    }),

    account_sessions: tool({
      title: "Where the owner is logged in",
      description:
        `Every device and app logged in to the owner's ${name} account, each with current, client, device, ` +
        "location, last_active_at. Reads only; nothing is ended.",
      input: v.object({}),
      annotations: READ,
      command: "account sessions list",
      output: { entity: "account_session", list: true },
      online: async (adapter) =>
        wholeList(
          "account sessions list",
          (await capability(adapter, "sessions", "list the account's sessions")()).map(sessionAnswer),
        ),
    }),
  }
}
