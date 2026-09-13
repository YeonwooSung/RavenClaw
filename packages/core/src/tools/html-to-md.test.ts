import { describe, expect, test } from 'bun:test'
import { htmlToMarkdown, isHtmlPayload } from './html-to-md'

describe('htmlToMarkdown', () => {
  test('detects HTML by content-type or doctype/html prefix', () => {
    expect(isHtmlPayload('text/html; charset=utf-8', 'hello')).toBe(true)
    expect(isHtmlPayload('text/plain', '<!doctype html><p>x</p>')).toBe(true)
    expect(isHtmlPayload('text/plain', '<html><p>x</p></html>')).toBe(true)
    expect(isHtmlPayload('text/plain', 'hello')).toBe(false)
    expect(isHtmlPayload('application/json', '{"a":1}')).toBe(false)
  })

  test('converts headings, links, lists, and code and strips script/style', () => {
    const md = htmlToMarkdown(`
      <html><head><style>body{color:red}</style><script>alert(1)</script></head>
      <body>
        <h1>Title</h1>
        <p>See <a href="https://example.com">docs</a>.</p>
        <ul><li>one</li><li>two</li></ul>
        <pre><code>const x = 1</code></pre>
      </body></html>
    `)
    expect(md).toContain('# Title')
    expect(md).toContain('[docs](https://example.com)')
    expect(md).toContain('- one')
    expect(md).toContain('- two')
    expect(md).toContain('```')
    expect(md).toContain('const x = 1')
    expect(md).not.toContain('alert(1)')
    expect(md).not.toContain('color:red')
    expect(md).not.toMatch(/<script|<style|<h1/i)
  })
})
