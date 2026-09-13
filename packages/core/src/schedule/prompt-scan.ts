export type CronPromptScan = { ok: true } | { ok: false; message: string }

const INVISIBLE =
  /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/
const IGNORE_PREVIOUS = /ignore\s+previous\s+instructions/i
const CURL_SECRET = /\bcurl\b[\s\S]*\$(?:\{)?(?:TOKEN|SECRET)\b/i

export function scanCronPrompt(prompt: string): CronPromptScan {
  if (INVISIBLE.test(prompt)) {
    return { ok: false, message: 'prompt refused: contains invisible unicode' }
  }
  if (IGNORE_PREVIOUS.test(prompt)) {
    return { ok: false, message: 'prompt refused: ignore previous instructions' }
  }
  if (readsSecretsFromDisk(prompt)) {
    return { ok: false, message: 'prompt refused: reads secrets from disk' }
  }
  if (CURL_SECRET.test(prompt)) {
    return { ok: false, message: 'prompt refused: exfiltrates $TOKEN/$SECRET' }
  }
  return { ok: true }
}

function readsSecretsFromDisk(prompt: string): boolean {
  if (!/\bcat\b/i.test(prompt)) return false
  if (/\bid_rsa\b/i.test(prompt)) return true
  if (/(?:~|\$HOME)\/\S*\.env\b/i.test(prompt)) return true
  if (/(?:^|[\s\/])\.env\b/i.test(prompt)) return true
  return false
}
