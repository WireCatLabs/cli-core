### Added

- **`pipelines show --since-time <time> --until-time <time>`** answers the funnel over the deals or leads made in the
  window and, beside it, `window`, `closed` (won, lost, win rate and won amounts per currency of the rows closed on a
  day in the window, in your time zone), `cycle` (the median days from made to won), `owners` (the window's rows by
  their CRM assignee), `lost_reasons` (the ten most common) and `history` (how many rows had the CRM's own stage
  history). Each stage gains `median_days`, the median stay before a row moved on. The terminal view adds the closed,
  cycle and owner lines.
- **`deals list` and `leads list` take `updated:`, `created:`, `closed:` and `owner:`**: `updated:>=1d`,
  `created:>=30d`, `closed:[2026-11-01 TO 2026-11-07]` (the day it was won or lost, in your time zone), `owner:me` (the
  sign-in's user, the `self` setting; refused with `crm.owner-unknown` when the CRM names none), `owner:none` and
  `owner:<user id>`. With a time term the answer's `meta` names the time zone and the window.
- **`deals show` answers `stage_history`**: every stage the deal entered, oldest first, `exact` when the CRM's own
  history gave it.
- **`stages list` answers `stage_task`** per stage: the title and `due_days` of the task its `stage-tasks` rule
  opens, or `null`.
- **`people create|update` and `organizations create|update` take `--email <address>` and `--phone <phone>`**, each
  repeated for more, replacing the record's whole list. A phone is taken only in international form (`+…`) and sent as
  E.164; anything else is refused with `crm.record-field`.
- **The copy keeps more of what the CRM says**: a contact's owner, times, page and custom values (a `crm.person`
  record), a company's owner and times, a `crm.owner-change` record when a deal's or lead's assignee changes, and
  `done_at` on an activity once it is done. `store.crm.removeContact` removes one contact by the CRM's id.

### Changed — may break callers

- **The CRM's stage history is read on every sync**, 90 days back at first, whatever the `stage-tasks` rules: the
  funnel, `deals.stages` and `deals show` count it (`stageEntriesOf`: the CRM's entries for a row that has any, else the
  copy's own changes). An entry on a deal the copy does not hold yet is kept and counts once the deal arrives; it opened
  no task before. A handled entry is marked in its fields, not deleted; an entry no stored deal claimed for 90
  days is marked deleted. A stage task still opens only for an entry made after the rules were first set: the mark
  beside the setting keeps that time.
- **`PipelineReport` gains `window`, `closed`, `cycle`, `owners`, `lost_reasons` and `history`**, and
  `deals.pipeline(ref, options)` takes `since` and `until` as a `YYYY-MM-DD` day or an ISO time and `zone`
  (`PipelineOptions`). `StageChange` gains `exact`; its `from` is `null` for the first entry the CRM's history names.
- **`CrmActivity.on` takes any `CrmKind`**: an activity on a contact or company the copy holds is stored.
- **`CrmOrganizationFields` has `emails` and `phones`**: a writer maps them; `crmWriteContract` checks a company's
  phone.
- **An update that gives an own contact to another CRM user removes it from the copy**, its identity's phones and
  e-mails with it, as a company already was.
- **`queryTerms` takes the fields its caller reads with `nativeTerms`** as a fourth argument.

### Fixed

- **The funnel counted a deal first synced already lost in no stage**: such a row now reached the first stage,
  so a fresh copy of a CRM no longer overstates the first stage's conversion. A stage the CRM removed leaves pipelines
  and the funnel unless a row stands in it.
- **A closed deal's `closed_date` moved with every later edit** when the CRM gives no closed day: the day first
  stored stays.
