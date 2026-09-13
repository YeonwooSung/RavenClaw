export function isHtmlPayload(contentType: string | null, body: string): boolean {
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('text/html') || type.includes('application/xhtml')) return true
  const head = body.slice(0, 256).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

export function htmlToMarkdown(html: string): string {
  let text = html
  text = text.replace(/<script\b[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style\b[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    return `\n\`\`\`\n${decodeEntities(stripTags(inner)).trimEnd()}\n\`\`\`\n`
  })
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
    return `\`${decodeEntities(stripTags(inner))}\``
  })
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    return `\n${'#'.repeat(Number(level))} ${inlineText(inner)}\n`
  })
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => `[${inlineText(inner) || href}](${href})`,
  )
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inlineText(inner)}`)
  text = text.replace(/<\/(?:ul|ol)>/gi, '\n')
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, '\n')
  text = text.replace(/<\/(?:p|div|tr|table|section|article|header|footer|blockquote)>/gi, '\n\n')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

function inlineText(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim()
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n)
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return ''
      return String.fromCodePoint(code)
    })
}
