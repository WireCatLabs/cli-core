### Added

- **Tags on calls and other meetings, from a search: `addMeetingTagsCommand`** in `@wirecat/cli-core/cli` mounts
  `tags add|remove|list` for a host whose meetings are its records, such as pbx and beeline.
  `tags add complaint --matching "refund OR complaint"` labels every meeting of the account where `search meetings`
  finds the query; `--meeting <id>` (repeatable) labels by id. A rerun after new calls are transcribed labels only
  those, and `changed` in the `meeting_tag_change` answer says which. `tags list tag:complaint` answers
  `meeting_tagging` items with the call's title marked untrusted. The labels are the store's ordinary taggings, so
  `search meetings --tag complaint` and memo's `tags list` see them. The service is `meetingTags` in
  `@wirecat/cli-core/services`. A mark stays when a new transcript of the call no longer says the words.
- cli-core's command lint now also checks a calls host's program: `stats calls show`, `search meetings` and the
  meeting `tags`, with cli-base's `calls`, `--matching` and `--tag`.

### Fixed

- **`knowledge.labelled` with an account lists only that account's meetings, and never a deleted meeting.** With
  `null`, as memo calls it, it still lists every account's meetings, now without the deleted ones.
