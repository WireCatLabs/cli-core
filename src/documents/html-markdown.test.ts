import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { htmlToMarkdown, markdownToHtml } from "./html-markdown.js"

// One post, as WordPress 6.9.4 (wordpress:6-php8.3-apache) stores it (`wp post get --field=post_content`, block markup
// written for it) and renders it (`the_content`), and as Ghost 6.78.0 renders it after `POST /posts/?source=html` of
// WordPress's rendering. Taken 2026-11-18 from throwaway local Docker instances.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../../test/fixtures/posts", name), "utf8")
const POSTS = ["wordpress-raw.html", "wordpress-rendered.html", "ghost.html"]

describe("htmlToMarkdown on real posts", () => {
  it.each(POSTS)("%s keeps the headings, links, lists, image, code and table, and none of the markup", async (name) => {
    const markdown = await htmlToMarkdown(fixture(name))
    expect(markdown).toContain("## Why we moved")
    expect(markdown).toContain("[our notes](https://example.com/notes?a=1\\&b=2)")
    expect(markdown).toMatch(/\* Second point with a \[relative link\]\([^)]*\/relative\)\n {2}\* Nested/)
    expect(markdown).toContain("1. One\n2. Two")
    expect(markdown).toContain("![The old rack](https://blog.example/wp-content/uploads/2026/11/rack.jpg)")
    expect(markdown).toContain('```\ndocker compose up -d\necho "a < b && c"\n```')
    expect(markdown).toMatch(/\| Host +\| CPU \|/)
    expect(markdown).toContain("Ünïcödé — «кавычки» and an emoji 🚀.")
    expect(markdown).not.toMatch(/<!--|wp:|kg-card|<script|alert|steal|class=/)
  })

  it("gives the same Markdown back after a pass through HTML", async () => {
    for (const name of POSTS) {
      const markdown = await htmlToMarkdown(fixture(name))
      expect(await htmlToMarkdown(await markdownToHtml(markdown)), name).toBe(markdown)
    }
  })
})

describe("an untrusted body", () => {
  it("loses links and images that run code or read files, in both directions, and keeps their text", async () => {
    const html =
      '<p><a href="javascript:alert(1)">x</a> <a href=" JaVa\tScRiPt:y">y</a> <img src="data:text/html,z" alt="z"> <a href="file:///etc/passwd">f</a> <a href="/ok:1">ok</a> <a href="#top">top</a></p>'
    expect(await htmlToMarkdown(html)).toBe("x y z f [ok](/ok:1) [top](#top)\n")
    const back = await markdownToHtml(
      "[x](javascript:alert(1)) ![i](vbscript:x) [m](mailto:a@b.example)\n\n[r]: javascript:r\n",
    )
    expect(back).toBe('<p>x i <a href="mailto:a@b.example">m</a></p>')
  })

  it("drops an encoded scheme, a script after a comment, and an unsafe link around a safe image", async () => {
    const html =
      '<p><a href="&#106;avascript:x">e</a></p><!--x--><script>y()</script><p>t</p><a href="javascript:z"><img src="https://i.example/a.png" alt="a"></a>'
    expect(await htmlToMarkdown(html)).toBe("e\n\nt\n\n![a](https://i.example/a.png)\n")
  })

  it("leaves a reference to an unsafe definition unlinked, even when a later definition has the same label", async () => {
    expect(await markdownToHtml("[a][r] [b][R]\n\n[r]: javascript:x\n[R]: https://ok.example\n")).toBe(
      "<p>[a][r] [b][R]</p>",
    )
  })

  it("writes no raw HTML from Markdown", async () => {
    expect(
      await markdownToHtml(
        'a <script>x()</script> <b onclick="s()">b</b>\n\n<iframe src="https://e.example"></iframe>',
      ),
    ).toBe("<p>a x() b</p>")
  })
})
