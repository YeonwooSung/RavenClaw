export type BangLine = { kind: 'bash'; command: string } | { kind: 'other'; text: string }

const OUTPUT_CAP = 20_000
const TIMEOUT_MS = 30_000

export function parseBangLine(line: string): BangLine {
  if (line.startsWith('!')) {
    return { kind: 'bash', command: line.slice(1).trimStart() }
  }
  if (line === '/bash' || line.startsWith('/bash ') || line.startsWith('/bash\t')) {
    return { kind: 'bash', command: line.slice('/bash'.length).trim() }
  }
  return { kind: 'other', text: line }
}

export function runBangCommand(command: string, cwd: string): { text: string; code: number } {
  if (command.trim() === '') return { text: 'empty command', code: 1 }
  try {
    const result = Bun.spawnSync(['/bin/sh', '-c', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: TIMEOUT_MS,
    })
    const stdout = decode(result.stdout)
    const stderr = decode(result.stderr)
    const combined = `${stdout}${stderr}`
    const text = combined.length > OUTPUT_CAP ? combined.slice(0, OUTPUT_CAP) : combined
    return { text, code: result.exitCode ?? 1 }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), code: 1 }
  }
}

function decode(buf: Uint8Array | undefined): string {
  if (buf === undefined || buf.length === 0) return ''
  return new TextDecoder().decode(buf)
}
