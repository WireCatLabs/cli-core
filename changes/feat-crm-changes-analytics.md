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
  repeated for more, replacing the record's whole list; an empty value clears it. A phone is taken only in
  international form (`+…`) and sent as E.164; anything else is refused with `crm.record-field`.
- **The copy keeps more of what the CRM says**: a contact's owner, times, page and custom values, a company's owner
  and times, each change of a deal's or lead's owner, and when an activity was done.
- **An update that gives one of your contacts or companies to another CRM user removes it from the copy**, with its
  phones, e-mails and the activities on it alone. The answer's `removed` says whether it went: `false` when one of
  your deals still names the contact, or you decided about it.
- **`pipelines show` answers `meta.timezone`**, the zone of its closed days, and `meta.window` with a window.
  `deals list` with two time terms names only the zone.

### Changed — may break callers

- **The CRM's stage history is read on every sync**, 90 days back at first, whatever the `stage-tasks` rules: the
  funnel, `deals.stages` and `deals show` count it (`stageEntriesOf`: the CRM's entries for a row that has any, else the
  copy's own changes). An entry on a deal the copy does not hold yet is kept and counts once the deal arrives. A stage
  task opens for an entry made after the rules were first set (the mark beside the setting keeps that time) and in the
  last 7 days, so a deal the copy missed for a sync still gets its task, and one that joins the copy later opens none
  for its older moves. A handled entry is marked in its fields; an entry no stored deal claimed for 90 days is marked
  deleted.
- **The copy stores a `crm.person` record per contact and a `crm.owner-change` record per owner change**, and an
  activity's record gains `done_at`. `store.crm.removeContact(key, id)` removes one contact by the CRM's id;
  `CrmRecordWritten` gains `removed`.
- **`createCrmRecord` and `updateCrmRecord` refuse a phone without `+`** that they passed on before.
- **`pipelines list`, `stages list` and `pipelines show` leave out a stage the CRM removed** unless a row stands in
  it: a caller that reads stages by position sees fewer.
- **`deal_context.stages[]` gains `exact`** in its strict schema.
- **`PipelineReport` gains `window`, `closed`, `cycle`, `owners`, `lost_reasons` and `history`**, and
  `deals.pipeline(ref, options)` takes `since` and `until` as a `YYYY-MM-DD` day or an ISO time and `zone`
  (`PipelineOptions`). `StageChange` gains `exact`; its `from` is `null` for the first entry the CRM's history names.
- **`CrmActivity.on` takes any `CrmKind`**: an activity on a contact or company the copy holds is stored.
- **`CrmOrganizationFields` has `emails` and `phones`**: a writer maps them; `crmWriteContract` checks a company's
  phone and e-mail.
- **`queryTerms` takes the fields its caller reads with `nativeTerms`** as a fourth argument.

### Fixed

- **The funnel counted a deal first synced already lost in no stage**: such a row now reached the first stage,
  so a fresh copy of a CRM no longer overstates the first stage's conversion. A stage the CRM removed leaves pipelines
  and the funnel unless a row stands in it.
- **A closed deal's `closed_date` moved with every later edit** when the CRM gives no closed day: the day first
  stored stays, until the deal turns from won to lost or back. A first closed day is your day of the CRM's last edit,
  not the UTC one.
- **A `YYYY-MM-DD` bound of `deals.pipeline` was a UTC day**: it is now the day in `zone`.
- **A sync whose activities or stage history stop on the run's budget still removes the contacts outside the scope.**
