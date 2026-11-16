### Fixed

- **`search conversations` across several chats gives each chat a share**, so a large group no longer fills the
  results with near matches and hides a small chat's clear answer. The meaning half reads the 500 nearest
  conversations and ranks each chat's best 20 by how far they lead that chat's 20th best; the word half reads at most
  20 messages per chat. On a test store of 10 chats (4 large groups) with 40 questions, a key message reached the top
  20 for 19 questions instead of 10, and the top 5 for 11 instead of 8, at about 0.7 s more per query. One chat
  (`--chat`) is searched as before. `QueryExecution` takes `perChat`, the most hits a page takes from one chat.
