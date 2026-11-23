import { Command } from "commander"
import { describe, expect, it } from "vitest"
import {
  hasOwnAction,
  helpOptionOf,
  hide,
  isHidden,
  onUnknownOption,
  rejectUnknownOption,
} from "./commander-internals.js"

const program = () => {
  const root = new Command("app").exitOverride()
  root
    .command("group")
    .command("leaf")
    .action(() => {})
  return root
}

describe("the commander fields the skeleton reads", () => {
  it("tells a command with an action from a group", () => {
    const root = program()
    const group = root.commands[0] as Command
    expect(hasOwnAction(group)).toBe(false)
    expect(hasOwnAction(group.commands[0] as Command)).toBe(true)
  })

  it("hides a command after it was added, and commander's help leaves it out", () => {
    const root = program()
    const group = root.commands[0] as Command
    expect(isHidden(group)).toBe(false)
    hide(group)
    expect(isHidden(group)).toBe(true)
    expect(root.helpInformation()).not.toContain("group")
  })

  it("finds the help option", () => {
    const help = helpOptionOf(program())
    expect(help?.long).toBe("--help")
    expect([help?.is("-h"), help?.is("--help"), help?.is("--nope")]).toEqual([true, true, false])
  })

  it("fails on an unknown option, and lets a handler replace that failure", () => {
    const root = program().configureOutput({ writeErr: () => {} })
    expect(() => rejectUnknownOption(root, "--nope")).toThrow(
      expect.objectContaining({ code: "commander.unknownOption" }),
    )
    onUnknownOption(root, (flag, fallback) => (flag === "--nope" ? root.error("hinted") : fallback(flag)))
    expect(() => rejectUnknownOption(root, "--nope")).toThrow("hinted")
    expect(() => rejectUnknownOption(root, "--other")).toThrow(
      expect.objectContaining({ code: "commander.unknownOption" }),
    )
  })
})
