### Added

- **`meetings show` names a recording's file on this computer.** Each of `attachments` carries `local_path`: the
  file the store holds for it, or `null` when it stays on the meeting service or the phone system (pbx reading its
  recordings over SFTP). WireCat Desktop plays a call's recording from it and reads nothing else.
