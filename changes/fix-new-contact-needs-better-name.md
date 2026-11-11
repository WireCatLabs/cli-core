### Fixed

- **A new contact from mail needs a name the mail's text adds.** A `new_contact` finding whose name only repeats what the store has from the sender line is refused (`new-contact.sender-line`), and so is one whose name is not in the text of the mail it cites (`new-contact.not-in-text`). A name copied from a header is metadata, not something for the owner to review. Batches already waiting stay as they are until decided.
