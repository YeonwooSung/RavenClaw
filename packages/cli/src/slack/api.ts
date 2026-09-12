import type {
  SlackApi,
  SlackPostMessageOpts,
  SlackPostMessageResult,
  SlackUpdateMessageOpts,
} from './types'

const SLACK_API = 'https://slack.com/api'

export function createSlackWebApi(opts: {
  botToken: string
  fetch?: typeof fetch
}): SlackApi {
  const doFetch = opts.fetch ?? fetch
  const auth = { Authorization: `Bearer ${opts.botToken}` }

  return {
    async postMessage(input: SlackPostMessageOpts): Promise<SlackPostMessageResult> {
      const body: Record<string, unknown> = { channel: input.channel, text: input.text }
      if (input.threadTs !== undefined) body.thread_ts = input.threadTs
      if (input.blocks !== undefined) body.blocks = input.blocks
      const json = await slackCall(doFetch, 'chat.postMessage', auth, body)
      if (json.ok !== true) return { ok: false }
      const ts = typeof json.ts === 'string' ? json.ts : undefined
      return ts !== undefined ? { ok: true, ts } : { ok: true }
    },

    async updateMessage(input: SlackUpdateMessageOpts): Promise<{ ok: boolean }> {
      const json = await slackCall(doFetch, 'chat.update', auth, {
        channel: input.channel,
        ts: input.ts,
        text: input.text,
      })
      return { ok: json.ok === true }
    },

    async authTest() {
      const json = await slackCall(doFetch, 'auth.test', auth, {})
      if (json.ok !== true) return { ok: false }
      const userId = typeof json.user_id === 'string' ? json.user_id : undefined
      const teamId = typeof json.team_id === 'string' ? json.team_id : undefined
      const out: { ok: boolean; userId?: string; teamId?: string } = { ok: true }
      if (userId !== undefined) out.userId = userId
      if (teamId !== undefined) out.teamId = teamId
      return out
    },
  }
}

async function slackCall(
  doFetch: typeof fetch,
  method: string,
  auth: { Authorization: string },
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await doFetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })
  const json: unknown = await res.json()
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { ok: false }
  return json as Record<string, unknown>
}
