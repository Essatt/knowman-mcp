/**
 * Standalone copies of the KnowMan monorepo's shared contracts used by this package.
 *
 * COPIED FROM the KnowMan monorepo (packages/shared, origin/main): the helper functions and
 * constants below are copied verbatim, and the types are hand-written mirrors of the zod
 * schemas in packages/shared/src/contracts/entities/{media,retweet,social}.ts. The monorepo
 * stays the source of truth; keep these in sync when those files change.
 */

export const ITEM_TRUSTS = ['external', 'internal'] as const
export type ItemTrust = (typeof ITEM_TRUSTS)[number]

export type MediaType = 'image' | 'video' | 'gif' | 'link_preview' | 'poll'

export type LinkPreviewMeta = {
  title: string
  description?: string
  imageUrl?: string
  siteName?: string
}

export type PollOption = {
  label: string
  votes?: number
  percent?: number
}

export type PollMeta = {
  options: PollOption[]
  totalVotes?: number
  endsAt?: string
}

export type MediaInput = {
  url: string
  type: MediaType
  width?: number
  height?: number
  durationMs?: number
  posterUrl?: string
  altText?: string | null
  linkPreview?: LinkPreviewMeta
  poll?: PollMeta
}

export type Media = MediaInput & {
  id: string
  orderIndex: number
  createdAt: string
}

export type RetweetKind = 'retweet' | 'quote'

export type QuotedPost = {
  text?: string
  media?: MediaInput[]
}

export type RetweetMeta = {
  kind: RetweetKind
  originalAuthor: string
  originalHandle?: string
  originalTweetUrl?: string
  originalPostedAt?: string
  quotedPost?: QuotedPost
  retweetedBy?: {
    author: string
    handle?: string
  }
}

export type SocialPlatform =
  | 'x'
  | 'instagram'
  | 'facebook'
  | 'linkedin'
  | 'youtube'
  | 'tiktok'
  | 'threads'
  | 'bluesky'
  | 'reddit'
  | 'producthunt'
  | 'indiehackers'
  | 'eksisozluk'
  | 'generic_forum'
  | 'generic'

export type Engagement = {
  likes?: number
  reposts?: number
  replies?: number
  views?: number
}

export type SocialComment = {
  author: string
  text: string
  score?: number
}

export type SocialMeta = {
  platform: SocialPlatform
  author?: string
  authorSource?: 'capture' | 'derived'
  authorHandle?: string
  authorAvatarUrl?: string
  verified?: boolean
  engagement?: Engagement
  comments?: SocialComment[]
}

/**
 * Full citation token regex: [CITE:v1:<kind>:<uuid>]
 *
 * Captures:
 *  Group 1 — kind string (validated separately against CITATION_KINDS)
 *  Group 2 — UUID string (validated separately against UUIDV7_REGEX)
 *
 * Explicitly does NOT match v0 tokens like [CITE:<uuid>] or [chunk:<id>]
 * — those forms are rejected per ADR-0015 §4.
 */
export const CITATION_REGEX: RegExp =
  /\[CITE:v1:([a-z_-]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/g

/**
 * Strip all v1 citation tokens from text, preserving surrounding content.
 *
 * Only removes tokens that match CITATION_REGEX (valid v1 form).
 * v0 tokens and malformed tokens are left in place.
 */
export function stripCitations(text: string): string {
  return text.replace(new RegExp(CITATION_REGEX.source, 'g'), '')
}

/**
 * Tidy citation-related whitespace: collapse [ \t], remove space before punctuation,
 * trim per-line, and normalize marker runs.
 *
 * Preserves newlines and other whitespace (unlike a full trim).
 * Used by both renderPlainAnswer (inline) and MCP fallback path.
 *
 * @param text - Text to clean
 * @returns Cleaned text with tidy whitespace
 */
export function tidyCitationWhitespace(text: string): string {
  let result = text
    // Collapse horizontal whitespace only — newlines preserved
    .replace(/(?<=\S)[ \t]{2,}(?=\S)/g, ' ')
    // Drop horizontal space before punctuation
    .replace(/[ \t]+([,.;:!?)])/g, '$1')
    // Drop horizontal space before closing bracket
    .replace(/[ \t]+(\])/g, '$1')
    // Trim trailing horizontal whitespace per line
    .replace(/[ \t]+$/gm, '')

  // Collapse marker runs: unique numbers in first-appearance order, no separator
  result = result.replace(
    /\[\d+\](?:[ \t]*\[\d+\])+/g,
    (run) => {
      const seen = new Set<string>()
      const out: string[] = []
      for (const m of run.match(/\[\d+\]/g) ?? []) {
        const n = m.slice(1, -1)
        if (!seen.has(n)) {
          seen.add(n)
          out.push(`[${n}]`)
        }
      }
      return out.join('')
    },
  )

  // Remove leading space at line start only where a marker created it
  result = result.replace(/^ (?=\[\d+\])/gm, '')

  return result
}

/** Server-side bounds for an API key label (createApiKeySchema below is the enforcement). */
export const API_KEY_LABEL_MAX_LENGTH = 100
export const API_KEY_LABEL_PATTERN = /^[a-zA-Z0-9\s\-_]+$/

/** Label prefix of keys minted for `knowman login`, shared by the CLI and the /cli-auth page. */
export const CLI_API_KEY_LABEL_PREFIX = 'KnowMan CLI - '

const API_KEY_LABEL_FALLBACK = 'this computer'

/**
 * Make free text (a hostname, a --label flag, a query parameter) safe to use as the body of an
 * API key label. Every character outside letters, digits, space, `-` and `_` becomes `-`, runs
 * collapse, the ends are trimmed, and the result is capped so `prefix + result` stays within
 * API_KEY_LABEL_MAX_LENGTH. Anything that sanitises to nothing returns the fallback.
 *
 * ASCII only on purpose: the server pattern is ASCII, so `Büro` becomes `B-ro`, not `Büro`.
 */
export function sanitizeApiKeyLabel(
  raw: string,
  options: { prefix?: string; fallback?: string } = {},
): string {
  const prefix = options.prefix ?? ''
  const fallback = options.fallback ?? API_KEY_LABEL_FALLBACK
  const tidy = (value: string) =>
    value
      .replace(/[^A-Za-z0-9 _-]/g, '-')
      .replace(/[ -]*-[ -]*/g, '-')
      .replace(/ {2,}/g, ' ')
      .replace(/^[ -]+|[ -]+$/g, '')

  const cleaned = tidy(tidy(raw).slice(0, Math.max(0, API_KEY_LABEL_MAX_LENGTH - prefix.length)))
  return cleaned.length > 0 ? cleaned : fallback
}
