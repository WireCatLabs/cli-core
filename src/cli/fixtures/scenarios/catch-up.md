---
title: Catch up after a day away
goal: Know who waits on you and what you promised, without reading every chat.
steps:
  - run: chat review 'date>1d' --unanswered 4h
    why: questions to you that nobody answered, across every chat
  - run: chat messages list "Book club" --limit 20
    why: the chat behind a question, read in full
  - run: chat tasks list
    why: what the review turned into tasks
look:
  - who asked first and how long ago
  - tasks marked as yours
---

The site's Examples page renders this body; the CLI prints only the front matter.
