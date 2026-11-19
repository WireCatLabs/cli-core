### Fixed

- **The morning digest reaches Telegram whole.** A digest longer than one Telegram message (4096 characters) is sent
  as several messages in order, split between sections, or between items when one section fills a message by itself;
  no item is cut or left out. Each part is rendered by the template, so its markup stays valid. A later part's title
  and a section that goes on carry "(продолжение)" / "(continued)"; the summary opens the first part, and the
  sources and the footer close the last. Delivery sends the parts about a second apart (three in a group), as
  Telegram's bot FAQ asks, and a part that fails stops the rest and is named in `last.json`. Before, items were dropped
  until the text fit and counted in "ещё N".
- **A section shows up to 25 items, and the sources up to 10.** memo's digest now has 15 to 30 items, and its brief
  allows 25 in one section; the old caps (7 today, 5 in most sections, 3 sources) cut it. The caps stay as a safety
  net. The CRM digest keeps its own 7 per section. The `wirecat.report/1` document and mail are unchanged.
