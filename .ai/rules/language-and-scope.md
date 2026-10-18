---
name: language-and-scope
description: Write all documentation and code artifacts in English. Stay within what was asked — no unrequested features, files, or refactors.
paths:
  - "**"
---

# Language and scope

## Language

- **Write documentation content in English** — note bodies, technical terms,
  filenames, and frontmatter. The artifacts are read by tooling and by future
  contributors in English, whatever language the conversation is held in.

When delegating written work to another agent, **name the output language
explicitly**. A prompt written in another language otherwise produces issues and
documentation in that language.

## Scope

Stay within what was asked. **No unrequested features, files, or refactors**
(YAGNI).

If you find a real problem outside the requested scope, say so in a sentence and
let the user decide — do not fix it unasked, and do not quietly widen the change
to cover it.
