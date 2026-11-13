### Added

- **A call links to the CRM contact with the same phone.** A meeting source gives a participant's number
  in `SourceParticipant.phone` (written with `+`); the store keeps it in `identities.phone`. The people scan then
  joins the call's person and one other person when exactly the two hold the number, one of them is keyed by the
  number itself (`phone:<E.164>`, as a phone line keeps a call's other side) and the number is a mobile; a landline
  only proposes the pair, since an office's main line is everyone's who works there. The scan reads a CRM's number
  written without `+` (`8 (912) 345-67-89`) in the store's `phone_countries`, and the contact's other numbers too.
  See [MEETINGS.md, "Calls and the people they link to"](../docs/dev/MEETINGS.md#calls-and-the-people-they-link-to).
- **`meetings show` and `meetings people` name each participant's person**: `person: { ref, name }`, `null` when the
  identity is linked to no one; `meetings people` also finds a participant by that name.
- **A person's, an organization's and a deal's context list their recorded calls.** `contacts context` and the
  canonical person context answer `meetings[]` (`personMeetings`); `communicationsOf`, and so the deal and
  organization contexts, counts each call as a `meeting` touch with its `meeting:` ref; `deals show` and `leads show`
  of a CRM copy answer `meetings[]`, the newest 10 of the people on it. Each item opens with `meetings show
  <meeting_id>` of the CLI that owns its `account`.
- **`CORE_HOSTS` in `@wirecat/cli-core/constants`**: the hosts cli-core itself reaches in any tool (npm for
  `upgrade`, the default model providers, the model downloads and the hosts they redirect to). A tool spreads them
  into its WCAT identity's `hosts`, so `cli-dev manifest` lists them.

### Changed — may break callers

- **`oauth.missing` is now `session.missing`, and `ai.address-refused` is now `model.address-refused`.**
  One reason for each: a profile that is not signed in, and a model address WireCat refuses. A CLI that raises or
  checks the old names moves to the new ones.
- **The output schemas of `meetings show`, `meetings people`, `contacts context`, the person context and `deals
  show` / `leads show` gain the fields above.** A CLI that pins its MCP output schemas updates its contract.

### Fixed

- **A mistyped profile in `<PREFIX>_PROFILE` gets the profiles here too** (`profile.unknown`), as a mistyped first
  word does, and a CLI's own "no profile named …" is no longer said twice in the message.
- **`ownCatalogue` keeps a generated Bot API command as the CLI's own**, as `commands --json` marks it, so a
  bot's contract test pins its generated commands.

### Security

- **The update check, the model calls, the meeting embeddings and OpenAI transcription reach only their own host.**
  They go through cli-base's `hostFetch`: npm's registry, or the host of the model address the person set. A
  redirect to another host is refused, and each exchange has a deadline (2 minutes; 10 for a transcription).

- **A run with moved folders removes nothing in the owner's folders (WC-SECR-24).** With only `<PREFIX>_CONFIG_DIR`
  moved, `account remove` deleted the account file, the profile files and a stale serve lock in the owner's real
  state folder, and `--delete-data` purged the account from the owner's store. Now each of them is kept, with its
  reason under `kept`; the serve unit and schedules stay while `HOME` is the owner's.
  [ACCOUNT-REMOVAL.md](../docs/dev/ACCOUNT-REMOVAL.md)
