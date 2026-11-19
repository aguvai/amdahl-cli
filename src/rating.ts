// src/rating.ts
//
// A thumbs up or down on something Amdahl returned: `POST /feedback` (the `feedback.record`
// operation). The row is for the key's own owner; the CLI says it is the CLI (`client: 'cli'`) and
// which version. `amdahl feedback --rating` sends one, and the opt-in prompt after `optimize` and
// `search` sends one too. Never the message or the question: only the id of what was rated, the
// rating, and the comment a person typed.

import { apiClient, call, type Credential, type Ctx } from './context'
import { feedbackPromptOn } from './config'
import { canAsk } from './terminal'
import { VERSION } from './version'

export const RATINGS = ['up', 'down'] as const
export const RATING_SURFACES = ['optimize', 'search', 'research', 'grade', 'lead_list', 'other'] as const
export type Rating = (typeof RATINGS)[number]
export type RatingSurface = (typeof RATING_SURFACES)[number]

/** The longest comment the server takes, in characters. */
export const MAX_RATING_COMMENT_CHARS = 2_000

export interface RatingInput {
  /** The id of what was rated: an optimize run id, a search query id, or a research id. */
  id: string
  surface: RatingSurface
  rating: Rating
  comment?: string
  emailOk?: boolean
}

/** Send one rating. Resolves the server's answer; throws the CLI's usual error on a refusal. */
export async function postRating(ctx: Ctx, credential: Credential, input: RatingInput): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    answer_id: input.id,
    subject_id: input.id,
    surface: input.surface,
    rating: input.rating,
    client: 'cli',
    client_version: VERSION,
  }
  if (input.comment?.trim()) body.comment = input.comment
  if (input.emailOk) body.email_ok = true
  return call(() => apiClient(ctx, credential).request<Record<string, unknown>>('/api/platform/v1/feedback', { method: 'POST', body }))
}

/** What the one-line prompt reads: y, yes, up (a thumbs up) or n, no, down (a thumbs down). */
export function ratingFromAnswer(answer: string): Rating | null {
  const a = answer.trim().toLowerCase()
  if (a === 'y' || a === 'yes' || a === 'up') return 'up'
  if (a === 'n' || a === 'no' || a === 'down') return 'down'
  return null
}

/**
 * After a result at a terminal: one line, "Was this useful?". Off unless `feedbackPrompt` (or
 * AMDAHL_FEEDBACK_PROMPT) is on, and never for --json, a pipe, CI or AMDAHL_NO_PROMPT. Enter skips.
 * A no asks one more question for what went wrong. A refusal or a failure to save prints one quiet
 * line and never changes the command's exit code: the result was already printed.
 */
export async function askRating(ctx: Ctx, credential: Credential, target: { id: string; surface: RatingSurface }): Promise<void> {
  if (!feedbackPromptOn(ctx.io, ctx.config) || !canAsk(ctx) || !target.id) return
  const rating = ratingFromAnswer(await ctx.io.prompt('Was this useful? [y/n, Enter to skip] '))
  if (!rating) return
  const comment = rating === 'down' ? (await ctx.io.prompt('What went wrong? (Enter to skip) ')).trim() : ''
  try {
    await postRating(ctx, credential, { id: target.id, surface: target.surface, rating, ...(comment ? { comment: comment.slice(0, MAX_RATING_COMMENT_CHARS) } : {}) })
    ctx.io.stderr('Thanks, saved.\n')
  } catch {
    ctx.io.stderr('Could not save your rating.\n')
  }
}
