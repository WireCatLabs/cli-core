### Added

- **The owner edits a finding before deciding it.** `meetingFindings.edit`, `mailFindings.edit` and `evidenceFindings.edit` change a pending finding's text and the fields its kind allows (a task's title, due date and assignee, a fact's statement and subject, and so on). Evidence never changes, nor a meeting or evidence finding's project. The batch gets a new fingerprint, and the agent's re-staging of the same key still works. See [the findings guide](../docs/dev/MEETING-FINDINGS.md).
- **`related:` in the project-task query.** `related:"deal:7"`, `related:"lead:3"` or `related:"organization:4"` lists the tasks `deals context` and `organizations context` count: the project's tasks and those the CRM's stages opened, and for an organization those of its projects, deals and leads.
- **A company's address on any match.** `decideLink(…, { company: { mailbox } })` gives an address the owner names to an organization on a match that is not about a shared mailbox, such as one by name. The address must be one of the two people's, at a company's domain. The decision's result now names the `mailbox`.
- **Rename and delete an account group.** `renameAccountGroup(at, { from, to })` keeps the members and refuses a built-in, missing or taken name. `deleteAccountGroup(at, group)` removes the group and its memberships only. Nothing else in the store names a group, so a later run in the old name (`MEMO_GROUP`, a lock, `--source group:`) is refused with the groups there are.
- **The same company in the CRM counts as a trace.** Two people of one name whom the CRM puts in one organization are proposed at 0.5, as with a shared company domain.
- **One name in private chats on two messengers.** A person who writes under one name in a private chat the owner answers, on two messengers, is proposed at 0.3, even when the messenger hides the phone.

### Changed — may break callers

- **`<app>_tools_search` ranks by the words it matches.** A task phrase no longer needs every word to appear. The command's name counts most, then its title, then its help, examples and arguments; aliases count as the name. The command named exactly still comes first.
- **A partial confirm of a findings batch leaves the other findings waiting.** Before, every finding not named was rejected. A confirm with no names takes everything still waiting, and a reject rejects only what waits.
- **`hr@` starts below `info@`.** A shared `hr@` mailbox is proposed at 0.05, not 0.1, and a contact with only an `hr@` address is no longer called an organization.
- **A person's phone, address and username come from the identity that wrote the most** and has one, not from the oldest.

### Fixed

- **A person someone talks to in a private chat is no longer `automated`** because one of their mailboxes looked like a newsletter.
- **A person on one of the owner's own accounts** (a second profile the owner uses) no longer takes that profile's label as their name. They take the fullest name of their other identities.
