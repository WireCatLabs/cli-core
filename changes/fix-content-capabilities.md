### Fixed

- **A content kind read by several calls syncs for a role refused one of them.** A WordPress author or
  contributor may not list pages with a private status: WordPress answers HTTP 400 with 403 in its details, and the
  whole `post` kind failed, so even their own posts stopped syncing. A call's `optional.needs` names a rights read
  and a `check`; unless it is true the call is never sent, and the sync reports a gap with its own text. The kind's
  other calls sync as before, and the gap holds deletions, so no stored row is marked deleted for a skipped call.
  Each rights read is sent once per source, whatever it checks.
- **A refusal's inner status is kept.** A read refused with a status whose answer names another under `details`
  (WordPress's 400 with 403 inside) keeps that number as `inner_status`; the service's text stays out. A content
  source takes such a 400 with 403 as a refusal, so `optional` reports a gap for it.

### Added

- **`contentManifestFake` takes `lacks` and `denied`:** the rights a sign-in lacks (its rights reads answer false,
  and a call whose `needs` is lacked is refused as WordPress refuses it) and the operations refused with 403.
