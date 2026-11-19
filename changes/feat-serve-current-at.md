### Added

- **`server status` says when the store was last current (`current_at`).** `serve` writes the time beside its lock
  when it connects, every minute while it runs and as it stops, and the file stays after it stops. A messenger with
  no full sync, such as WhatsApp, now has a time to show once serve is off; the text answer says "The store was
  current at …". `account remove` and `account rename` take the file with the profile.
