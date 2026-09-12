import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('runDiscord', () => {
  test('missing token exits 1', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-discord-run-'))
    writeFileSync(join(home, 'config.yaml'), 'discord:\n  enabled: true\n')
    const prev = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    delete process.env.DISCORD_BOT_TOKEN
    try {
      const { runDiscord } = await import('./run')
      expect(await runDiscord({ flags: {} })).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = prev
    }
  })
})
