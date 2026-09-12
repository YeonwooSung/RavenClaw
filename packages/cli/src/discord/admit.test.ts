import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { approvePairingCode, issueOrReusePending } from '../pairing'
import { admitDiscordEvent } from './admit'
import type { DiscordConfig, DiscordInbound } from './types'

function home(): string {
  const dir = join(tmpdir(), `raven-admit-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cfg(over: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    enabled: true,
    token: 't',
    allowFrom: ['U1'],
    channels: ['C1'],
    mentionOnly: true,
    ...over,
  }
}

function ev(over: Partial<DiscordInbound> = {}): DiscordInbound {
  return {
    id: 'm1',
    channelId: 'C1',
    userId: 'U1',
    content: 'hi',
    guildId: 'G1',
    mentioned: true,
    isBot: false,
    ...over,
  }
}

describe('admitDiscordEvent', () => {
  test('drops bots, empty, missing mention, empty allowFrom channels, and unapproved DMs', () => {
    const h = home()
    expect(admitDiscordEvent(ev({ isBot: true }), cfg(), { home: h })).toBe('ignore')
    expect(admitDiscordEvent(ev({ content: '  ' }), cfg(), { home: h })).toBe('ignore')
    expect(admitDiscordEvent(ev({ mentioned: false }), cfg(), { home: h })).toBe('ignore-mention')
    expect(admitDiscordEvent(ev(), cfg({ channels: [] }), { home: h })).toBe('ignore-channel')
    expect(admitDiscordEvent(ev({ userId: 'U9' }), cfg({ allowFrom: [] }), { home: h })).toBe(
      'deny-allowFrom',
    )
    expect(
      admitDiscordEvent(ev({ guildId: undefined, channelId: 'D1', userId: 'U9' }), cfg({ allowFrom: [] }), {
        home: h,
      }),
    ).toBe('pair-dm')
  })

  test('pairing-approved DM is ok', () => {
    const h = home()
    const issued = issueOrReusePending(h, 'discord', 'U9', { randomCode: () => '111111' })
    expect(approvePairingCode(h, issued.code).ok).toBe(true)
    expect(
      admitDiscordEvent(
        ev({ guildId: undefined, channelId: 'D1', userId: 'U9', content: 'hello' }),
        cfg({ allowFrom: [] }),
        { home: h },
      ),
    ).toBe('ok')
  })
})
