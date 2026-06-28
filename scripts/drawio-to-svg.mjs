// scripts/drawio-to-svg.mjs
// Convert a draw.io mxGraphModel (XML) into a self-rendering .drawio.svg:
//   - draws every vertex (rounded/rect/cylinder) and edge (orthogonal, with arrow + label)
//     deterministically from the model's own coordinates (no hand-placed SVG, no overlaps),
//   - embeds the original mxGraphModel in the root <svg content="..."> attribute so the file
//     stays fully editable in draw.io / the Obsidian Diagrams plugin.
//
// Usage:
//   node scripts/drawio-to-svg.mjs <input.drawio-xml> <output.drawio.svg> ["Optional Title"]
// where <input.drawio-xml> is a file containing a raw <mxGraphModel>...</mxGraphModel>.
//
// This is the vault's diagram pipeline (see ADR-0015): author the model, run this to emit
// the committed .drawio.svg that renders on GitHub and in Obsidian and remains editable.

import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath, title] = process.argv;
if (!inPath || !outPath) {
  console.error('Usage: node scripts/drawio-to-svg.mjs <input.xml> <output.drawio.svg> ["Title"]');
  process.exit(2);
}

const xml = readFileSync(inPath, "utf8").trim();

// --- tiny attribute/cell parser (good enough for the flat mxCell lists we author) ---
function attrs(tag) {
  const out = {};
  const re = /(\w[\w-]*)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[2];
  return out;
}
function styleMap(s = "") {
  const o = {};
  for (const part of s.split(";")) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i === -1) o[part] = true;
    else o[part.slice(0, i)] = part.slice(i + 1);
  }
  return o;
}
function decode(s = "") {
  return s
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function esc(s = "") {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Parse cells: each <mxCell ...> optionally followed by an <mxGeometry .../>.
const cells = [];
const cellRe = /<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g;
let cm;
while ((cm = cellRe.exec(xml))) {
  const a = attrs(cm[1]);
  const inner = cm[3] || "";
  const gm = inner.match(/<mxGeometry\b([^>]*?)\/?>(?:[\s\S]*?<\/mxGeometry>)?/);
  const g = gm ? attrs(gm[1]) : {};
  cells.push({
    id: a.id,
    value: a.value != null ? decode(a.value) : "",
    style: styleMap(a.style || ""),
    parent: a.parent,
    vertex: a.vertex === "1",
    edge: a.edge === "1",
    source: a.source,
    target: a.target,
    x: g.x != null ? +g.x : undefined,
    y: g.y != null ? +g.y : undefined,
    w: g.width != null ? +g.width : undefined,
    h: g.height != null ? +g.height : undefined,
  });
}

const byId = new Map(cells.map((c) => [c.id, c]));

// Absolute position of a vertex = its (x,y) plus all ancestor vertex offsets.
function absPos(c) {
  let x = c.x ?? 0;
  let y = c.y ?? 0;
  let p = byId.get(c.parent);
  const seen = new Set();
  while (p && p.vertex && !seen.has(p.id)) {
    seen.add(p.id);
    x += p.x ?? 0;
    y += p.y ?? 0;
    p = byId.get(p.parent);
  }
  return { x, y };
}

const vertices = cells.filter((c) => c.vertex && c.w != null);
const edges = cells.filter((c) => c.edge && c.source && c.target);

// compute bounds
let maxX = 0;
let maxY = 0;
for (const v of vertices) {
  const { x, y } = absPos(v);
  maxX = Math.max(maxX, x + v.w);
  maxY = Math.max(maxY, y + v.h);
}
const PAD = 30;
const W = maxX + PAD;
const H = maxY + PAD + 20; // room for title

function center(c) {
  const { x, y } = absPos(c);
  return { cx: x + c.w / 2, cy: y + c.h / 2, x, y };
}

// orthogonal-ish connector: exit from the side of source facing the target, L-shaped.
function connector(s, t) {
  const a = center(s);
  const b = center(t);
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  let sx;
  let sy;
  let tx;
  let ty;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // horizontal-dominant: exit left/right
    sx = a.cx + (dx >= 0 ? s.w / 2 : -s.w / 2);
    sy = a.cy;
    tx = b.cx + (dx >= 0 ? -t.w / 2 : t.w / 2);
    ty = b.cy;
    const midX = (sx + tx) / 2;
    return `M${sx},${sy} L${midX},${sy} L${midX},${ty} L${tx},${ty}`;
  }
  // vertical-dominant: exit top/bottom
  sx = a.cx;
  sy = a.cy + (dy >= 0 ? s.h / 2 : -s.h / 2);
  tx = b.cx;
  ty = b.cy + (dy >= 0 ? -t.h / 2 : t.h / 2);
  const midY = (sy + ty) / 2;
  return `M${sx},${sy} L${sx},${midY} L${tx},${midY} L${tx},${ty}`;
}

function edgeMid(s, t) {
  const a = center(s);
  const b = center(t);
  return { mx: (a.cx + b.cx) / 2, my: (a.cy + b.cy) / 2 };
}

// wrap a label into <=N-char lines on spaces (cheap, avoids overflow)
function wrap(text, max = 18) {
  const words = text.replace(/\n/g, " \n ").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (w === "\n") {
      lines.push(cur);
      cur = "";
      continue;
    }
    if ((cur + " " + w).trim().length > max) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur ? cur + " " : "") + w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

const parts = [];
const markerColors = new Set();
parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
if (title) {
  parts.push(
    `<text x="${PAD / 2}" y="20" font-family="Helvetica,Arial,sans-serif" font-size="15" font-weight="bold" fill="#263238">${esc(
      title
    )}</text>`
  );
}

// --- edges first (under nodes) ---
for (const e of edges) {
  const s = byId.get(e.source);
  const t = byId.get(e.target);
  if (!s || !t || s.w == null || t.w == null) continue;
  const stroke = e.style.strokeColor && e.style.strokeColor !== "none" ? e.style.strokeColor : "#455A64";
  const dash = e.style.dashed === "1" ? ' stroke-dasharray="6 4"' : "";
  const d = connector(s, t);
  parts.push(
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2"${dash} marker-end="url(#arr-${stroke.replace(
      "#",
      ""
    )})"/>`
  );
  markerColors.add(stroke);
  if (e.value) {
    const { mx, my } = edgeMid(s, t);
    const fc = e.style.fontColor || stroke;
    parts.push(
      `<rect x="${mx - e.value.length * 3.2 - 3}" y="${my - 8}" width="${e.value.length * 6.4 + 6}" height="14" fill="#ffffff" opacity="0.85"/>` +
        `<text x="${mx}" y="${my + 2}" font-family="Helvetica,Arial,sans-serif" font-size="10" text-anchor="middle" fill="${fc}">${esc(
          e.value
        )}</text>`
    );
  }
}

// --- vertices ---
for (const v of vertices) {
  const { x, y } = absPos(v);
  const fill = v.style.fillColor && v.style.fillColor !== "none" ? v.style.fillColor : "none";
  const stroke = v.style.strokeColor && v.style.strokeColor !== "none" ? v.style.strokeColor : "#666666";
  const sw = v.style.strokeWidth || 1;
  const fontColor = v.style.fontColor || (fill === "none" ? "#333333" : "#ffffff");
  const isGroup = v.style.verticalAlign === "top" || fill === "none";
  const isCyl = v.style.shape === "cylinder3";
  const rx = v.style.rounded === "1" || v.style.rounded === "8" ? 6 : 0;
  const dash = v.style.dashed === "1" ? ' stroke-dasharray="6 4"' : "";

  if (isCyl) {
    const ry = 7;
    parts.push(
      `<path d="M${x},${y + ry} a${v.w / 2},${ry} 0 0,0 ${v.w},0 v${v.h - 2 * ry} a${v.w / 2},${ry} 0 0,1 -${v.w},0 z" fill="${fill}" stroke="${stroke}"/>` +
        `<ellipse cx="${x + v.w / 2}" cy="${y + ry}" rx="${v.w / 2}" ry="${ry}" fill="${fill}" stroke="${stroke}"/>`
    );
  } else {
    parts.push(
      `<rect x="${x}" y="${y}" width="${v.w}" height="${v.h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`
    );
  }

  if (v.value) {
    const lines = wrap(v.value, isGroup ? 40 : Math.max(10, Math.floor(v.w / 7)));
    if (isGroup) {
      // group title at top
      parts.push(
        `<text x="${x + 10}" y="${y + 18}" font-family="Helvetica,Arial,sans-serif" font-size="12" font-weight="bold" fill="${fontColor}">${esc(
          lines.join(" ")
        )}</text>`
      );
    } else {
      const lh = 14;
      const startY = y + v.h / 2 - ((lines.length - 1) * lh) / 2;
      const bold = v.style.fontStyle === "1" ? ' font-weight="bold"' : "";
      lines.forEach((ln, i) => {
        parts.push(
          `<text x="${x + v.w / 2}" y="${startY + i * lh}" font-family="Helvetica,Arial,sans-serif" font-size="12" text-anchor="middle" dominant-baseline="middle" fill="${fontColor}"${bold}>${esc(
            ln
          )}</text>`
        );
      });
    }
  }
}

// markers (one per stroke colour used by edges)
const defs = [...markerColors]
  .map(
    (c) =>
      `<marker id="arr-${c.replace("#", "")}" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,4 L0,8 Z" fill="${c}"/></marker>`
  )
  .join("");

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" ` +
  `width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" content="${esc(xml).replace(/"/g, "&quot;")}">\n` +
  `<defs>${defs}</defs>\n` +
  parts.join("\n") +
  `\n</svg>\n`;

writeFileSync(outPath, svg);
console.log(`Wrote ${outPath} (${vertices.length} nodes, ${edges.length} edges, ${W}x${H})`);
