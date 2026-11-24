/**
 * A setup text for a terminal: Desktop draws its restricted Markdown, a terminal shows `#`, `**`, backticks and
 * `[…](…)` as typed. Headings, bold and code lose their marks. A link keeps its address beside its words, since the
 * address is what a person copies, unless `link` draws it, as a terminal that shows OSC 8 links does. Single `*` and
 * `_` stay: in plain text they are as often a product or a name as italics.
 * @experimental
 */
export const plainSetupText = (
  text: string,
  {
    link = (label: string, href: string) => `${label} (${href})`,
  }: { link?: (label: string, href: string) => string } = {},
): string =>
  text
    .replace(/^#{1,3} +/gm, "")
    .replace(/\[([^\]\n]*)\]\(([^)\s]*)\)/g, (_all, label: string, href: string) =>
      !label || [href, href.replace(/^https:\/\//, "")].includes(label) ? href : link(label, href),
    )
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
