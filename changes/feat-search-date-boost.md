### Added

- **`search all` moves up what is dated inside the period a question names.** "What did we decide in March?", "June
  22", "last week", «в прошлом месяце»: each source is read to 100 hits, and a hit dated inside the period gains 0.5 over
  its place (1 - rank/100) before the page is cut. On LifeBench, over words and meaning merged, recall@10 went from 0.44
  to 0.47 and hit@10 from 0.84 to 0.88; the v3 questions, which name no period, did not move. `SearchAllRequest.now`
  sets the clock.
