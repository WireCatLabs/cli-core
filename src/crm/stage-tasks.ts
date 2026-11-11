import { taskAccount } from "../services/task-rules.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { createTaskService } from "../tasks/index.js"

const DAY = 86_400_000

/**
 * Opens the owner's task for each stage a deal or lead of the account entered that its `stage-tasks` setting names:
 * one per entry, so a dismissed task never comes back and a later entry into the same stage opens a new one.
 * Answers how many it opened.
 */
export const openStageTasks = async (store: MessageStore, account: AccountKey, now: number): Promise<number> => {
  const rules = await store.crm.stageTasks(account)
  if (Object.keys(rules.deal).length + Object.keys(rules.lead).length === 0) return 0
  const { moves, through } = await store.crm.stageMoves(account)
  // Every deal entering a stage gets the same title, so the duplicate review would pair tasks of different deals.
  const { reviewDuplicates: _review, ...tasks } = store.tasks
  const service = createTaskService({ store: tasks, now: () => new Date(now) })
  let opened = 0
  for (const move of moves) {
    const rule = rules[move.kind][move.stage]
    if (!rule) continue
    const item = await store.deals.get(move.ref)
    const responsible =
      item.people.find((one) => one.role === "owner")?.name ??
      (item.assignee === null ? "nobody" : `CRM user ${item.assignee.split("/").at(-1)}`)
    const { created } = await service.add({
      source: `${move.ref}/move/${move.id}`,
      sourceKind: move.kind,
      account: taskAccount(account),
      group: move.ref,
      kind: "request",
      origin: "rule",
      dueAt: new Date(now + rule.dueDays * DAY),
      title: rule.title,
      description:
        `${item.title} (${move.ref}) entered the stage ${move.stageName} of the pipeline ${move.pipelineName}. ` +
        `Responsible: ${responsible}.`,
    })
    if (created) opened += 1
  }
  await store.crm.markStageMoves(account, through)
  return opened
}
