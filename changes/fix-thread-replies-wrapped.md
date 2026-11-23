### Fixed

- **Thread replies answered in batches are saved again.** 0.732.0 checked for batches before awaiting the answer,
  but the flood wrapper makes every adapter method async, so a messenger that answered in batches had none of its
  replies saved. The answer is now awaited first, and `threadReplies` may return a promise of batches.
