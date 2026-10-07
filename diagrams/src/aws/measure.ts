// WHY: Layout runs in Node before any font is loaded, so widths are estimated from Arimo's average advance.
const EM_PER_CHAR = 0.56;
const ELLIPSIS = "…";

export function textWidth(text: string, px: number): number {
  return [...text].length * px * EM_PER_CHAR;
}

function breakWord(word: string, px: number, maxW: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const ch of word) {
    if (cur && textWidth(cur + ch, px) > maxW) { parts.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function ellipsise(line: string, px: number, maxW: number): string {
  let out = line;
  while (out && textWidth(out + ELLIPSIS, px) > maxW) out = out.slice(0, -1);
  return out.trimEnd() + ELLIPSIS;
}

export function wrap(text: string, px: number, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (textWidth(candidate, px) <= maxW) { cur = candidate; continue; }
    if (cur) lines.push(cur);
    const pieces = breakWord(word, px, maxW);
    lines.push(...pieces.slice(0, -1));
    cur = pieces[pieces.length - 1] ?? "";
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsise(`${kept[maxLines - 1]} ${lines[maxLines]}`, px, maxW);
  return kept;
}
