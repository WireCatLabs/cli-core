### Changed — may break callers

- **A task found in a message takes the fields of a project task.** `store.tasks.edit`, which now takes `TaskEdit`,
  gives it `todo` and `in_progress` and another message kind (question, request, mention, promise), and `{ project }` moves it into an
  owner project under that project's next key. The moved task keeps its id, its old key and its source message, leaves
  its account's task reads, and may then become a bug, feature or chore. A rule does not open a second task from that
  message.
- **The task board includes found tasks.** `store.tasks.board` and `boardCounts` count every live task, found tasks
  too; `project:*` still narrows to the owner's projects, and the project choices leave the account inboxes out.
  `stats tasks` over projects is unchanged.
- **An account's open tasks include `todo` and `in_progress`.** `knowledge.taskIds(key, { state: "open" })` and
  `tasks agenda` read every task not closed yet.
