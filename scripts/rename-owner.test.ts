import { describe, expect, it } from "vitest"
import { leftovers, RULES, rewrite } from "./rename-owner.ts"

const github = (text: string) => rewrite(text, RULES.github).text
const npm = (text: string) => rewrite(text, RULES.npm).text

describe("github pass", () => {
  it.each(["cli-meetings", "cli-testing", "zoom-cli", "community", ".github"])("covers %s", (repo) => {
    expect(github(`https://github.com/legacy-owner/${repo}/blob/main/README.md`)).toBe(
      `https://github.com/WireCatLabs/${repo}/blob/main/README.md`,
    )
  })
  it("treats repository-name punctuation literally", () => {
    expect(github("https://github.com/legacy-owner/xgithub")).toBe("https://github.com/legacy-owner/xgithub")
  })
  it.each([
    ["https://github.com/legacy-owner/max-cli/issues", "https://github.com/WireCatLabs/max-cli/issues"],
    ["git@github.com:legacy-owner/tg-cli.git", "git@github.com:WireCatLabs/tg-cli.git"],
    [
      "uses: legacy-owner/cli-core/.github/workflows/node-ci.yml@b8acbeebf38cd37edcdcc193152ba5d2c11928cb # v0.17.2",
      "uses: WireCatLabs/cli-core/.github/workflows/node-ci.yml@b8acbeebf38cd37edcdcc193152ba5d2c11928cb # v0.17.2",
    ],
    ["repository: legacy-owner/${{ matrix.cli }}-cli", "repository: WireCatLabs/${{ matrix.cli }}-cli"],
    [
      "/^https:\\/\\/github\\.com\\/legacy-owner\\/max-cli\\/issues/",
      "/^https:\\/\\/github\\.com\\/WireCatLabs\\/max-cli\\/issues/",
    ],
    ["gh pr list --repo legacy-owner/cli-private", "gh pr list --repo WireCatLabs/cli-private"],
    ["`https://github.com/legacy-owner/${cli}-cli.git`", "`https://github.com/WireCatLabs/${cli}-cli.git`"],
    ["gh api repos/legacy-owner/<repo> --jq .state", "gh api repos/WireCatLabs/<repo> --jq .state"],
    ['gh api "repos/legacy-owner/$repo/code-scanning/alerts"', 'gh api "repos/WireCatLabs/$repo/code-scanning/alerts"'],
    [
      "names: `legacy-owner` / `cli-messaging` / `release.yml`",
      "names: `WireCatLabs` / `cli-messaging` / `release.yml`",
    ],
  ])("moves %s", (before, after) => {
    expect(github(before)).toBe(after)
  })

  it.each([
    '"@legacy-owner/max-cli": "0.39.0"',
    "/home/legacy-owner/Projects/AI/max-cli",
    "/home/legacy-owner/${dir}/max-cli",
    "cd /home/legacy-owner/$dir",
    "https://github.com/legacy-owner/brazecli",
    "https://github.com/legacy-owner/cli-messaging-archive",
  ])("leaves %s", (text) => {
    expect(github(text)).toBe(text)
  })
})

describe("npm pass", () => {
  it.each(["cli-meetings", "cli-testing", "zoom-cli"])("covers %s", (pkg) => {
    expect(npm(`npm install -g @legacy-owner/${pkg}`)).toBe(`npm install -g @wirecat/${pkg}`)
  })
  it.each([
    [
      'import { CliError } from "@legacy-owner/cli-core/commands"',
      'import { CliError } from "@wirecat/cli-core/commands"',
    ],
    ['"@legacy-owner/cli-messaging-sqlite": "1.0.0"', '"@wirecat/cli-messaging-sqlite": "1.0.0"'],
    ["npm publish legacy-owner-cli-messaging-onnx-*.tgz", "npm publish wirecat-cli-messaging-onnx-*.tgz"],
    ['npm publish "legacy-owner-max-cli-$VERSION.tgz"', 'npm publish "wirecat-max-cli-$VERSION.tgz"'],
    [
      "scripts/install-unix.test.mjs package/legacy-owner-max-cli-*.tgz",
      "scripts/install-unix.test.mjs package/wirecat-max-cli-*.tgz",
    ],
    [
      'curl "https://registry.npmjs.org/@legacy-owner%2fmax-cli/$VERSION"',
      'curl "https://registry.npmjs.org/@wirecat%2fmax-cli/$VERSION"',
    ],
    ["node_modules\\@legacy-owner\\max-cli\\dist", "node_modules\\@wirecat\\max-cli\\dist"],
    ['"node_modules\\\\@legacy-owner\\\\max-cli"', '"node_modules\\\\@wirecat\\\\max-cli"'],
    [
      'const PACKAGE_DIR = ["node_modules", "@legacy-owner", "max-cli"]',
      'const PACKAGE_DIR = ["node_modules", "@wirecat", "max-cli"]',
    ],
    ["/--package=@legacy-owner\\/tg-cli -- tg/", "/--package=@wirecat\\/tg-cli -- tg/"],
    ['join(runtime, "node_modules/@legacy-owner")', 'join(runtime, "node_modules/@wirecat")'],
    ["`npm install -g @legacy-owner/${tool}-cli`", "`npm install -g @wirecat/${tool}-cli`"],
    ['- dependency-name: "@legacy-owner/*"', '- dependency-name: "@wirecat/*"'],
    ['$package = "@legacy-owner/$Tool-cli"', '$package = "@wirecat/$Tool-cli"'],
    ["--package=@legacy-owner/<tool>-cli", "--package=@wirecat/<tool>-cli"],
    ["/@legacy-owner\\/(tg|max)-cli\\b/", "/@wirecat\\/(tg|max)-cli\\b/"],
    ['name.startsWith("@legacy-owner/")', 'name.startsWith("@wirecat/")'],
    ["published to npm under `@legacy-owner`:", "published to npm under `@wirecat`:"],
  ])("moves %s", (before, after) => {
    expect(npm(before)).toBe(after)
  })

  it.each([
    '"@legacy-owner/brazecli": "0.4.0"',
    'lock="${XDG_RUNTIME_DIR:-/tmp}/legacy-owner-release.lock"',
    "secret-tool lookup service npm account legacy-owner",
    "https://github.com/legacy-owner/max-cli",
  ])("leaves %s", (text) => {
    expect(npm(text)).toBe(text)
  })

  it("counts each rule it used", () => {
    const { counts } = rewrite(
      '"@legacy-owner/cli-core" "@legacy-owner/tg-cli" legacy-owner-tg-cli-1.0.0.tgz',
      RULES.npm,
    )
    expect(Object.fromEntries(counts)).toEqual({ package: 2, tarball: 1 })
  })
})

describe("leftovers", () => {
  it("names what was kept on purpose and flags the rest", () => {
    expect(leftovers("token=$(secret-tool lookup service npm account legacy-owner) # /home/legacy-owner/x")).toEqual([
      "home path",
      "keyring account",
    ])
    expect(leftovers("see legacy-owner's notes")).toEqual(["unexplained"])
  })
})
