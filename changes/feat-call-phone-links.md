### Added

- **A call links to the CRM contact with the same phone.** A meeting source gives a participant's number
  in `SourceParticipant.phone` (written with `+`); the store keeps it in `identities.phone`. The people scan then
  joins the call's person and one other person when exactly the two hold the number, one of them is keyed by the
  number itself (`phone:<E.164>`, as a phone line keeps a call's other side) and the number is a mobile; a landline
  only proposes the pair, since an office's main line is everyone's who works there. See [MEETINGS.md, "Calls and the people they link to"](../docs/dev/MEETINGS.md#calls-and-the-people-they-link-to).
- **`meetings show` and `meetings people` name each participant's person**: `person: { ref, name }`, `null` when the
  identity is linked to no one; `meetings people` also finds a participant by that name.
- **A person's, an organization's and a deal's context list their recorded calls.** `contacts context` and the
  canonical person context answer `meetings[]` (`personMeetings`); `communicationsOf`, and so the deal and
  organization contexts, counts each call as a `meeting` touch with its `meeting:` ref; `deals show` and `leads show`
  of a CRM copy answer `meetings[]`, the newest 10 of the people on it. Each item opens with `meetings show
  <meeting_id>` of the CLI that owns its `account`.

### Changed — may break callers

- **`oauth.missing` is now `session.missing`, and `ai.address-refused` is now `model.address-refused`.**
  One reason for each: a profile that is not signed in, and a model address WireCat refuses. A CLI that raises or
  checks the old names moves to the new ones.
- **The output schemas of `meetings show`, `meetings people`, `contacts context`, the person context and `deals
  show` / `leads show` gain the fields above.** A CLI that pins its MCP output schemas updates its contract.

### Security

- **A run with moved folders removes nothing in the owner's folders (WC-SECR-24).** With only `<PREFIX>_CONFIG_DIR`
  moved, `account remove` deleted the account file, the profile files and a stale serve lock in the owner's real
  state folder, and `--delete-data` purged the account from the owner's store. Now each of them is kept, with its
  reason under `kept`; the serve unit and schedules stay while `HOME` is the owner's.
  [ACCOUNT-REMOVAL.md](../docs/dev/ACCOUNT-REMOVAL.md)
