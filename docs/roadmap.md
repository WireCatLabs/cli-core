# Roadmap

For developers who build a CLI on `@wirecat/cli-core`. A planned item is not available yet, and the order can change.
There are no dates. What changed in each release is in the [changelog](../CHANGELOG.md).

## What works today

A messenger adapter gets the shared commands, the local store, search and an MCP server: see
[Write an adapter](dev/ADAPTERS.md) and the [API reference](REFERENCE.md). Meeting providers, document providers
and the knowledge store have their own guides: [meetings](dev/MEETING-PROVIDERS.md),
[documents](dev/DOCUMENTS.md), [knowledge](dev/KNOWLEDGE.md). The API changes often before 1.0, so pin an exact
version.

## In progress

- **Voice-note transcripts in every word form**, found with the same search as message text.
- **Media archives** with a check that each saved file is complete, kept up to date on a timer.
- **Merging duplicate tags** after the owner reviews the merge.
- **Every search chooses its accounts the same way**, with documents as a source of their own.
- **Help and examples for every shared command**, so each command explains itself to a person and an agent.

## Next

- **A fix for the security alerts** that `npm audit` shows today on a fresh install (from the MCP server library).
- **A smaller install**, with features such as charts, speech and search by meaning downloaded when first used.
- **A new source without changing this package**: a provider list a CLI extends itself, and document code that
  is not tied to Google Drive. The Slack, Google Meet, Notion and Calendar CLIs need it.
- **Calendar events** in the shared store, linked to the people, meetings and chats around them.
- **Faster search from the command line**, by finding where start-up time goes first.
- **Search that forgives typos by default**, saying how each forgiven hit matched.
- **Tags that a model or an agent suggests**, shown below the owner's own tags.

## Later

- More messenger features: albums, typing, location, video notes.
- Chat briefs and news digests for an agent.
- A better ranking model for note and document search, off by default.
- Faster embedding and speech recognition on machines with many cores.
- Found names and places linked to the people and organizations they mean.
- The serve relay on Windows, and MCP over HTTP through it.
