# Design exports — reference only

HTML snapshots of the frames in `assets/web-app/web-app.pen`, produced by the
Pencil MCP `Export(..., "html-tailwind", ...)` call.

## Nothing in this folder is imported by the application

Not by a component, not by a build step, not at runtime. `apps/web/src/` reads
none of it. These files exist so that "what did this screen look like in the
design?" can be answered without opening Pencil, and so a design change shows up
as a reviewable diff in a pull request.

## Do not hand-edit these files

A hand-edited export is a third source of truth that lies. Re-export instead:
re-run the `pencil-design-extraction` skill.

## What is deliberately NOT reusable here

- Colours are arbitrary values (`bg-[#1F2733]`), not design tokens. The tokens
  live in `apps/web/src/styles.css`, read from the `.pen` via `GetVariables()`.
- Each file is one frame at one fixed width. Components are responsive across
  the 390/1440 pair.
- The files link `cdn.tailwindcss.com` and Google Fonts. The app self-hosts
  Inter and compiles Tailwind at build time.
- Some frames reference an `images.unsplash.com` placeholder. That is design-time
  stock art, not brand artwork, and must never ship.

Structure, spacing and layer names (`data-pencil-name`) ARE worth reading.
