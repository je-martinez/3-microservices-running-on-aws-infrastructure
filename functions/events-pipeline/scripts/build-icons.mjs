// Rasterises the Lucide icons the email templates need into base64 PNG data
// URIs, and writes them as a generated TS module (`emails/icons.generated.ts`).
//
// WHY THIS SCRIPT EXISTS AT ALL — the three roads that do NOT work in email:
//   - Icon FONTS need an @font-face rule, which lives in a <style> block. Gmail,
//     Outlook on Windows and most webmail strip <style> outright, so the glyph
//     never resolves and the reader gets a tofu box.
//   - INLINE SVG has 40.48% client support (caniemail.com/features/html-svg) and
//     Outlook on Windows does not render it in ANY version — it goes through
//     Word's HTML engine, which has no SVG support at all.
//   - A REMOTE <img> is blocked by default in many clients and adds an external
//     request that leaks an open-tracking signal.
//
// WHY BASE64 IS THE ONE THAT DOES: `data:` URI images have 80.95% support
// (caniemail.com/features/image-base64) and work in BOTH Gmail (since its 2020
// change) and Outlook on Windows. The known hole is base64 **GIF** in Outlook
// Windows — which is why this script emits **PNG** and nothing else.
//
// AND WHY THE COLOURED CIRCLES STAY: ~20% of recipients still see nothing where
// the <img> is. Every icon in the templates therefore sits INSIDE the coloured
// circle/badge it already had, and every <Img> carries a meaningful `alt`. With
// the image missing the email must still read as deliberate, not broken.
//
// 2x RASTERISATION: each PNG is rendered at twice its display size and then
// constrained by the <Img> width/height attributes, so it stays sharp on retina
// / HiDPI displays instead of looking soft. The cost is small — the whole set is
// under 9 KB of base64 (see the per-icon report this script prints).
//
// COLOURS: read from `emails/theme.ts` wherever the design tokenizes them. Only
// the genuinely untokenized values (the security-notice amber `#F59E0B`, and
// plain white for icons that sit on a filled CTA) are literals here — the same
// treatment the templates give those one-off `.pen` tints.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../", import.meta.url);

// The theme is a plain TS module of string literals with no imports, so it is
// read as TEXT and its hexes extracted, rather than imported. Importing it would
// force this build step to depend on a TS loader (tsx/strip-types) before
// esbuild has run — a bootstrapping problem for a script whose whole job is to
// produce an input to that build.
const themeSource = await readFile(new URL("emails/theme.ts", root), "utf8");

function themeColor(token) {
  const match = themeSource.match(new RegExp(`\\b${token}:\\s*"(#[0-9A-Fa-f]{6})"`));
  if (!match) {
    // Loud, not silent: a renamed token must fail the build here rather than
    // quietly emitting icons in the wrong colour, which nothing downstream
    // checks.
    throw new Error(`token "${token}" not found in emails/theme.ts`);
  }
  return match[1];
}

// Not in `theme.ts` on purpose. `#F59E0B` is a contextual one-off in the `.pen`
// (the OTP security-notice amber, see assets/email/DESIGN.md "Colours —
// Contextual"), and white is not a brand token but the only legible fill for an
// icon sitting on a filled CTA button.
const NOTICE_AMBER = "#F59E0B";
const ON_ACCENT_WHITE = "#FFFFFF";

// name = the lucide-static file, `export` = the constant name in the generated
// module, `size` = the DISPLAY size in CSS px (the PNG is rendered at 2x it).
const ICONS = [
  { name: "user-check", export: "userCheck", color: themeColor("brandOrange"), size: 28 },
  { name: "package-check", export: "packageCheck", color: themeColor("successGreen"), size: 28 },
  { name: "package-search", export: "packageSearch", color: ON_ACCENT_WHITE, size: 16 },
  { name: "map-pin", export: "mapPin", color: themeColor("infoBlue"), size: 28 },
  { name: "check", export: "check", color: ON_ACCENT_WHITE, size: 13 },
  { name: "external-link", export: "externalLink", color: ON_ACCENT_WHITE, size: 16 },
  { name: "log-in", export: "logIn", color: themeColor("infoBlue"), size: 28 },
  { name: "triangle-alert", export: "triangleAlert", color: NOTICE_AMBER, size: 13 },
];

async function rasterise({ name, color, size }) {
  const source = await readFile(new URL(`node_modules/lucide-static/icons/${name}.svg`, root), "utf8");

  // Lucide ships every icon with `stroke="currentColor"`, which resolves against
  // a CSS colour that does not exist once the SVG is rasterised outside a
  // document. Substituting the concrete hex BEFORE handing the markup to sharp
  // is what makes the icon come out coloured instead of black.
  const colored = source.replaceAll("currentColor", color);

  const pixels = size * 2;
  // Lucide's viewBox is 24x24 and librsvg rasterises at `density` DPI against a
  // 72-DPI baseline, so this density is what makes the vector render at the
  // target pixel size instead of being upscaled from 24px and going blurry.
  const png = await sharp(Buffer.from(colored), { density: (pixels / 24) * 72 })
    .resize(pixels, pixels)
    .png({ compressionLevel: 9 })
    .toBuffer();

  return png.toString("base64");
}

const entries = [];
for (const icon of ICONS) {
  const base64 = await rasterise(icon);
  entries.push({ ...icon, base64 });
  console.log(
    `  ${icon.name.padEnd(16)} ${String(icon.size * 2).padStart(3)}px  ${String(
      base64.length,
    ).padStart(6)} base64 chars`,
  );
}

const totalChars = entries.reduce((sum, entry) => sum + entry.base64.length, 0);

const module = `// GENERATED FILE — DO NOT EDIT. Produced by \`scripts/build-icons.mjs\`,
// which runs as part of \`pnpm run build\` (and can be run alone via
// \`pnpm run build:icons\`). It is COMMITTED deliberately: \`emails/*.tsx\`
// import it, so \`tsc --noEmit\`, \`vitest\` and \`email dev\` all need it to
// exist WITHOUT a build step having run first.
//
// Each constant is a base64 PNG \`data:\` URI of a Lucide icon, recoloured to the
// template's accent and rasterised at 2x its display size for retina.
//
// WHY base64 AND NOT an icon font / inline SVG / a remote URL:
//   - icon fonts need @font-face, i.e. a <style> block, which Gmail and Outlook
//     strip;
//   - inline SVG has 40.48% support (caniemail.com/features/html-svg) and
//     Outlook on Windows renders it in NO version;
//   - a remote <img> is blocked by default in many clients.
// base64 \`data:\` URIs have 80.95% support (caniemail.com/features/image-base64)
// and work in both Gmail and Outlook on Windows. PNG specifically: Outlook
// Windows does not render base64 GIF.
//
// ~20% of recipients still see no image, so every icon stays INSIDE its coloured
// circle/badge and every <Img> carries a meaningful \`alt\`. The email must look
// deliberate with zero images loaded.
//
// Total payload of this module: ${totalChars} base64 characters (~${(totalChars / 1024).toFixed(1)} KB),
// well under Gmail's ~102 KB clipping threshold even when several icons repeat
// in one message.

${entries
  .map(
    (entry) =>
      `// \`${entry.name}\` — ${entry.color}, ${entry.size}px displayed (${
        entry.size * 2
      }px raster).\nexport const ${entry.export} = "data:image/png;base64,${entry.base64}";`,
  )
  .join("\n\n")}
`;

const outPath = new URL("emails/icons.generated.ts", root);
await writeFile(outPath, module, "utf8");

console.log(
  `built ${fileURLToPath(outPath).replace(fileURLToPath(root), "")} — ${entries.length} icons, ${totalChars} base64 chars`,
);
