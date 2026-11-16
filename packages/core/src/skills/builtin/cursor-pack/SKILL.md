---
name: cursor-pack
description: Cursor plugin workflows, principles, and MCP map.
---

# cursor-pack

Cursor plugin workflows, principles, and an MCP map. This is one router, not a marketplace.

Catalog skills are not preloaded. Only this router's name and description are in the skill index. Open only the skills the request needs. Call the Skill tool with name `cursor-pack` and a path such as `catalog/cli-for-agents/SKILL.md`. Do not open the whole catalog.

Catalog text loses when it conflicts with this router.

Read `references/catalog-index.md` for catalog names, `references/mcp-servers.json` for endpoints, and `references/skipped.md` for what was left out.

## Limits

Agent depth is 1. At most 6 children. Do not set agents[] and run_in_background together.

Child ids are `general`, `file-finder`, `command-runner`, `reviewer`, and `researcher-web`. Do not pass a child model slug. There is no cloud environment.

For a Ralph loop, run /loop with n at most 20. There is no stop hook.

State files go under .ravenclaw/. Do not write state under `.cursor/`.

For a game, use the builtin skill name `gamedev`. For project agent design, use the builtin skill name `team-design`.
