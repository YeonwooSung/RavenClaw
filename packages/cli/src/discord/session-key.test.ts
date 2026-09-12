import { describe, expect, test } from 'bun:test'
import { sessionLockedMessage } from '@ravenclaw/core'
import { discordEventIsDm, discordSessionKey } from './session-key'
import { DISCORD_LOCK_HOLDER } from './run'

describe('discordSessionKey', () => {
  test('guild, thread, and dm shapes', () => {
    expect(discordSessionKey({ guildId: 'G1', channelId: 'C1', isDm: false })).toBe(
      'raven:discord:G1:C1',
    )
    expect(
      discordSessionKey({ guildId: 'G1', channelId: 'C1', threadId: 'T9', isDm: false }),
    ).toBe('raven:discord:G1:C1:T9')
    expect(discordSessionKey({ channelId: 'D1', isDm: true })).toBe('raven:discord:dm:D1')
    expect(discordEventIsDm({})).toBe(true)
    expect(discordEventIsDm({ guildId: 'G1' })).toBe(false)
  })
})

describe('lock holder', () => {
  test("is 'discord', not 'serve'", () => {
    expect(DISCORD_LOCK_HOLDER).toBe('discord')
    const expiresAt = Date.parse('2026-09-13T00:00:00.000Z')
    expect(sessionLockedMessage(DISCORD_LOCK_HOLDER, expiresAt)).toBe(
      'session locked by discord until 2026-09-13T00:00:00.000Z',
    )
  })
})
