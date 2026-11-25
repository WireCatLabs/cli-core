### Fixed

- **A question in `search all` no longer finds deals, leads, tracker items or business records by its function
  words.** A question is searched by any of its words, so «что с логотипом?» also found a deal titled «Что мы
  обещали», and «кто ругался что мы…» put a note ranked by «что» first. The CRM, tracker and business lanes now
  leave out words like «что», «кто», «мы», "the", the same list the message search uses; a question made only of
  them is searched as typed.
