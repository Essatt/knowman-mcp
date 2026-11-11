// Structured tool-result shapes. The MCP Apps cards bundle was removed in 0.3.1;
// only the shape function remains, so hosts that read structuredContent still get it.
export function structuredContentFor(
  toolName: string,
  result: unknown,
): Record<string, unknown> | undefined {
  switch (toolName) {
    case 'kb_research':
      return result as Record<string, unknown>
    case 'kb_search':
      return { view: 'search', results: result }
    case 'kb_recent':
      return { view: 'recent', results: result }
    case 'kb_ask': {
      const value = result as { answer?: unknown; citations?: unknown; otherCitations?: unknown }
      return {
        view: 'ask',
        answer: value.answer,
        citations: value.citations,
        otherCitations: Array.isArray(value.otherCitations) ? value.otherCitations : [],
      }
    }
    case 'kb_save':
      return { view: 'save', item: result }
    case 'kb_memories':
      return { view: 'memories', memories: result }
    default:
      return undefined
  }
}
