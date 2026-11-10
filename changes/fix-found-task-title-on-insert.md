### Fixed

- **A task found in a message keeps the message's first line as its title after the message is deleted.** The line is
  now stored as the title when the task is found, as store version 65 did for the tasks found before. A task found
  before its message is saved still shows the line once the message arrives, and a title the finder or a person sets
  replaces it as before.
