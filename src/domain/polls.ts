import type { Id, Poll, PollVote } from "./models.js"

/**
 * A poll with its counts taken from each voter's newest vote, for a messenger that sends votes one by one and counts
 * nothing (WhatsApp). `self`'s vote, when there is one, also sets `chosen`. A vote taken back counts toward nothing.
 */
export const countedPoll = (poll: Poll, votes: readonly PollVote[], self: Id | null): Poll => {
  const cast = votes.filter((vote) => vote.answers.length > 0)
  const mine = self === null ? undefined : votes.find((vote) => vote.person.id === self)
  return {
    ...poll,
    answers: poll.answers.map((answer) => ({
      ...answer,
      voters: cast.filter((vote) => vote.answers.includes(answer.id)).length,
      chosen: mine ? mine.answers.includes(answer.id) : answer.chosen,
    })),
    voters: cast.length,
  }
}
