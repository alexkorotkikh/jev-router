# Task types

Jev Router asks Jev different questions depending on what kind of work a prompt is. All of it
lives in `src/config.mjs`.

| Type | Used for | Extra questions Jev scores |
|------|----------|----------------------------|
| `coding` (default) | Implementation, debugging, tests | task complexity, tool complexity |
| `psh` | Product Specification Harness: brainstorms, benchmarks, scoping, PRDs | depth of analysis, stakeholder complexity |
| `pdh` | Product Development Harness: intake, architecture, epics, release | architecture complexity, cross-team coordination |
| `research` | Research, competitive and trend analysis | research scope, synthesis complexity |
| `documentation` | Guides, API docs, READMEs | content complexity, audience breadth |
| `process` | Harness, skills, setup, troubleshooting | system complexity, debugging difficulty |

Every type also scores "reasoning required". Each type has its own guidance for each model tier,
which Jev reads when picking the model.

## How the type is chosen

1. An explicit phrase such as `use psh`, `switch to research` or `with documentation`.
2. Otherwise, the first keyword match, checked in the order psh, pdh, research, documentation,
   process, coding (`TASK_TYPES[*].keywords`).
3. Otherwise, `coding`.

Tier overrides (`use strong`, `use fast`, ...) work as before and are independent of the task type.

## Known limits

- Detection is single-keyword matching, so mixed prompts take the first type in the order above,
  and everyday phrases like "with research" count as an explicit override.
- `jev-explain` only displays the coding metrics; other types' scores are recorded in the
  decision but not shown.
