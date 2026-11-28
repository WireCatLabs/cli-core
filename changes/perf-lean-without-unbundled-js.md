### Changed — may break callers

- **Users no longer get cli-core's unbundled `.js`: the installed package is 17.1 MB instead of 34.5 MB.** Since
  3.0 everything `exports` names loads from `dist/bundle/`, so the 1,678 tsc files beside it were never run. `X.Y.Z`
  keeps only the 12 that a process starts by path, listed in `dist/by-path.json`: the embedding process
  `dist/embeddings/child.js`, the `cli-core-parity` bin, and what the two import. `X.Y.Z-dev` keeps all of them. A
  CLI that imports or mocks a file under `node_modules/@wirecat/cli-core/dist/` outside `dist/bundle/` passes in its
  own checkout and fails where users install it: use an entry point. The release fails when the user package ships
  another unbundled `.js` or lacks a listed one, and `scripts/install-size.ts` fails when a listed file cannot load
  what it imports ([Architecture](../docs/dev/ARCHITECTURE.md#the-two-packages-of-a-release)).
