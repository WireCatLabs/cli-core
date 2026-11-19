### Added

- **A read-only scheduled agent may stage project and meeting findings.** `projects actions add` and
  `meetings actions add` join `messages acknowledge` and `mail findings add` in the propose tier, when the host marks
  them `proposesOnly`. Like mail findings, each stages a cited batch the owner confirms or rejects; nothing becomes a
  fact or a task until he does. memo's task agent needs it to propose tasks from messengers and meetings.
