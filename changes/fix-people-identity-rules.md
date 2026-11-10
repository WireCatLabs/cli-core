### Changed — may break callers

- **Nothing joins anyone to the owner without the owner**. A pair with the owner's person on either side is
  only proposed, with the reason "one side is you", at import and in `people.scanMatches`, where it used to merge. An
  account's own identity joins the owner only under the owner's name, in either script; under another name, such as a
  partner's mailbox or a spouse's messenger the owner reads, it opens a proposal with the new signal `account`
  (`IDENTITY_LINK_SIGNALS`). A CRM no longer names the owner's person.
- **A role address such as `info@` and a company's line or mailbox join and propose no one.** A role address used to
  be proposed. A company's line is one an organization holds, or one two people of one source list share, such as two
  CRM contacts. A bot's number or address is skipped too.
- **A CRM contact ties a person to the owner only through a deal or lead whose owner is the owner**, that is
  a CRM user linked to the owner's person. Every CRM contact used to count, so `kind:person` held a whole CRM. A CRM's users
  still count.

### Fixed

- **Telegram and WhatsApp people get their chat ties**. Those messengers keep no member list, so a
  one-to-one chat or a small group tied nobody and the owner's top contacts were `stranger`. Whoever wrote in a
  one-to-one chat or a group of at most 10 now has the tie. Store version 63 adds the triggers that keep stored kinds
  in step with message senders and deal links; the next `people list` works everyone out
  again once.
- **A name is found in either script**. `people.list` with a `name` query looks for the text in Cyrillic and
  Latin, and `people.similar` and the name match of `scanMatches` compare names with script, transliteration and
  accents set aside, so `Светлана Кузнецова` is `Svetlana Kuznetsova`. A name alone still proposes nobody, and a surname
  change is never guessed.
- **A same-name proposal needs a strong trace between sources.** A phone or an address counts only when no third person
  holds it; a shared chat or a company's mail domain counts only between people of one source.

### Added

- **`people.list` rows say which messenger a username belongs to** (`usernameSource`), and each identity of
  `people.personOf` and `people.byUid` carries the `phone` and `email` its source gave it.
