---
name: cancel-ralph
description: "Cancel an active Ralph Loop. Use when the user wants to stop, cancel, or abort a running ralph loop."
---
RavenClaw note: upstream MIT text from https://github.com/cursor/plugins. Ignore Cursor stop hooks, cloud agents, canvases, and model slugs. Use the cursor-pack router limits.

# Cancel Ralph

## Trigger

The user wants to cancel or stop an active Ralph loop.

## Workflow

1. Check if `.ravenclaw/ralph/scratchpad.md` exists.

2. **If it does not exist**: Tell the user "No active Ralph loop found."

3. **If it exists**:
   - Read `.ravenclaw/ralph/scratchpad.md` to get the current iteration from the `iteration:` field.
   - Remove the state file and any done flag:
     ```bash
     rm -rf .ravenclaw/ralph
     ```
   - Report: "Cancelled Ralph loop (was at iteration N)."

## Output

A short confirmation with the iteration count, or a message that no loop was active.
