### Changed — may break callers

- **Dates in list queries, and the calendar MCP tools, read the computer's zone.** `today` and a bare date in
  `tasks list`, `meetings list`, `chats list`, `tags list` and the other list queries started in UTC; the calendar
  tools' `timezone` defaulted to UTC, so `event_create` at `10:00` made an 11:00 Madrid event. Both now read the
  local zone, as search and the CLI do.
- **`messages_photo` takes `attachment`, from 1,** as `attachments_show` and `messages download --attachment` do. It
  took `index` from 0; a number past the last file now says how many files the message has.
- **`tasks --due` with a date alone is the end of that day,** not its midnight, so a task due on the 20th is not
  overdue all day. `schedule --at-time` refuses a date alone, as `messages send --at-time` does.
- **An event two accounts hold is read only from the account named.** `event_show` and `event_people` without
  `account_id` refuse it with the accounts to choose from, as the calendar write tools do, and the answer names the
  one account read.

### Fixed

- **A stale copy no longer overwrites a newer edit.** A history page fetched before `serve` saw an edit turned the
  text back, filed the edit as the old version and dropped its vectors.
- **`serve` stops auto-replies as soon as `replies.send` is denied,** without a restart.
- **A stdio MCP server closes after a client cancels a call and closes stdin,** and stops on SIGINT or SIGTERM while
  answers are pending. A call cancelled while it waited in the queue never runs, so a cancelled send does not go out.
  The bot server answers a one-shot pipe's calls before it closes, as the other servers do.
- **`mcp serve --profiles all` refuses with the shared error object** (`validation_error`, `authentication_error`,
  `outcome_unknown`), not plain text.
- **An MCP answer counts once against the 4 MB limit,** as the CLI counts what it prints; an answer of about 2 MB
  failed with `output.too-large` over MCP alone.
- **An HTTP MCP client can no longer pass on a caller** meant only for the every-profile server's own connections.
- **`t.me` links name Telegram chats only,** never a chat of another messenger that shares the username.
- **Mail:** a plain address beside a bracketed one in To or Cc is kept (`alice@x.com, "Bob" <bob@y.com>`); HTML
  mail decodes numeric and typographic entities (`&rsquo;`, `&mdash;`); an email kept as an envelope stays one while a
  run cannot read its headers; a resumed sync follows every rule field, not only from, domain and list id;
  `--retry-attachments` stops on the signal; listed mail is ordered by instant.
- **The send guard** refuses a send time it cannot read, and counts a journal line with an unreadable time in the
  hour it was written.
- **A malformed `%` escape in a reference** (`msg:telegram/1/2/%E0`) is a `validation_error`, not an unknown failure.
- **`--chat` finds a chat the owner left when several accounts are read,** as with one account.
- **A configured `limit` above 100 no longer breaks `stats messages top`;** it is capped at the ranking's 100.
- **`search meetings`:** `date>=30d` works with `--until-time`, `--since-time` takes `7d`, and `budget && project:X`
  or `budget +project:X` leave no dangling operator.
- **The MCP `review` prompt** writes `since` as the query reads it: `1d ago` as `date>1d`, an ISO time as its UTC
  instant.
- **The calendar MCP tools** refuse a `limit` over 1000 and an empty attendee.
- **The tag list** pages without repeating or skipping rows that tie.
