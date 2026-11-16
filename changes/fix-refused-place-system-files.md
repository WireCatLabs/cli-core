### Security

- **A file to send is refused under `/proc`, `/sys` and `/dev`**, through any link and even with `--allow-any-file`:
  `--file /proc/self/environ` sent the process's environment, which can hold a tool's token. `refusedPlace` refuses
  those paths too, and `readUpload` still takes only a regular file.
- **`refusedPlace` covers every WireCat tool's folders.** It takes them from `WIRECAT_TOOLS`, which now names each
  tool's `appName` and `envPrefix`, plus amo-cli and beeline-cli. zoom-cli's folders were missed: they
  were listed under the name `zm`, not `zoom-cli`.
