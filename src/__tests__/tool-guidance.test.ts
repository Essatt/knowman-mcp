import { expect, test } from 'bun:test'
import { TOOL_DEFINITIONS } from '../tools'

test('tool descriptions explain how to use KnowMan knowledge tools', () => {
  const descriptions = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool.description]))

  expect(descriptions.get('kb_search')).toStartWith(
    "Deprecated: use kb_research. Search saved items in the KnowMan Inbox, Knowledge Base, or Archive without returning content bodies; a location filter costs one extra lookup per hit. Every result carries `trust`: 'internal' is the user's OWN knowledge (their pages, documents and designated links) and outranks 'external' saved articles on anything about the user themselves.",
  )
  expect(descriptions.get('kb_search')).toContain(' Returns snippets only; kb_get_item reads the full text.')

  expect(descriptions.get('kb_ask')).toStartWith(
    'Deprecated: use kb_research. Ask a question over the whole KnowMan library by default (Inbox and Knowledge Base; pass scope to narrow to kb or inbox), or a single item when itemId is given; returns an answer plus citations whose itemId resolves via kb_get_item.',
  )
  expect(descriptions.get('kb_ask')).toContain(
    ' Answers specific questions with citations; may abstain on broad questions: then use kb_memories, kb_search and kb_get_item.',
  )

  expect(descriptions.get('kb_memories')).toStartWith(
    "Deprecated: use kb_research. List saved memories (claims, decisions, playbooks) from the Knowledge Base; use kind 'playbook' to find step-by-step processes the user has taught KnowMan. Read-only.",
  )
  expect(descriptions.get('kb_memories')).toContain(
    " Best first stop for process, strategy and how-to questions (kind 'playbook').",
  )

  expect(descriptions.get('kb_research')).toStartWith(
    "Retrieve ranked evidence across the user's whole library",
  )
})
