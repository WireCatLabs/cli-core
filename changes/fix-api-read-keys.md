### Fixed

- **A raw read that names its command's read key is sent as a read.** A CLI can put `people.list` on `api
  contacts-list`, so `people: deny` stops the raw read too (WC-PERM-22). Before, any key beyond `api.*` sent the read
  the way a write goes, with an `operation_id` in the answer, and refused `--all`. Now `deny` refuses it, `allow`
  sends it as a read with `--all`, and only `ask` keeps the write's path. Found by the hubspot-cli review.
