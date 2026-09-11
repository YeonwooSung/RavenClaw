export function formatFollowupNotice(lines: string[]): string {
  const body = lines.map((line, i) => `${i + 1}. ${line}`).join('\n')
  return `followups:\n${body}`
}

export function pickFollowup(lines: string[], index1Based: number): string | undefined {
  if (!Number.isInteger(index1Based) || index1Based < 1) return undefined
  return lines[index1Based - 1]
}
