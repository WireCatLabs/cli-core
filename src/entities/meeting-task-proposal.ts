import { reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { TASK_KINDS } from "../tasks/index.js"

const text = v.string()
const id = v.pipe(v.number(), v.integer(), v.minValue(1))
const revision = v.picklist(["current", "superseded"])

/** `meetings task-proposal`: the task a meeting line would become; nothing is created. */
export const meetingTaskProposal = v.strictObject({
  id: text,
  source: reference,
  source_kind: v.literal("meeting"),
  group: reference,
  account_id: id,
  kind: v.picklist(TASK_KINDS),
  preview: v.nullable(text),
  revision: v.nullable(revision),
  applied: v.literal(false),
  persistence: v.literal("proposal-only"),
})
