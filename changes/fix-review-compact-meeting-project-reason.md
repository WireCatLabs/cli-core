### Fixed

- **Confirming a proposed meeting project keeps the owner's reason.** `linkMeetingProject` with
  `expectedFingerprint` and `provenance` now stores the owner's reason; before, the agent's stayed.

### Changed — may break callers

- **A stale meeting project fingerprint is `conflict`, not `configuration_error`** (reason `meeting-project.stale`).
  A caller that checks the code moves to `conflict`.
