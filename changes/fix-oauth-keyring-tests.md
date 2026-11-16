### Fixed

- **A sign-in with `storage: "keyring"` stops before the browser when the keyring does not answer.** #3041 made the
  check before a sign-in read an unreachable keyring as "no old entry", so the browser opened and the save failed
  after it. That holds only where the save can fall back to the file; with keyring-only storage the check fails up
  front again, with cli-base's `keyring.unreachable`.
