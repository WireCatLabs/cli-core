# Reviewed meeting findings

Use the shared store's `meetingFindings` capability to stage cited decisions, facts and project work
for owner review. It returns a stable batch preview; review creates selected records and one receipt
atomically. This developer contract requires stored transcript cues and confirmed project membership.

## Stage a batch

Call `stage(account, input, agent)` with an explicit provider/account and an agent author supplied by
the host, independently of the submitted payload. `schemaVersion: 1` takes a stable batch key,
extractor identity and 1–16 findings, within 65,536 UTF-8 bytes. Reusing a key for the same normalized
input and author returns its existing batch. A changed payload or agent model needs a new key.

Every finding has a unique caller ID, a global `project:<id>` and 1–8 exact cue references with their
fingerprints from the meeting evidence reader. The native transaction checks the account, current
transcript revision, cue content and confirmed meeting/project membership. No title match, speaker
name or reused meeting room establishes membership or a person's identity.

A fact uses an existing fact type and a statement. A task supplies an existing work-task type
(`bug`, `chore`, `feature`), title, reason and `explicit` or `inferred` commitment. Optional dates and
known-person assignments require supporting references drawn from that finding's evidence. Omit
unknown dates and assignees. These checks establish source identity, not semantic truth: a reader
must still check whether a statement is a decision or a proposal, and whether a cue supports a date.

Staging stores a proposed batch. It creates no fact or task. `previous` shows unchanged candidates
already accepted or rejected through an earlier findings review in this account. Matching is exact
candidate/evidence matching, not semantic duplicate detection against manually created records.

## Review the preview

Only an owner-facing host action should call `review(account, id, { fingerprint, accept })`. A
producer MCP tool must not expose review. `accept` lists the displayed candidate IDs to create;
other new candidates are rejected. The entire preview fingerprint must match. Pending review also
rechecks live sources and the project/assignment snapshot, so edits cannot silently change a pending
review. Stage a new batch when its preview is stale.

Review uses one synchronous native transaction. It reuses existing fact and work-task operations,
records agent provenance, accepts selected facts as the owner, links task evidence, and writes the
proposal's decision receipt. A later write failure rolls everything back, including task numbering.
It never sends a message, creates an invitation or executes a task.

A receipt keeps each candidate fingerprint and resulting reference. Repeating the same review
returns that receipt; changing its selection is refused. A later batch reuses accepted references
and suppresses rejected unchanged candidates. Existing decisions stay in force: omitting an already
accepted candidate does not revoke it. Trying to accept a previously rejected unchanged candidate is
refused. Changed cue evidence produces a different candidate. Normal task/fact review commands own
later edits or reversals.

Reviewed historical receipts survive later transcript revisions and retain the original citations.
They do not recreate a record that someone subsequently removed. This is retry protection, not a
claim that a whole archive was searched or that two paraphrases describe different work.

## Persistence boundary

The reserved `meeting_findings` kind reuses proposed-action storage, author and decision fields. It
has no generic approve-as-task or generic state-transition path. The dedicated API validates and
writes its payload and receipt; generic creation of that kind is refused. No new schema migration
or provider-specific knowledge tables are needed.

Facts and task writes expose internal synchronous operations beneath their unchanged Promise ports.
A native transaction must never await those public Promise methods. `meetingFindings` is available
through the shared `MessageStore`; hosts must use their pinned released Core export when rolling out.

Synthetic coverage lives in `src/store/meeting-findings.test.ts`: replay, exact cross-batch reuse,
rejected-candidate suppression, foreign accounts, stale cues and membership, historical receipts,
assignment/date evidence, generic-approval isolation and transaction rollback.
