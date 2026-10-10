import { describe, expect, it } from "vitest"
import { leftovers, RULES, rewrite } from "./rename-owner.ts"

const github = (text: string) => rewrite(text, RULES.github).text
const npm = (text: string) => rewrite(text, RULES.npm).text

describe("github pass", () => {
  it.each(["cli-meetings", "cli-testing", "zoom-cli", "community", ".github"])("covers %s", (repo) => {
    expect(github(`https://github.com/leemour/${repo}/blob/main/README.md`)).toBe(
      `https://github.com/WireCatLabs/${repo}/blob/main/README.md`,
    )
  })
  it("treats repository-name punctuation literally", () => {
    expect(github("https://github.com/leemour/xgithub")).toBe("https://github.com/leemour/xgithub")
  })
  it.each([
    ["https://github.com/leemour/max-cli/issues", "https://github.com/WireCatLabs/max-cli/issues"],
    ["git@github.com:leemour/tg-cli.git", "git@github.com:WireCatLabs/tg-cli.git"],
    [
      "uses: leemour/cli-core/.github/workflows/node-ci.yml@b8acbeebf38cd37edcdcc193152ba5d2c11928cb # v0.17.2",
      "uses: WireCatLabs/cli-core/.github/workflows/node-ci.yml@b8acbeebf38cd37edcdcc193152ba5d2c11928cb # v0.17.2",
    ],
    ["repository: leemour/${{ matrix.cli }}-cli", "repository: WireCatLabs/${{ matrix.cli }}-cli"],
    [
      "/^https:\\/\\/github\\.com\\/leemour\\/max-cli\\/issues/",
      "/^https:\\/\\/github\\.com\\/WireCatLabs\\/max-cli\\/issues/",
    ],
    ["gh pr list --repo leemour/cli-private", "gh pr list --repo WireCatLabs/cli-private"],
    ["`https://github.com/leemour/${cli}-cli.git`", "`https://github.com/WireCatLabs/${cli}-cli.git`"],
    ["gh api repos/leemour/<repo> --jq .state", "gh api repos/WireCatLabs/<repo> --jq .state"],
    ['gh api "repos/leemour/$repo/code-scanning/alerts"', 'gh api "repos/WireCatLabs/$repo/code-scanning/alerts"'],
    ["names: `leemour` / `cli-messaging` / `release.yml`", "names: `WireCatLabs` / `cli-messaging` / `release.yml`"],
  ])("moves %s", (before, after) => {
    expect(github(before)).toBe(after)
  })

  it.each([
    '"@leemour/max-cli": "0.39.0"',
    "/home/leemour/Projects/AI/max-cli",
    "/home/leemour/${dir}/max-cli",
    "cd /home/leemour/$dir",
    "https://github.com/leemour/brazecli",
    "https://github.com/leemour/cli-messaging-archive",
  ])("leaves %s", (text) => {
    expect(github(text)).toBe(text)
  })
})

describe("npm pass", () => {
  it.each(["cli-meetings", "cli-testing", "zoom-cli"])("covers %s", (pkg) => {
    expect(npm(`npm install -g @leemour/${pkg}`)).toBe(`npm install -g @wirecat/${pkg}`)
  })
  it.each([
    ['import { CliError } from "@leemour/cli-core/commands"', 'import { CliError } from "@wirecat/cli-core/commands"'],
    ['"@leemour/cli-messaging-sqlite": "1.0.0"', '"@wirecat/cli-messaging-sqlite": "1.0.0"'],
    ["npm publish leemour-cli-messaging-onnx-*.tgz", "npm publish wirecat-cli-messaging-onnx-*.tgz"],
    ['npm publish "leemour-max-cli-$VERSION.tgz"', 'npm publish "wirecat-max-cli-$VERSION.tgz"'],
    [
      "scripts/install-unix.test.mjs package/leemour-max-cli-*.tgz",
      "scripts/install-unix.test.mjs package/wirecat-max-cli-*.tgz",
    ],
    [
      'curl "https://registry.npmjs.org/@leemour%2fmax-cli/$VERSION"',
      'curl "https://registry.npmjs.org/@wirecat%2fmax-cli/$VERSION"',
    ],
    ["node_modules\\@leemour\\max-cli\\dist", "node_modules\\@wirecat\\max-cli\\dist"],
    ['"node_modules\\\\@leemour\\\\max-cli"', '"node_modules\\\\@wirecat\\\\max-cli"'],
    [
      'const PACKAGE_DIR = ["node_modules", "@leemour", "max-cli"]',
      'const PACKAGE_DIR = ["node_modules", "@wirecat", "max-cli"]',
    ],
    ["/--package=@leemour\\/tg-cli -- tg/", "/--package=@wirecat\\/tg-cli -- tg/"],
    ['join(runtime, "node_modules/@leemour")', 'join(runtime, "node_modules/@wirecat")'],
    ["`npm install -g @leemour/${tool}-cli`", "`npm install -g @wirecat/${tool}-cli`"],
    ['- dependency-name: "@leemour/*"', '- dependency-name: "@wirecat/*"'],
    ['$package = "@leemour/$Tool-cli"', '$package = "@wirecat/$Tool-cli"'],
    ["--package=@leemour/<tool>-cli", "--package=@wirecat/<tool>-cli"],
    ["/@leemour\\/(tg|max)-cli\\b/", "/@wirecat\\/(tg|max)-cli\\b/"],
    ['name.startsWith("@leemour/")', 'name.startsWith("@wirecat/")'],
    ["published to npm under `@leemour`:", "published to npm under `@wirecat`:"],
  ])("moves %s", (before, after) => {
    expect(npm(before)).toBe(after)
  })

  it.each([
    '"@leemour/brazecli": "0.4.0"',
    'lock="${XDG_RUNTIME_DIR:-/tmp}/leemour-release.lock"',
    "secret-tool lookup service npm account leemour",
    "https://github.com/leemour/max-cli",
  ])("leaves %s", (text) => {
    expect(npm(text)).toBe(text)
  })

  it("counts each rule it used", () => {
    const { counts } = rewrite('"@leemour/cli-core" "@leemour/tg-cli" leemour-tg-cli-1.0.0.tgz', RULES.npm)
    expect(Object.fromEntries(counts)).toEqual({ package: 2, tarball: 1 })
  })
})

describe("leftovers", () => {
  it("names what was kept on purpose and flags the rest", () => {
    expect(leftovers("token=$(secret-tool lookup service npm account leemour) # /home/leemour/x")).toEqual([
      "home path",
      "keyring account",
    ])
    expect(leftovers("see leemour's notes")).toEqual(["unexplained"])
  })
})
