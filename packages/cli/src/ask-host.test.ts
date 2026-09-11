import { describe, expect, test } from 'bun:test'
import { formatAskUserPrompt, type AskUserInput } from '@ravenclaw/core'
import { createAskUserBridge, formatAskUserDialog, parseAskUserAnswer } from './ask-host'

const single: AskUserInput = {
  questions: [
    {
      header: 'Style',
      question: 'Which formatter?',
      options: [
        { label: 'prettier', description: 'default' },
        { label: 'biome' },
      ],
    },
  ],
}

const multi: AskUserInput = {
  questions: [
    {
      question: 'Ship it?',
      multiSelect: true,
      options: [{ label: 'yes' }, { label: 'no' }, { label: 'later' }],
    },
  ],
}

const two: AskUserInput = {
  questions: [
    {
      question: 'Which formatter?',
      options: [{ label: 'prettier' }, { label: 'biome' }],
    },
    {
      question: 'Ship it?',
      options: [{ label: 'yes' }, { label: 'no' }],
    },
  ],
}

describe('parseAskUserAnswer', () => {
  test('accepts a, b, 1, and the option label', () => {
    expect(parseAskUserAnswer(single, 'a')).toBe('Q1: prettier')
    expect(parseAskUserAnswer(single, 'b')).toBe('Q1: biome')
    expect(parseAskUserAnswer(single, '1')).toBe('Q1: prettier')
    expect(parseAskUserAnswer(single, '2')).toBe('Q1: biome')
    expect(parseAskUserAnswer(single, 'prettier')).toBe('Q1: prettier')
    expect(parseAskUserAnswer(single, 'BIOME')).toBe('Q1: biome')
    expect(parseAskUserAnswer(single, ' A ')).toBe('Q1: prettier')
  })

  test('multiSelect accepts comma-separated letters or indexes', () => {
    expect(parseAskUserAnswer(multi, 'a,c')).toBe('Q1: yes\nQ1: later')
    expect(parseAskUserAnswer(multi, '1,3')).toBe('Q1: yes\nQ1: later')
    expect(parseAskUserAnswer(multi, 'yes, later')).toBe('Q1: yes\nQ1: later')
    expect(parseAskUserAnswer(multi, 'A, C')).toBe('Q1: yes\nQ1: later')
  })

  test('returns AskUser: invalid choice for empty or unknown tokens', () => {
    expect(parseAskUserAnswer(single, '')).toBe('AskUser: invalid choice')
    expect(parseAskUserAnswer(single, '   ')).toBe('AskUser: invalid choice')
    expect(parseAskUserAnswer(single, 'z')).toBe('AskUser: invalid choice')
    expect(parseAskUserAnswer(single, '9')).toBe('AskUser: invalid choice')
    expect(parseAskUserAnswer(single, 'eslint')).toBe('AskUser: invalid choice')
    expect(parseAskUserAnswer(single, 'a,b')).toBe('AskUser: invalid choice')
    expect(parseAskUserAnswer(multi, '')).toBe('AskUser: invalid choice')
    expect(parseAskUserAnswer(multi, 'a,z')).toBe('AskUser: invalid choice')
  })

  test('answers multiple single-select questions in one line', () => {
    expect(parseAskUserAnswer(two, 'a,b')).toBe('Q1: prettier\nQ2: no')
    expect(parseAskUserAnswer(two, '1; 2')).toBe('Q1: prettier\nQ2: no')
    expect(parseAskUserAnswer(two, 'prettier\nyes')).toBe('Q1: prettier\nQ2: yes')
    expect(parseAskUserAnswer(two, 'a')).toBe('AskUser: invalid choice')
  })
})

describe('formatAskUserDialog', () => {
  test('reuses formatAskUserPrompt and adds a reply hint', () => {
    const text = formatAskUserDialog(single)
    expect(text.startsWith(formatAskUserPrompt(single))).toBe(true)
    expect(text).toContain('1. Style: Which formatter?')
    expect(text).toContain('a) prettier — default')
    expect(text).toContain('reply with a/b or 1/2')
  })
})

describe('createAskUserBridge', () => {
  test('default ask returns formatAskUserPrompt when no host is bound', async () => {
    const bridge = createAskUserBridge()
    const signal = new AbortController().signal
    expect(await bridge.ask(single, signal)).toBe(formatAskUserPrompt(single))
  })

  test('bind replaces the host and receives input plus signal', async () => {
    const bridge = createAskUserBridge()
    const ac = new AbortController()
    let seen: AskUserInput | undefined
    bridge.bind(async (input, signal) => {
      seen = input
      expect(signal).toBe(ac.signal)
      return parseAskUserAnswer(input, 'a')
    })
    expect(await bridge.ask(single, ac.signal)).toBe('Q1: prettier')
    expect(seen).toEqual(single)
  })

  test('ask refuses when the signal is already aborted', async () => {
    const bridge = createAskUserBridge()
    const ac = new AbortController()
    ac.abort()
    await expect(bridge.ask(single, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
