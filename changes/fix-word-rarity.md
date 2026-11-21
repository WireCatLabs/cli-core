### Fixed

- **A conversation search by words ranks a chat's messages by how rare the words they hold are.** A common word has
  many forms, and each form was weighed on its own, so short messages holding one rare form of it came before the
  message holding the rarer words of the question. Each chat's matches are now ranked by how few messages hold each
  word they share with the question; which chats fill the list is decided as before, so a small chat's answer is not
  pushed out by large groups.
