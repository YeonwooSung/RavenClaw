# RavenClaw cron / scheduler

Local, first-class agent jobs. No hosted wake, no OS installer, no Claude/Hermes source.

## Intent

A job is a durable `{schedule, cwd, prompt}`. When due, RavenClaw opens a **new** session (same engine as `raven exec`, `dontAsk`) and submits the prompt. Interactive pairing stays untouched. Ads/included caps apply to that new session the same way they apply to exec.

## Patterns

| Pattern | Role |
|---|---|
| Repository | `CronStore` — load/save jobs under `~/.ravenclaw/cron/jobs.json` |
| Strategy | `Schedule` — 5-field cron **or** interval |
| Template method | `claimDue` → persist `nextFireAt` → `run` → record status |
| Mutex | mkdir lock on the jobs file so two `tick` processes cannot claim the same fire |
| Observer | 15s ticker in the TUI and `raven cron watch` |

## Job

```
CronJob {
  id: string              // c_ + 8 hex
  name: string
  enabled: boolean
  cwd: string
  prompt: string
  schedule: CronSchedule | IntervalSchedule
  nextFireAt: number      // unix ms, UTC
  lastFireAt?: number
  lastStatus?: 'ok' | 'error' | 'skipped'
  lastError?: string
  lastSessionId?: string
  createdAt: number
}

CronSchedule    { kind: 'cron'; expr: string }   // 5-field, UTC
IntervalSchedule { kind: 'every'; everyMs: number }
```

`nextFireAt` is written **before** execute. Crash after claim skips that slot; it does not double-fire.

Overlap: if a process is already running that `id`, `claimDue` returns skipped. No queue.

## Schedule language

User-facing spec (one token or a quoted 5-field):

- `every 30s` / `every 5m` / `every 2h` — interval, min 15s
- `0 9 * * 1-5` — standard cron (min hour dom month dow). `0` = Sunday. Supports `*`, `n`, `n-m`, `*/n`, lists.
- `@hourly` → `0 * * * *`, `@daily` → `0 0 * * *`

Timezone is UTC. Documented in `/cron` help.

## Surfaces

**Slash (in-session):** `/cron` list; `/cron add <spec> <prompt>`; `/cron rm <id>`; `/cron on|off <id>`.

**CLI (no API key for mutate/list):** `raven cron list|add|rm|on|off`. `raven cron tick` (one pass) and `raven cron watch` (loop) need a key only if a job actually fires.

**Tools (root only, leftover-ask on mutate):** `CronCreate`, `CronList`, `CronDelete`, `CronSetEnabled`. `CronList` is read-only allow. `dontAsk` allows `CronList` and denies the mutators.

**Ticker:** Ink/OpenTUI poll every 15s. Fires do not steal the live turn; they boot a child session and post a status line.

## Out of scope

Remote/kairos wake, launchd/systemd installer, email, teammate swarms, seconds-field cron, timezone names, job-to-job DAG.

## Tests

Pure: parse spec, next fire, claim lock, leftover-ask. CLI: parseArgv + format list. No live model in unit tests — runner takes a `runJob` port.
