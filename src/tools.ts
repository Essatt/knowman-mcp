import { API_KEY_SCOPES, type ApiKeyScope, type Media, type RetweetMeta, type SocialMeta } from './shared'
import { stripCitations, tidyCitationWhitespace } from './shared'
import { z } from 'zod'
import {
  type CreateItemData,
  type Item,
  type ItemData,
  type ItemLocation,
  type ItemTrust,
  type KnowmanClient,
  type MemoryDetailData,
  type MemorySummary,
  type ResearchData,
  truncateContent,
} from './client'

const locationSchema = z.enum(['inbox', 'kb', 'archive'])
const writableLocationSchema = z.enum(['inbox', 'kb'])
const memoryKindSchema = z.enum(['claim', 'decision', 'playbook'])

/**
 * D1 §2.9 provenance scope.
 *
 * DEFAULT 'all', unlike the HTTP API's 'external'. An agent acting for the
 * user should see the user's own pages and documents alongside their saved
 * articles — that is the whole point of "My knowledge" — and every result
 * carries `trust` so the agent can weigh them differently.
 */
const scopeSchema = z.enum(['internal', 'external', 'all'])

/** Read a trust value off a possibly-older API response. */
function trustOf(value: ItemTrust | null | undefined): ItemTrust {
  return value === 'internal' ? 'internal' : 'external'
}

export const researchInput = z.object({
  question: z.string().min(1).max(2000),
  max_passages: z.number().int().min(1).max(20).optional(),
})

export const searchInput = z.object({
  query: z.string().min(1).describe('Text to search for in KnowMan.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe('Maximum number of search results to return.'),
  location: locationSchema
    .optional()
    .describe('Optional Inbox, Knowledge Base, or Archive location filter.'),
  scope: scopeSchema
    .default('all')
    .describe(
      "Which knowledge to search: 'internal' (the user's own pages, documents and designated links), 'external' (articles they saved), or 'all'. Defaults to all.",
    ),
})

export const askInput = z.object({
  question: z.string().min(1).describe('Question to ask over the KnowMan Knowledge Base.'),
  itemId: z.string().min(1).optional().describe('Optional item id restricting the question.'),
  projectId: z.string().min(1).optional().describe('Optional project id restricting the question.'),
})

export const getItemInput = z.object({
  id: z.string().min(1).describe('KnowMan item id to retrieve.'),
})

export const saveInput = z.object({
  url: z.string().url().describe('URL to save into KnowMan.'),
  location: writableLocationSchema
    .default('inbox')
    .describe('Save into the Inbox or directly into the Knowledge Base.'),
  note: z.string().optional().describe('Optional note to attach to the saved item.'),
  trust: z
    .enum(['internal', 'external'])
    .optional()
    .describe(
      "Mark the saved link as the user's own knowledge ('internal' — their company docs, their own posts) rather than an outside article ('external', the default).",
    ),
})

export const recentInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of recent items to return.'),
  location: writableLocationSchema
    .optional()
    .describe('Optional Inbox or Knowledge Base location filter.'),
  scope: scopeSchema
    .default('all')
    .describe(
      "Which knowledge to list: 'internal', 'external', or 'all' (default).",
    ),
  sourceType: z
    .union([
      z
        .string()
        .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean))
        .pipe(z.array(z.enum(['manual', 'extension', 'rss', 'newsletter', 'inbox', 'import'])).optional()),
      z.array(z.enum(['manual', 'extension', 'rss', 'newsletter', 'inbox', 'import'])),
    ])
    .optional()
    .describe(
      "Optional source type filter: manual, extension, rss, newsletter, inbox, or import. Array or comma-separated string. Use sourceType:['manual','extension'] to return only the user's own saves (manual and extension saves). Defaults to all types.",
    ),
})

export const memoriesInput = z.object({
  project: z
    .string()
    .optional()
    .describe('Optional project id as a UUID; project name lookup is unavailable.'),
  kind: memoryKindSchema.optional().describe('Optional memory kind: claim, decision, or playbook.'),
  query: z
    .string()
    .optional()
    .describe('Optional case-insensitive title and body substring filter.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe('Maximum number of memories to return.'),
})

export interface Row {
  id: string
  title: string | null
  url: string
  snippet: string | null
  savedAt: string
  location: ItemLocation | null
  /**
   * D1 §2.9 — `internal` is the user's OWN knowledge and should be weighed
   * above `external` when the two disagree about the user's own situation.
   */
  trust: ItemTrust
}

export interface CitationResult {
  itemId: string
  title: string | null
  url: string | null
  quote: string
  number?: number
}

export interface OtherCitationResult {
  kind: 'memory' | 'highlight' | 'note' | 'evidence' | 'entity'
  id: string
  title?: string
  preview?: string
  trust?: string
  origin?: string
  sourceItemId?: string
}

export interface AskResult {
  answer: string
  citations: CitationResult[]
  conversationId: null
  otherCitations: OtherCitationResult[]
  hint?: string
}

export const ABSTAIN_HINT =
  'Not enough direct evidence for kb_ask. Try kb_memories (kind playbook), kb_search with other phrasings, then kb_get_item on the best hits.'

export function abstainHint(data: { modelTier?: string; answer: string }): { hint?: string } {
  const abstained =
    data.modelTier !== undefined
      ? data.modelTier === 'abstain'
      : data.answer.startsWith("I don't have enough")
  return abstained ? { hint: ABSTAIN_HINT } : {}
}

export interface ItemResult {
  id: string
  title: string | null
  url: string
  author: string | null
  savedAt: string
  location: ItemLocation
  tags: string[]
  content: string
  truncated: boolean
  trust?: ItemTrust
  media?: Media[]
  retweet?: RetweetMeta | null
  social?: SocialMeta | null
}

export interface SaveResult {
  id: string
  title: string | null
  location: ItemLocation
  status: string
  trust: ItemTrust
}

export interface MemoryResult {
  id: string
  kind: string
  title: string | null
  body: string
  project: string | null
  steps?: unknown
  triggerCond?: unknown
  outcome?: unknown
  updatedAt: string
}

const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function unwrapItem(data: ItemData | CreateItemData): Item {
  if ('item' in data && data.item !== undefined) {
    return data.item
  }

  return data as Item
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapMemoryDetail(data: MemoryDetailData): Record<string, unknown> {
  if (isRecord(data) && isRecord(data.memory)) {
    return data.memory
  }

  return data as unknown as Record<string, unknown>
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined)
}

function addPlaybookSidecar(row: MemoryResult, detailData: MemoryDetailData): MemoryResult {
  const detail = unwrapMemoryDetail(detailData)
  const playbook = isRecord(detail.playbook) ? detail.playbook : undefined
  const payload = isRecord(detail.payload) ? detail.payload : undefined

  const steps = firstDefined(detail.steps, playbook?.steps, payload?.steps)
  const triggerCond = firstDefined(detail.triggerCond, playbook?.triggerCond, payload?.triggerCond)
  const outcome = firstDefined(detail.outcome, playbook?.outcome, payload?.outcome)

  return {
    ...row,
    ...(steps !== undefined ? { steps } : {}),
    ...(triggerCond !== undefined ? { triggerCond } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
  }
}

function mapMemory(memory: MemorySummary, project?: string): MemoryResult {
  return {
    id: memory.id,
    kind: memory.kind,
    title: memory.title,
    body: memory.body,
    project: project ?? memory.projectId ?? null,
    updatedAt: memory.updatedAt ?? memory.createdAt,
  }
}

export async function kbSearch(
  client: KnowmanClient,
  input: z.input<typeof searchInput>,
): Promise<Row[]> {
  const values = searchInput.parse(input)
  const data = await client.search({
    query: values.query,
    limit: values.limit,
    scope: values.scope,
  })

  if (values.location === undefined) {
    return data.hits.map((hit) => ({
      id: hit.id,
      title: hit.title,
      url: hit.url,
      snippet: hit.description ?? null,
      savedAt: hit.createdAt,
      location: hit.location ?? null,
      trust: trustOf(hit.trust),
    }))
  }

  const hydrated = await Promise.all(
    data.hits.map(async (hit) => {
      try {
        return {
          hit,
          item: unwrapItem(await client.getItem(hit.id, { includeContent: false })),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        client.debug(`kb_search could not hydrate item ${hit.id}: ${message}`)
        return null
      }
    }),
  )

  return hydrated.flatMap((row) => {
    if (row === null || row.item.location !== values.location) {
      return []
    }

    return [
      {
        id: row.hit.id,
        title: row.hit.title,
        url: row.hit.url,
        snippet: row.hit.description ?? null,
        savedAt: row.hit.createdAt,
        location: row.item.location,
        trust: trustOf(row.hit.trust),
      },
    ]
  })
}

export async function kbAsk(
  client: KnowmanClient,
  input: z.input<typeof askInput>,
): Promise<AskResult> {
  const values = askInput.parse(input)
  const data = await client.ask({
    query: values.question,
    ...(values.itemId !== undefined ? { itemId: values.itemId } : {}),
    ...(values.projectId !== undefined ? { projectId: values.projectId } : {}),
  })

  const chunksById = new Map<string, (typeof data.chunkContext)[number]>()
  for (const chunk of data.chunkContext) {
    const id = chunk.id ?? chunk.chunkId
    if (id !== undefined) {
      chunksById.set(id, chunk)
    }
  }

  const otherCitations: OtherCitationResult[] = []
  const otherCitationIds = new Set<string>()
  const knownOtherCitationKinds = new Set([
    'memory',
    'highlight',
    'note',
    'evidence',
    'entity',
  ])
  for (const citation of data.citations) {
    if (citation.kind === 'chunk') continue
    if (!knownOtherCitationKinds.has(citation.kind)) {
      client.debug(`kb_ask ignored unknown citation kind ${citation.kind}`)
      continue
    }
    const id = citation.id ?? citation.targetId
    if (id === undefined || otherCitationIds.has(id)) continue
    otherCitationIds.add(id)
    const fields = citation as typeof citation & {
      title?: string
      preview?: string
      trust?: string
      origin?: string
      sourceItemId?: string
    }
    otherCitations.push({
      kind: citation.kind as OtherCitationResult['kind'],
      id,
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.preview !== undefined
        ? { preview: Array.from(fields.preview).slice(0, 160).join('') }
        : {}),
      ...(fields.trust !== undefined ? { trust: fields.trust } : {}),
      ...(fields.origin !== undefined ? { origin: fields.origin } : {}),
      ...(fields.sourceItemId !== undefined ? { sourceItemId: fields.sourceItemId } : {}),
    })
  }

  // Resolve chunk→item grouping, one citation per itemId
  const citationsByItem = new Map<string, { chunk: (typeof data.chunkContext)[number]; sourceNumber?: number }>()
  for (const citation of data.citations) {
    if (citation.kind !== 'chunk') continue
    const chunkId = citation.id ?? citation.targetId
    if (chunkId === undefined) continue
    const chunk = chunksById.get(chunkId)
    if (chunk === undefined) continue
    if (citationsByItem.has(chunk.itemId)) continue
    const sourceNumber = data.sources?.find(
      (s) => s.kind === 'item' && s.id === chunk.itemId
    )?.number
    citationsByItem.set(chunk.itemId, { chunk, sourceNumber })
  }

  // Order citations: prefer data.sources order, else first-appearance order
  const itemKindSources = data.sources?.filter((s) => s.kind === 'item') ?? []
  const itemOrder: string[] =
    itemKindSources.length > 0
      ? itemKindSources.map((s) => s.id)
      : Array.from(citationsByItem.keys())

  const citations: CitationResult[] = itemOrder
    .filter((id) => citationsByItem.has(id))
    .map((itemId) => {
      const { chunk, sourceNumber } = citationsByItem.get(itemId)!
      const quote =
        chunk.text.length > 500 ? chunk.text.substring(0, 500) + '…' : chunk.text
      return {
        itemId: chunk.itemId,
        title: chunk.itemTitle ?? null,
        url: null,
        quote,
        number: sourceNumber,
      }
    })

  const itemIds = [...new Set(citations.map((citation) => citation.itemId))]
  const resolvedItems = new Map<string, Item>()

  await Promise.all(
    itemIds.map(async (itemId) => {
      try {
        const item = unwrapItem(await client.getItem(itemId, { includeContent: false }))
        resolvedItems.set(itemId, item)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        client.debug(`kb_ask could not resolve item ${itemId}: ${message}`)
      }
    }),
  )

  // Use answerText if available (server-rendered with numeric citations),
  // otherwise strip tokens from raw answer and clean whitespace
  const answerText = data.answerText
    ? data.answerText
    : tidyCitationWhitespace(stripCitations(data.answer))

  return {
    answer: answerText,
    citations: citations.map((citation) => {
      const item = resolvedItems.get(citation.itemId)
      return {
        ...citation,
        title: citation.title ?? item?.title ?? null,
        url: item?.url ?? null,
      }
    }),
    conversationId: null,
    otherCitations,
    ...abstainHint(data),
  }
}

export async function kbGetItem(
  client: KnowmanClient,
  input: z.input<typeof getItemInput>,
): Promise<ItemResult> {
  const values = getItemInput.parse(input)
  const item = unwrapItem(await client.getItem(values.id, { includeContent: true }))
  const content = truncateContent(item.content ?? '')

  const result: ItemResult = {
    id: item.id,
    title: item.title,
    url: item.url,
    author: item.author,
    savedAt: item.createdAt,
    location: item.location,
    tags: (item.tags ?? []).map((tag) => tag.name),
    content: content.content,
    truncated: content.truncated,
  }

  if (item.trust != null) result.trust = trustOf(item.trust)
  if (item.media != null) result.media = item.media
  if (item.retweet != null) result.retweet = item.retweet
  if (item.social != null) result.social = item.social

  return result
}

export async function kbSave(
  client: KnowmanClient,
  input: z.input<typeof saveInput>,
): Promise<SaveResult> {
  const values = saveInput.parse(input)
  const created = unwrapItem(
    await client.createItem({
      url: values.url,
      ...(values.trust !== undefined ? { trust: values.trust } : {}),
    }),
  )
  let location = created.location

  if (values.location === 'kb') {
    try {
      await client.setKbMember(created.id, true)
      location = 'kb'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      client.debug(`kb_save could not add item ${created.id} to Knowledge Base: ${message}`)
    }
  }

  if (values.note !== undefined) {
    try {
      await client.updateItem(created.id, { notes: values.note })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      client.debug(`kb_save could not attach note to item ${created.id}: ${message}`)
    }
  }

  return {
    id: created.id,
    title: created.title,
    location,
    status: created.status,
    // Echo what was ASKED for, not what the response happened to project: the
    // create response's item shape carries no `trust` field, and an agent
    // saving an ordinary link must not start failing because of it.
    trust: values.trust ?? 'external',
  }
}

export async function kbRecent(
  client: KnowmanClient,
  input: z.input<typeof recentInput>,
): Promise<Row[]> {
  const values = recentInput.parse(input)
  const data = await client.listItems({
    limit: values.limit,
    ...(values.location !== undefined ? { location: values.location } : {}),
    ...(values.sourceType !== undefined ? { sourceType: values.sourceType } : {}),
    scope: values.scope,
  })

  return data.items.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    snippet: item.description ?? null,
    savedAt: item.createdAt,
    location: item.location,
    trust: trustOf(item.trust),
  }))
}

export async function kbMemories(
  client: KnowmanClient,
  input: z.input<typeof memoriesInput>,
): Promise<MemoryResult[]> {
  const values = memoriesInput.parse(input)

  if (values.project !== undefined && !projectIdPattern.test(values.project)) {
    throw new Error(
      'project must be a project id (UUID); name lookup is not available in this API version',
    )
  }

  const data = await client.listMemories({
    ...(values.kind !== undefined ? { kind: values.kind } : {}),
    limit: values.query !== undefined ? 100 : values.limit,
    ...(values.project !== undefined ? { projectId: values.project } : {}),
    lifecycleStates: ['active'],
  })

  let rows = data.memories.map((memory) => mapMemory(memory, values.project))

  if (values.query !== undefined) {
    const queryTokens = values.query
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0)

    if (queryTokens.length > 0) {
      rows = rows.filter((row) => {
        const title = (row.title ?? '').toLocaleLowerCase()
        const body = row.body.toLocaleLowerCase()
        return queryTokens.every((token) => title.includes(token) || body.includes(token))
      })
    }

    rows = rows.slice(0, values.limit)
  }

  if (values.kind !== 'playbook') {
    return rows
  }

  return Promise.all(
    rows.map(async (row) => {
      try {
        return addPlaybookSidecar(row, await client.getMemory(row.id))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        client.debug(`kb_memories could not load playbook ${row.id}: ${message}`)
        return row
      }
    }),
  )
}

export const TOOL_DEFINITIONS: Array<{
  name: string
  title: string
  description: string
  inputSchema: z.AnyZodObject
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
  scope?: ApiKeyScope
  run: (client: KnowmanClient, rawInput: unknown) => Promise<unknown>
}> = [
  {
    name: 'kb_research',
    title: 'Research the library',
    description:
      "Retrieve ranked evidence across the user's whole library and distilled memories. Default tool for factual, strategic and how-to questions. Returns source passages, not an answer.",
    inputSchema: researchInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (client, rawInput) => client.research(researchInput.parse(rawInput)),
  },
  {
    name: 'kb_search',
    title: 'Search your knowledge base',
    description:
      "Deprecated: use kb_research. Search saved items in the KnowMan Inbox, Knowledge Base, or Archive without returning content bodies; a location filter costs one extra lookup per hit. Every result carries `trust`: 'internal' is the user's OWN knowledge (their pages, documents and designated links) and outranks 'external' saved articles on anything about the user themselves. Returns snippets only; kb_get_item reads the full text.",
    inputSchema: searchInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (client, rawInput) => kbSearch(client, searchInput.parse(rawInput)),
  },
  {
    name: 'kb_ask',
    title: 'Ask your knowledge base',
    description:
      'Deprecated: use kb_research. Ask a question over the whole Knowledge Base (or a single item when itemId is given); returns an answer plus citations whose itemId resolves via kb_get_item. Answers specific questions with citations; may abstain on broad questions: then use kb_memories, kb_search and kb_get_item.',
    inputSchema: askInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (client, rawInput) => kbAsk(client, askInput.parse(rawInput)),
  },
  {
    name: 'kb_get_item',
    title: 'Get a saved item',
    description:
      'Read the full text of one saved item by id when research evidence needs more context.',
    inputSchema: getItemInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (client, rawInput) => kbGetItem(client, getItemInput.parse(rawInput)),
  },
  {
    name: 'kb_save',
    title: 'Save a link',
    description:
      "Save a URL to the KnowMan Inbox or directly to the Knowledge Base. Pass trust:'internal' when the link is the user's own knowledge (their company docs, their own writing) rather than an outside article.",
    inputSchema: saveInput,
    scope: API_KEY_SCOPES.ITEMS_WRITE,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: (client, rawInput) => kbSave(client, saveInput.parse(rawInput)),
  },
  {
    name: 'kb_recent',
    title: 'Recent saved items',
    description:
      'List recently saved items. Use only when the user asks about recent saves.',
    inputSchema: recentInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (client, rawInput) => kbRecent(client, recentInput.parse(rawInput)),
  },
  {
    name: 'kb_memories',
    title: 'Your memories',
    description:
      "Deprecated: use kb_research. List saved memories (claims, decisions, playbooks) from the Knowledge Base; use kind 'playbook' to find step-by-step processes the user has taught KnowMan. Read-only. Best first stop for process, strategy and how-to questions (kind 'playbook').",
    inputSchema: memoriesInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (client, rawInput) => kbMemories(client, memoriesInput.parse(rawInput)),
  },
]
