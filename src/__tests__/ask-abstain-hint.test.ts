import { expect, test } from 'bun:test'
import { abstainHint, ABSTAIN_HINT, kbAsk } from '../tools'
import type { AskData, KnowmanClient } from '../client'

test('returns an abstain hint from model tier or legacy answer text', () => {
  expect(abstainHint({ modelTier: 'abstain', answer: 'x' })).toEqual({ hint: ABSTAIN_HINT })
  expect(abstainHint({ modelTier: 'normal', answer: 'x' })).toEqual({})
  expect(abstainHint({ answer: "I don't have enough evidence" })).toEqual({ hint: ABSTAIN_HINT })
})

test('kbAsk adds the abstain hint only when the model abstains', async () => {
  const data = {
    answer: 'x',
    modelTier: 'abstain',
    citations: [],
    chunkContext: [],
  } as unknown as AskData

  const stub = {
    ask: async () => data,
    getItem: async () => {
      throw new Error('No item expected')
    },
  } as unknown as KnowmanClient

  const abstained = await kbAsk(stub, { question: 'q' })
  expect(abstained.hint).toBe(ABSTAIN_HINT)

  const normal = await kbAsk(
    {
      ...stub,
      ask: async () => ({ ...data, modelTier: 'normal' }),
    } as KnowmanClient,
    { question: 'q' },
  )
  expect(Object.hasOwn(normal, 'hint')).toBe(false)
  const { hint: _hint, ...abstainedWithoutHint } = abstained
  expect(normal).toEqual(abstainedWithoutHint)
})
