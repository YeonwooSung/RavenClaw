# RavenClaw

RavenClaw is a Bun/TypeScript coding agent. Bring your own API keys (BYOK); no RavenClaw backend is required.

Licensed under Apache-2.0.

## Packages

- `@ravenclaw/core` — query loop, tools, permissions, sessions, Provider port
- `@ravenclaw/providers` — LLM adapter implementations
- `@ravenclaw/ads` — first-party ad layout and house-ad floor (included-model sessions only)
- `@ravenclaw/cli` — `raven` Ink TUI

## Sessions

SQLite WAL, **one live writer per session id**. A second process may read the same database and may create a different session; it must not write the same session id.
