import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { copyConversationToClipboard, formatConversationMarkdown } from './copy-conversation'

describe('formatConversationMarkdown', () => {
  test('renders a heading per role', () => {
    expect(
      formatConversationMarkdown([
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi' },
      ]),
    ).toBe('# conversation\n\n## user\nhello\n\n## assistant\nhi')
  })

  test('empty transcript is just the title', () => {
    expect(formatConversationMarkdown([])).toBe('# conversation')
  })
})

describe('copyConversationToClipboard', () => {
  let spawnSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    spawnSpy?.mockRestore()
    spawnSpy = undefined
  })

  function failSpawn(): void {
    spawnSpy = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as ReturnType<typeof Bun.spawnSync>)
  }

  test('osc52 text is the base64 of the markdown', () => {
    failSpawn()
    const markdown = 'hello copy'
    const result = copyConversationToClipboard(markdown)
    const b64 = Buffer.from(markdown, 'utf8').toString('base64')
    expect(result.ok).toBe(true)
    expect(result.method).toBe('osc52')
    expect(result.text).toBe(`\x1b]52;c;${b64}\x07`)
    expect(result.text).toContain(b64)
  })

  test('encodes at most 24000 markdown characters', () => {
    failSpawn()
    const markdown = 'x'.repeat(24_001)
    const result = copyConversationToClipboard(markdown)
    const clipped = Buffer.from('x'.repeat(24_000), 'utf8').toString('base64')
    expect(result.text).toBe(`\x1b]52;c;${clipped}\x07`)
  })
})
