import type { Product } from "./api-types";

const PLACEHOLDER_IMAGE_URI =
  "http://localhost:4566/post-3mrai-local-post-assets/web-app/placeholder-product.png";

/**
 * Product ids use the `prd_` nano-id prefix, as the Orders service does.
 *
 * Deliberate edge-state coverage for layout (see task-4b-brief.md):
 *   - prd_hQ3nWbT8xL has `image: null`             (no-image card state)
 *   - prd_pR9kLmZ2vN has `unitsInStock: 0`          (out-of-stock state)
 *   - prd_tY6cQoE1sF has `unitPriceCents: "12900"`  (string, exercises IntLike)
 *   - prd_wK4jNpX7bH has three categories           (chip overflow)
 */
export const PRODUCTS: readonly Product[] = [
  {
    id: "prd_V1StGXR8Z5",
    name: "Aurora Desk Lamp",
    description: "Warm-dimming LED desk lamp with a matte aluminium arm.",
    unitPriceCents: 8900,
    unitsInStock: 42,
    categories: ["lighting", "office"],
    image: {
      uri: PLACEHOLDER_IMAGE_URI,
      width: 640,
      height: 640,
      blurhash: "LkQ0aQof00ofoffQayfQ00ayD%ay",
    },
  },
  {
    id: "prd_bN8dJfR3mQ",
    name: "Kestrel Mechanical Keyboard",
    description: "Hot-swappable 75% keyboard with tactile brown switches.",
    unitPriceCents: 14900,
    unitsInStock: 17,
    categories: ["peripherals", "office"],
    image: {
      uri: PLACEHOLDER_IMAGE_URI,
      width: 640,
      height: 480,
      blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
    },
  },
  {
    id: "prd_hQ3nWbT8xL",
    name: "Basalt Ceramic Mug",
    description: "Hand-thrown 350ml mug, unglazed base, satin-black finish.",
    unitPriceCents: 2400,
    unitsInStock: 130,
    categories: ["kitchen"],
    // Design's no-image card state.
    image: null,
  },
  {
    id: "prd_pR9kLmZ2vN",
    name: "Solstice Wool Throw",
    description: "Lambswool throw blanket, herringbone weave, 130x180cm.",
    unitPriceCents: 12500,
    // Out-of-stock state.
    unitsInStock: 0,
    categories: ["home"],
    image: {
      uri: PLACEHOLDER_IMAGE_URI,
      width: 800,
      height: 600,
      blurhash: "L9Cs4-of00of~qofRjay00ayIUay",
    },
  },
  {
    id: "prd_tY6cQoE1sF",
    name: "Meridian Backpack",
    description: "22L weatherproof daypack with a padded 15-inch laptop sleeve.",
    // String form, proving IntLike is used (not just declared) on this field.
    unitPriceCents: "12900",
    unitsInStock: 58,
    categories: ["bags", "travel"],
    image: {
      uri: PLACEHOLDER_IMAGE_URI,
      width: 640,
      height: 640,
      blurhash: "L5H2EC=PM{9F00%M~q9F00Rj-;bH",
    },
  },
  {
    id: "prd_wK4jNpX7bH",
    name: "Ember Cast-Iron Skillet",
    description: "Pre-seasoned 10-inch skillet, oven-safe to 260C.",
    unitPriceCents: 5600,
    unitsInStock: 76,
    // Three categories: exercises chip-overflow layout.
    categories: ["kitchen", "cookware", "home"],
    image: {
      uri: PLACEHOLDER_IMAGE_URI,
      width: 640,
      height: 640,
      blurhash: "L3A^V?%M9F9F00Rj~qM{00xu%MRj",
    },
  },
];
