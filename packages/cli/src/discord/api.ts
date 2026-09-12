import type { DiscordApi } from './types'

const DISCORD_API = 'https://discord.com/api/v10'

export function createDiscordApi(
  token: string,
  opts?: { fetch?: typeof fetch },
): DiscordApi {
  const doFetch = opts?.fetch ?? fetch
  const headers = {
    Authorization: `Bot ${token}`,
    'content-type': 'application/json',
  }

  return {
    async createMessage(input) {
      const json = await discordCall(
        doFetch,
        `/channels/${input.channelId}/messages`,
        { method: 'POST', headers, body: JSON.stringify({ content: input.content }) },
      )
      if (!json) return { ok: false }
      const id = typeof json.id === 'string' ? json.id : undefined
      return id !== undefined ? { ok: true, id } : { ok: true }
    },

    async editMessage(input) {
      const json = await discordCall(
        doFetch,
        `/channels/${input.channelId}/messages/${input.messageId}`,
        { method: 'PATCH', headers, body: JSON.stringify({ content: input.content }) },
      )
      return { ok: json !== undefined }
    },

    async getBotUserId() {
      const json = await discordCall(doFetch, '/users/@me', { method: 'GET', headers })
      return typeof json?.id === 'string' ? json.id : undefined
    },
  }
}

async function discordCall(
  doFetch: typeof fetch,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await doFetch(`${DISCORD_API}${path}`, init)
    if (!res.ok) return undefined
    const json: unknown = await res.json()
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return undefined
    return json as Record<string, unknown>
  } catch {
    return undefined
  }
}
