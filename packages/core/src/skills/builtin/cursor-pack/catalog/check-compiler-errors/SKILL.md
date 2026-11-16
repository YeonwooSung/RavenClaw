---
name: check-compiler-errors
description: "Run compile and type-check commands and report failures"
---
RavenClaw note: upstream MIT text from https://github.com/cursor/plugins. Ignore Cursor stop hooks, cloud agents, canvases, and model slugs. Use the cursor-pack router limits.

# Check compiler errors

## Trigger

Compile or type-check failures are blocking local validation or CI.

## Workflow

1. Run the repo's compile and type-check commands.
2. Summarize errors by file and type.
3. Fix the highest-confidence issues first.
4. Re-run checks until clean or blocked.

## Output

- Current compile and type-check status
- Error summary grouped by file and category
- Fixes applied and remaining blockers
