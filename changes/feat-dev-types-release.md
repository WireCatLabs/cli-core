### Added

- **Users no longer get cli-core's type files; developers get them from `X.Y.Z-dev`.** Every release now publishes
  two versions from one build: `X.Y.Z` (tag `latest`) without `.d.ts`, `.d.ts.map`, `.js.map` or `src/`, and
  `X.Y.Z-dev` (tag `dev`) with them, the same JavaScript byte for byte. The install of a CLI is about 12 MB and
  1,676 files smaller. A CLI repository keeps `"@wirecat/cli-core": "X.Y.Z"` in `package.json` and adds
  `"@wirecat/cli-core": X.Y.Z-dev` under `overrides:` in `pnpm-workspace.yaml`; without it `tsc` fails with TS7016,
  "Could not find a declaration file for module '@wirecat/cli-core'". `cli-dev adopt` from cli-base writes the line
  ([Architecture](../docs/dev/ARCHITECTURE.md#the-two-packages-of-a-release)).
