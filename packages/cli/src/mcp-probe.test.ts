import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfiguredMcpTools } from './mcp'
import { formatMcpToolsReport } from './mcp-probe'

const echoFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-echo-server.ts')

describe('formatMcpToolsReport', () => {
  test('empty config is no mcp servers', async () => {
    expect(await formatMcpToolsReport([])).toBe('no mcp servers')
  })

  test('live echo fixture lists echo_n', async () => {
    const text = await formatMcpToolsReport(
      [{ name: 'echo', command: process.execPath, args: [echoFixture] }],
      loadConfiguredMcpTools,
    )
    expect(text).toBe('echo  echo_n')
  }, 10_000)

  test('failed spawn is labelled failed', async () => {
    const text = await formatMcpToolsReport(
      [{ name: 'gone', command: '/no/such/raven-mcp', args: [] }],
      loadConfiguredMcpTools,
    )
    expect(text).toBe('gone  (no tools or failed)')
  }, 10_000)
})
