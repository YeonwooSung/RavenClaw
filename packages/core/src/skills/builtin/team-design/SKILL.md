---
name: team-design
description: Design project agents and skills under .ravenclaw/.
---

# team-design

Load this before designing a reusable agent team for the current project. The skill index cannot carry every trigger, so the body does. Use it for 하네스 구성, 에이전트 팀, "design a team", project agents, and project skills.

Do not apply retrospective feedback here. Adding, removing, or replacing a role is in scope. Tuning prose from a past run is not.

Ask the user to accept the roster before writing files.

## Look first

Read .ravenclaw/agents/ and .ravenclaw/skills/ on the project root, plus ~/.ravenclaw/agents/ and ~/.ravenclaw/skills/. The project root is projectCwd when the turn has one, and cwd otherwise. Compare them with the catalog ids general, file-finder, command-runner, reviewer, and researcher-web.

general edits and inherits the parent prompt, with Read, Grep, Glob, ListDir, Edit, Write, ApplyPatch, Bash, and Skill, for at most 30 rounds. file-finder returns at most 20 lines, with Read, Grep, and Glob, for at most 8 rounds. command-runner has Read and Bash, runs at most 2 rounds, and does not explore the repo or chain extra commands. reviewer has no tools, sees the parent messages, and runs at most 4 rounds. researcher-web has WebSearch and Fetch, for at most 12 rounds.

Do not reuse a catalog agent id for a new disk agent. A file with one of those ids is ignored when a child runs. The catalog definition runs instead.

Do not shadow a builtin skill name. A project skill with the same name replaces the builtin for this project. The live skill index is the list of names you must not reuse.

If a catalog id already covers the role, name that id in the orchestrator and do not write a disk file. If a project skill already covers the procedure, extend that skill.

Do not write an agent named root. A disk file named root becomes a spawnable child and runs that file. It does not become the session root.

## What a roster contains

Propose, and stop:

- each disk agent id, one line on the role
- each project skill name, one line on the procedure
- one orchestrator skill
- whether an always-on hook will be written

Write project agents under the project root .ravenclaw/agents/ and project skills under the project root .ravenclaw/skills/. A session worktree cwd is the wrong directory. Use ~/.ravenclaw/agents/ and ~/.ravenclaw/skills/ only when the user asks for every project.

Write generated files in the language the user is using. Keep the language of a file you are extending.

## Agent file

An agent file says who works. A skill file says how.

```markdown
---
name: analyst
allowed-tools: Read, Grep, Glob
---

Role, inputs, outputs, and what to do on a bad input.
```

`name` matches the file name without `.md`. Default disk agent tools are Read, Grep, and Glob. Omit `allowed-tools` to keep that default. A disk agent that edits lists Edit, Write, and ApplyPatch in allowed-tools. A disk agent that must run a command lists Bash in allowed-tools. Read-only review uses the catalog reviewer.

The root opens the procedure skill and copies the steps the child needs into the Agent prompt. The disk agent body stays the role. A disk agent does not see the skill index.

Disk agents run at most 12 rounds. Do not promise another limit. Do not put a model key in an agent file. The loader ignores it. A disk agent cannot spawn a child.

## Skill file

```markdown
---
name: domain-run
description: Run the domain team for this project.
---
```

The description is one line of at most 60 characters. The trigger words sit inside those 60 characters. Do not fold the description. Do not set allowed-tools on a generated skill. Keep each generated SKILL.md under 500 lines. Move detail next to it under references/. Open a generated reference with the Skill tool name of that generated skill and the path of the reference. A path opened from team-design stays inside the team-design directory.

The orchestrator skill includes one success check and one failure check.

## How the team runs

The root still does the work. A child does not spawn another child. At most 6 children run together.

Do not set agents[] and run_in_background together. That call returns Agent failed: agents[] cannot run in the background.

Call Agent with subagent set to a catalog id or a disk agent id. Call a disk id only after the user has accepted that id in the roster. Do not add a preset to /crew.

When the graph matches a preset, match the wave shape and do not invent a slash. Review is one file-finder, then one reviewer. Research is researcher-web, plus file-finder in the same agents[] batch when the goal refers to this repository. Implement is agents[] of general, 1 through 6, each prompt listing exclusive paths, then one reviewer.

If the tool result contains Agent failed:, Subagent ', Unknown subagent:, aborted:, or permission_denied:, report that result and stop. Do not retry. Do not invent the missing judgment.

Do not create .ravenclaw/workspace/ unless the user asks for intermediate files. Add .ravenclaw/workspace/ to the project's .gitignore when you create it.

## Always-on hook

The always-on hook is .ravenclaw/RAVEN.md and only after a separate yes. Append exactly this section, or replace an existing section with the same heading. Do not write any other instruction file.

```markdown
## Team: {name}

**Goal:** {one line}

**When:** For {domain} work, open the skill `{skill-name}`. A direct question can be answered without it.
```

Put the change log in the orchestrator skill under ## Changes. Each entry is one line with the date, the target, and the reason. Do not put the roster or the change log in the hook.
