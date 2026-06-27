---
title: "ADR-0015: draw.io as the vault diagram format"
type: adr
area: shared
status: accepted
id: ADR-0015
created: 2026-06-27
updated: 2026-06-27
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags:
  - type/adr
  - area/shared
  - status/accepted
related:
  - "[[architecture]]"
  - "[[system-context]]"
  - "[[index]]"
---

# ADR-0015: draw.io as the vault diagram format

## Context

The vault's diagrams were originally written as Mermaid code blocks embedded in note bodies. This approach has several problems:

- **Inconsistent rendering:** Mermaid support varies across Obsidian versions. C4 diagram types (`C4Context`, `C4Container`) are not stable in the bundled Mermaid version and fail to render in some builds.
- **Line-break handling:** Multi-line node labels using `\n` do not render reliably inside Mermaid blocks — they appear as literal `\n` text rather than newlines.
- **No native editing surface:** Mermaid diagrams are edited as raw text; there is no drag-and-drop visual editing within Obsidian.
- **GitHub rendering:** Mermaid blocks in `.md` files on GitHub require JavaScript; `.svg` files render natively as images without any plugin.

## Decision

Diagrams in the vault are authored in **draw.io** and stored as `.drawio.svg` files. The file format is a standard SVG whose root `<svg>` element carries a `content` attribute containing the draw.io XML (`mxGraphModel`) escaped as HTML entities. This dual-format file:

- Renders as a static SVG image in any SVG-capable viewer (GitHub, browsers).
- Remains fully editable in draw.io (desktop or web app), which reads the `content` attribute.
- Renders interactively in Obsidian via the **Diagrams** community plugin, which understands the `.drawio.svg` format.

**Storage convention:** diagram files live in a `diagrams/` subfolder next to the section of the vault that uses them (e.g., `docs/00-overview/diagrams/`). Notes embed them with the standard Obsidian embed syntax:

```
![[name.drawio.svg]]
```

Mermaid is no longer the diagram source format for new diagrams. Existing Mermaid diagrams are migrated to `.drawio.svg` (starting with the overview notes `architecture.md` and `system-context.md`).

## Consequences

**Positive:**

- Diagrams render consistently in Obsidian (Diagrams plugin) regardless of Obsidian version or Mermaid bundling.
- SVG renders natively on GitHub — no plugin or JavaScript required.
- Diagrams are visually editable in draw.io and remain version-controlled in the repo.
- The vault validator (`scripts/validate-vault.mjs`) checks only `.md` files — `.drawio.svg` files require no validator changes.

**Negative / trade-offs:**

- draw.io desktop or web app is required to edit diagrams (no in-editor text edit as with Mermaid).
- Initial migration effort for existing Mermaid diagrams.
- The Diagrams plugin must be installed in Obsidian for interactive rendering; without it, the static SVG placeholder is shown.

## Related

- [[architecture]]
- [[system-context]]
- [[index]]
