---
name: get-pr-comments
description: "Fetch and summarize review comments from the active pull request"
---
RavenClaw note: upstream MIT text from https://github.com/cursor/plugins. Ignore Cursor stop hooks, cloud agents, canvases, and model slugs. Use the cursor-pack router limits.

# Get PR comments

## Trigger

Need a concise, actionable summary of feedback on the active pull request.

## Workflow

1. Resolve the active PR for the current branch.
2. Fetch review comments and discussion comments.
3. Group feedback by severity and actionability.
4. Return a concise action list.

## Output

- Grouped feedback summary
- Action list ordered by priority
- Open questions that still need clarification