import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultModelId } from '@ravenclaw/core'
import { formatPublicConfig } from './config-print'

describe('formatPublicConfig', () => {
  test('prints defaults and unset keys when home is empty', () => {
    const home = join(tmpdir(), `raven-cfg-empty-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const text = formatPublicConfig({ home })
    expect(text).toContain(`home: ${home}`)
    expect(text).toContain('provider: (unset)')
    expect(text).toContain(`model: ${defaultModelId('anthropic')}`)
    expect(text).toContain('ANTHROPIC_API_KEY: unset')
    expect(text).not.toContain('sk-')
  })

  test('redacts secrets and shows yaml overlay', () => {
    const home = join(tmpdir(), `raven-cfg-yaml-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-ant-secret-value\n')
    writeFileSync(
      join(home, 'config.yaml'),
      'provider: anthropic\nmodel: anthropic/claude-sonnet-4\nmcp:\n  servers:\n    - name: fs\n      command: bun\n',
    )
    const text = formatPublicConfig({ home })
    expect(text).toContain('provider: anthropic')
    expect(text).toContain('ANTHROPIC_API_KEY: set (19 chars)')
    expect(text).toContain('mcp.servers: fs')
    expect(text).not.toContain('sk-ant-secret-value')
  })
})
