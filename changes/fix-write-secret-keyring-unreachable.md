### Fixed

- **A second secret saves to the file when the keyring does not answer.** `ProfileTokenStore#writeSecret` read the
  profile's old entry first, and since cli-base 0.108 that read throws `keyring.unreachable` when the keyring fails
  and the file has no entry. So `setup apply` of a profile with two passwords (pbx: the database and SFTP or SSH)
  failed on a computer with no keyring, where it used to save to the private file. That read now counts as no old
  entry, as `write` has done since 0.685.0.
