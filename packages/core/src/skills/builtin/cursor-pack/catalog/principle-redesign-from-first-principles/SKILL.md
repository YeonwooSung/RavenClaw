---
name: principle-redesign-from-first-principles
description: "Apply when integrating a new requirement into an existing design."
---
RavenClaw note: upstream MIT text from https://github.com/cursor/plugins. Ignore Cursor stop hooks, cloud agents, canvases, and model slugs. Use the cursor-pack router limits.

# Redesign From First Principles

When integrating a change, don't bolt it onto the existing design. Redesign as if the requirement had been a foundational assumption from the start.

- Read all affected files and understand the current design
- Ask: "if we were writing this from scratch with this new requirement, what would we build?"
- Propagate the change through every reference: types, docs, examples, rationale sections
- Think about the whole redesign, then deliver it incrementally

This is the method for preserving option value when integrating changes into an existing design.
