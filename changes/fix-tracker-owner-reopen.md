### Fixed

- **A tracker task you reopened stays open past your next change.** After a sync closed the task of an issue assigned
  to you, your reopen held only while it was the task's last status change: moving the task on to in progress let
  the next sync close it again. Any status change of yours after the sync's close now counts. It holds for good
  while the issue goes to someone else or to no one, and for any other close until the issue has been open work
  again, so a later completion closes the task again ([TRACKER.md](../docs/dev/TRACKER.md#an-issue-as-the-owners-task)).
- **A tracker task the sync opens again keeps the status it had**, such as in progress, instead of open.
- **`issues assign` on an issue the sync already made a task of makes that task your pick.** It opens the task again
  when it was closed, where it answered the closed task, and the issue going to someone else no longer closes it.
- **Only the sync's own close is one your reopen overrules**; an agent that closed the task is not the sync.
