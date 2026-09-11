const OSC52_CAP = 24_000

export function formatConversationMarkdown(
  messages: Array<{ role: string; text: string }>,
): string {
  const parts = ['# conversation']
  for (const message of messages) {
    parts.push(`## ${message.role}\n${message.text}`)
  }
  return parts.join('\n\n')
}

export function copyConversationToClipboard(markdown: string): {
  ok: boolean
  method: 'osc52' | 'pbcopy' | 'none'
  text: string
} {
  const osc = osc52Payload(markdown)
  if (process.platform === 'darwin' && tryPbcopy(markdown)) {
    return { ok: true, method: 'pbcopy', text: osc }
  }
  return { ok: true, method: 'osc52', text: osc }
}

function osc52Payload(markdown: string): string {
  const clipped = markdown.slice(0, OSC52_CAP)
  const b64 = Buffer.from(clipped, 'utf8').toString('base64')
  return `\x1b]52;c;${b64}\x07`
}

function tryPbcopy(markdown: string): boolean {
  try {
    const result = Bun.spawnSync(['/bin/sh', '-c', 'printf %s "$1" | pbcopy', '_', markdown], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}
