### Fixed

- **`crmFilesContract` passes on Windows.** It asserted mode 0600 on a downloaded file and 0700 on the files folder
  there too, and Windows, which has no POSIX modes, reports 0666; bitrix24-cli's 0.27.0 release stopped on it. The
  mode checks now run on Linux and macOS only.
