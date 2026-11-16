---
name: mcp-servers
description: Copy one MCP server into config.yaml.
---

# mcp-servers

This skill is original RavenClaw prose. It is not an upstream copy.

`references/mcp-servers.json` lists upstream endpoints. Open it with the Skill tool name `cursor-pack` and that path. Do not install servers from this skill.

Copy one object from `references/mcp-servers.json` into `~/.ravenclaw/config.yaml` under `mcp.servers`.

```yaml
mcp:
  servers:
    - name: example
      type: http
      url: https://example.com/mcp
```

Replace ${VAR} only in the file you write. Do not commit secrets.

type http needs url. type stdio needs command.

Keep `args`, `headers`, and `env` when the copied object has them. Leave header placeholders as `${...}` until you edit your own config file.
