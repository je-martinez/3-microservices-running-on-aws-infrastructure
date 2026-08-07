---
name: language-and-scope
description: Converse with the user in Spanish; write all documentation and code artifacts in English. Stay within what was asked — no unrequested features, files, or refactors.
paths:
  - "**"
---

# Language and scope

## Language

- **Converse with the user in Spanish.**
- **Write documentation content in English** — note bodies, technical terms,
  filenames, and frontmatter.

The split is deliberate: the conversation is with a Spanish speaker, the
artifacts are read by tooling and by future contributors in English.

When delegating written work to another agent, **name the output language
explicitly**. A Spanish prompt otherwise produces Spanish issues and Spanish
documentation.

## Scope

Stay within what was asked. **No unrequested features, files, or refactors**
(YAGNI).

If you find a real problem outside the requested scope, say so in a sentence and
let the user decide — do not fix it unasked, and do not quietly widen the change
to cover it.
