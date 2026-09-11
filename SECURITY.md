# Security

RavenClaw is a **local** coding agent. It runs as your OS user, can read and edit the workspace, and can run a shell. There is no RavenClaw backend and no network sandbox.

## Do not send secrets

Never put API keys, `.env` contents, or `~/.ravenclaw/.env` in issues, PRs, or logs.

- `raven doctor` and `raven config` print `set (N chars)` / `unset` only.
- `raven setup` writes `.env` mode `0600`.
- Writes under `~/.ssh/id_*` and `$RAVENCLAW_HOME/state.db` are hard-denied.

If you already pasted a key, rotate it at the provider and treat it as burned.

## Report a vulnerability

Use [GitHub Security Advisories](https://github.com/YeonwooSung/RavenClaw/security/advisories/new) for anything that could let a prompt or tool call:

- exfiltrate keys or the session database
- write outside the intended workspace
- skip a permission deny

Include RavenClaw version (`raven --version`), a minimal repro, and **redacted** logs. Do not open a public issue for that class of bug.

## Supported versions

Please report against the latest tag on `main` (currently 0.1.x). There is no LTS line yet.

## What this project will not do

RavenClaw will not treat “the model ran a command I typed” as a vulnerability. It will treat unexpected file writes, leaked credentials in default output, or a bypass of `dontAsk` / deny rules as in scope.
