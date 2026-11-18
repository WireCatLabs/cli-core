### Added

- **`htmlToMarkdown` and `markdownToHtml` in `@wirecat/cli-core/documents`**, for the content category: a blog keeps
  HTML (WordPress, Ghost), and a CLI shows and takes Markdown. WordPress block comments and Ghost card comments go,
  and so do scripts, styles, frames, event attributes, raw HTML from Markdown, and links and images whose scheme is
  not http(s), mailto or tel: a post body is untrusted. Tested on one post as WordPress 6.9 stores and renders it and
  as Ghost 6.78 renders it; Markdown that went through HTML once comes back the same. The converters are unified's
  `hast-util-from-html`, `hast-util-to-mdast`, `mdast-util-to-hast` and `hast-util-to-html`, loaded on first use.
