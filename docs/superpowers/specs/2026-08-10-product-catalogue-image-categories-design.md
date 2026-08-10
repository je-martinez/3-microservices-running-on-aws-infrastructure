---
title: Product Catalogue Enrichment — Image & Categories — Design
type: spec
area: orders
status: active
created: 2026-08-10
updated: 2026-08-10
tags: [type/spec, area/orders, status/active]
related: ["[[orders-service-design]]", "[[db-naming]]", "[[soft-delete]]", "[[env-files]]", "[[testing]]", "[[nano-id]]"]
propagates-to:
  - "[[orders-service-design]]"
  - "[[index]]"
---

# Product Catalogue Enrichment — Image & Categories — Design

## Summary

The Orders product catalogue is seeded with three placeholder rows (`Widget`, `Gadget`,
`Gizmo`) carrying nothing but a name, a description, a price and a stock count. The web-app
design (`assets/web-app/web-app.pen`) shows a real eight-product catalogue where every card
renders a **photograph** and a **category label**.

This spec replaces the placeholder seed with those eight products and adds the two fields the
design needs: an `Image` value object (`uri`, `width`, `height`, `blurhash`) and a `Categories`
string array, both stored as MySQL `json` columns.

**Scope boundary.** This changes the catalogue's *data shape and contents*. It does not add
category filtering, product search, an admin CRUD surface, or a second image per product —
the design shows filter chips, but wiring them is a separate change with its own endpoint
contract.

## Motivation

Three concrete gaps:

1. **No artwork.** A product has no image field at all, so the design's cards cannot be built
   against the real API.
2. **No taxonomy.** The design groups products by category (`FOOTWEAR`, `BAGS`,
   `ACCESSORIES`, `OUTERWEAR`); the entity has no field to hold one.
3. **Placeholder contents.** `Widget`/`Gadget`/`Gizmo` are scaffolding. Every consumer built
   against them — the web app, screenshots, demos — shows fake data.

## Decisions

Each of these was an explicit fork, recorded with its reasoning so a later reader does not
re-open it blind.

### D1 — One image per product, not an array

`Product.Image` is a single nullable `ProductImage`, not a collection. The design shows
exactly one photograph per card, and an array whose second element nothing reads is a shape
maintained for an imagined future (YAGNI). Nullable because a product without artwork is a
legitimate state — the column must not force a placeholder URI.

### D2 — `uri` is a bucket key RELATIVE to the assets base URL

The column stores `products/runner-low-canvas.jpg`, never
`http://localhost:4566/post-3mrai-local-post-assets/products/runner-low-canvas.jpg`.

Floci re-mints the bucket on every apply and `make clean` destroys it, so an absolute URL
persisted in a row is dead data after the next rebuild. Worse, it bakes the bucket name — an
infrastructure detail — into the domain. The API composes the absolute form on read from
`ASSETS_BASE_URL`; when CloudFront eventually fronts the bucket, no row changes.

### D3 — JPEG, not PNG

The eight source images are JPEG photographs (1080px wide, 720–1620px tall). Re-encoding them
as PNG would multiply their weight roughly 5–10× for zero visual gain — PNG's lossless
compression is the wrong tool for photographic content. `sync_assets.py` already handles
`.jpg` natively (quality 85, progressive).

This is a deliberate departure from the original request's `/products/<identifier>.png`.

### D4 — Blurhash is computed by `sync_assets.py`, embedded in the seed

The blurhash is computed from the image bytes, so the image pipeline is the only place that
can compute it correctly. `sync_assets.py` gains a `blurhash` field per raster asset in
`assets.manifest.json`.

The **seed** carries the values as C# constants rather than reading the manifest at runtime.
Reading it would mean mounting `assets/assets.manifest.json` into the Orders container and
adding a boot-time failure mode — for a file that `make bootstrap` does not even guarantee
exists, because it is written by phase 2 (`make post-infra`).

The drift risk this creates is closed by a test (see [Testing](#testing)) that compares the
seed's eight hashes and dimensions against the manifest and fails if they diverge.

### D5 — Replace the three placeholders outright

The catalogue becomes exactly the design's eight products. Keeping `Widget`/`Gadget`/`Gizmo`
alongside them would leave three of eleven rows with `image = NULL`, mixing scaffolding into
what is now real data.

Verified blast radius — the placeholder names appear in 13 places, and only two couple to the
seed:

| Location | Coupling | Action |
| --- | --- | --- |
| `MigrationSeedTests.cs:33` | asserts `Equal(3, Count)` | becomes `8` |
| `ProductEndpointsTests.cs:36`, `OrdersApiFactory.cs:46`, `OrdersE2eApiFactory.cs:70`, `ProductReadServiceTests.cs` | build their **own** `Widget` rows in-test | untouched |
| `e2e/` suite | zero occurrences — reads whatever the catalogue returns | untouched |

`ProductSeed.SeedStock` **keeps its exact public signature**
(`IReadOnlyList<(string Name, uint Units)>`), derived from the new catalogue list, so the E2E
stock-restore in `E2eEndpoints.cs` needs no change.

### D6 — Categories stored UPPERCASE, one per product

Values are `["FOOTWEAR"]`, `["BAGS"]`, `["ACCESSORIES"]`, `["OUTERWEAR"]` — as the design
renders them. The column is an array to allow multi-faceting later, but each product is seeded
with the single category the design assigns it. No invented `FEATURED` membership: the design
has a `Featured` filter chip but assigns it to no specific product.

### D7 — `ASSETS_BASE_URL` for Orders reuses the existing mechanism

`generate_env_files.py` already discovers this value (`discover_assets_base_url`), already
falls back to the derived `http://localhost:4566/post-3mrai-local-post-assets` when phase 2
has no state, and already writes it to `.env.local.events-pipeline`. This change adds one
line to the Orders env-file dict. No new discovery logic, no new fallback constant.

## Data model

### `ProductImage` — new value object

`services/orders/src/Orders.Domain/Entities/ProductImage.cs`

```csharp
/// <summary>Display artwork for a catalogue product.</summary>
/// <param name="Uri">Bucket key RELATIVE to the assets base URL, e.g.
/// "products/runner-low-canvas.jpg". Never absolute — see D2.</param>
/// <param name="Blurhash">BlurHash placeholder (4x3 components) painted while
/// the real image loads.</param>
public record ProductImage(string Uri, int Width, int Height, string Blurhash);
```

A record, not an entity: no `Id`, no table, no audit fields. It is embedded in the `product`
row's `image` column.

### `Product` — two new properties

```csharp
public class Product : AuditableEntity
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public long UnitPriceCents { get; set; }
    public uint UnitsInStock { get; set; }

    /// Display image; null for a product with no artwork yet.
    public ProductImage? Image { get; set; }

    /// Catalogue facets. JSON because MySQL 8 has no array type — same
    /// treatment as Order.Tags.
    public List<string> Categories { get; set; } = [];

    // Computed, not persisted: dollars for display only.
    public decimal UnitPrice => UnitPriceCents / 100m;
}
```

### Persistence — `ProductConfiguration`

Both columns follow the **existing** `Order.Tags` pattern exactly: an explicit
`ValueConverter` plus a `ValueComparer`, not EF's `OwnsOne().ToJson()`.

```csharp
b.Property(p => p.Image)
    .HasColumnName("image")
    .HasColumnType("json")
    .HasConversion(ImageConverter, ImageComparer);   // nullable, no default

b.Property(p => p.Categories)
    .HasColumnName("categories")
    .HasColumnType("json")
    .HasConversion(CategoriesConverter, CategoriesComparer)
    .HasDefaultValue(new List<string>())
    .IsRequired();
```

Three rules this must respect, each learned from existing code in this service:

- **The `ValueComparer` is mandatory.** Without it EF compares `List<string>` (and the record)
  by reference and silently skips the `UPDATE`. `OrderConfiguration.TagsComparer` is the
  template.
- **JSON keys are explicit `[JsonPropertyName]` literals**, snake_case:
  `uri`, `width`, `height`, `blurhash`. Following `ShippingAddressSnapshot`'s reasoning —
  a persisted JSON shape is a contract, and renaming a C# property must not silently rewrite
  it.
- **Deserialization is null-tolerant.** `Categories` maps SQL `NULL`/blank to an empty list,
  never null, because rows written before the column existed read back as `NULL`.

### Migration

`AddProductImageAndCategories` — adds two nullable-safe `json` columns to `product`. Generated
with the documented command (startup project **Infrastructure**, not Api):

```
dotnet ef migrations add AddProductImageAndCategories \
  --project src/Orders.Infrastructure \
  --startup-project src/Orders.Infrastructure \
  --context OrdersWriteDbContext
```

No index on either column. Nothing queries by category yet (D-scope), and adding a generated
column + index for a filter that does not exist is speculative.

## Seed

`ProductSeed` is restructured so each product is defined **once**. Today `SeedStock` holds
names and quantities while `RunAsync` repeats them, cross-referencing by string
(`StockFor("Widget")`) — a shape where a typo produces a runtime exception and a product can
be half-defined.

```csharp
private sealed record SeedProduct(
    string Name,
    string Description,
    long UnitPriceCents,
    uint Units,
    string[] Categories,
    ProductImage Image);
```

`SeedStock` is derived, preserving its signature for `E2eEndpoints`:

```csharp
public static readonly IReadOnlyList<(string Name, uint Units)> SeedStock =
    [.. Catalogue.Select(p => (p.Name, p.Units))];
```

### Catalogue contents

Prices and categories are read from the design; dimensions and blurhashes are computed from
the actual image bytes. Stock is tiered 100/50/25 (preserving the current seed's intent, so a
`409 insufficient_stock` test can exhaust a 25-unit product without placing 100 orders).

| Product | Cents | Stock | Category | W×H | Blurhash |
| --- | --- | --- | --- | --- | --- |
| Runner Low Canvas | 8900 | 100 | FOOTWEAR | 1080×720 | `LWMj?rRjD%of*0j[ofj@Mcfkf6ax` |
| Field Tote 18L | 12800 | 50 | BAGS | 1080×1620 | `LUE.hJ~CR49ENFM_xuxu9aE2o~R+` |
| Trail Shell Jacket | 21500 | 25 | OUTERWEAR | 1080×1437 | `LGC7W+U_57F0^jEzVrrr~pD%I9i^` |
| Everyday Backpack | 14900 | 100 | BAGS | 1080×720 | `L86[5Oxu00M{azoft7ay8{WB?bt7` |
| Linen Cap | 3900 | 50 | ACCESSORIES | 1080×1620 | `LA7KSX55nig3NGxaWVn%0K-pozaK` |
| Wool Runner Mid | 11900 | 25 | FOOTWEAR | 1080×1620 | `LOHVPM_4Mxbcx^V@WBog.8E1RPtR` |
| Leather Card Holder | 5900 | 100 | ACCESSORIES | 1080×721 | `L88NLkngDh^*-on#Rjt80f$*-V9t` |
| Steel Bottle 750ml | 3400 | 50 | ACCESSORIES | 1080×1531 | `LHD96e-BW-%M0Lt7RjIo%fI:Rk$*` |

Image keys are the kebab-cased product name: `products/runner-low-canvas.jpg`, etc.
Descriptions are written to match the existing terse register (e.g. *"Low-profile canvas
sneaker with a rubber cupsole."*) — the design shows none.

The `if (await db.Products.AnyAsync()) return;` guard is unchanged: the seed still only plants
rows into an empty table. **An existing local database keeps its three placeholder rows**;
operators get the new catalogue from a rebuild (`make clean` + `make bootstrap`). This is
called out because it is the one surprising consequence of the change.

## Assets pipeline

1. **Eight files land in `assets/products/*.jpg`**, extracted from the design. They enter
   `sync_assets.py`'s walk automatically — `SKIP_DIRS` only excludes `web-app`.
2. **`RESIZE_TARGETS` gains eight entries at 1080**, their native width. `thumbnail()` never
   upscales, so this is explicitly a no-op today; it exists so a 4000px master dropped in
   later is bounded rather than uploaded whole. Cards render at 300px tall with
   `background-size: cover`.
3. **`sync_assets.py` computes a blurhash** for every optimisable raster and adds it to each
   manifest entry:

   ```json
   "products/runner-low-canvas.jpg": {
     "url": "...", "content_type": "image/jpeg",
     "width": 1080, "height": 720,
     "blurhash": "LWMj?rRjD%of*0j[ofj@Mcfkf6ax",
     "bytes": 59908
   }
   ```

   Non-raster assets (SVG, GIF) get `"blurhash": null` — consistent with how they already
   report `width`/`height` as null rather than guessing.

4. **`blurhash-python` is added to `infra/scripts/pyproject.toml`** runtime dependencies.
   Verified: pure Python, no system libraries, so `make scripts-setup` still needs no
   toolchain. It belongs in runtime (not `[dev]`) because `sync_assets.py` runs inside a
   Terraform `local-exec` during phase 2.

## API surface

`ProductDto` gains both fields; `ProductImageDto` is its wire shape.

```csharp
public record ProductDto(
    string Id, string Name, string Description,
    long UnitPriceCents, uint UnitsInStock,
    IReadOnlyList<string> Categories,
    ProductImageDto? Image);

public record ProductImageDto(string Uri, int Width, int Height, string Blurhash);
```

`ProductReadService` composes the **absolute** URI (D2 stores it relative, the API serves it
resolved) from an injected options value carrying `ASSETS_BASE_URL`:

```csharp
private ProductDto Map(Product p) =>
    new(p.Id, p.Name, p.Description, p.UnitPriceCents, p.UnitsInStock,
        p.Categories,
        p.Image is null ? null
            : new ProductImageDto(
                $"{_assetsBaseUrl}/{p.Image.Uri}",
                p.Image.Width, p.Image.Height, p.Image.Blurhash));
```

Read via `builder.Configuration` with options validation, per this service's config
convention. `GET /v1/products` keeps its route, status codes and auth gating — only the
response body grows, which is additive for existing clients.

`openapi.yaml` MUST be regenerated (`dotnet build`) and committed with the change: the
response shape of `GET /v1/products` changes, which §2a of the service's CLAUDE.md makes a
hard requirement.

## Testing

Per the service's three-layer rule ([[testing]]). No new endpoint is added, so the gateway
layer is a **regression** check on an existing route rather than a new spec.

**Unit / integration**

- `MigrationSeedTests` — `Equal(3, …)` becomes `Equal(8, …)`; extends its per-row assertions
  to require a non-empty `Categories` and a non-null `Image` whose `Uri` starts with
  `products/` and is **not** absolute (the D2 invariant, enforced rather than documented).
- `ProductReadServiceTests` — a product with an image maps to an absolute URI; a product with
  `Image = null` maps to `Image: null` and does not throw.
- **Round-trip test** — write a `Product` with an image and two categories through
  `OrdersWriteDbContext`, read it back through a fresh context, assert equality. This is the
  test that catches a missing `ValueComparer`, which no mocked test can.
- **`ProductSeedManifestTests`** (new) — parses `assets/assets.manifest.json` and asserts the
  seed's eight `(uri, width, height, blurhash)` tuples match it exactly. This is the
  guardrail that makes D4's embedded constants safe. It **skips** (not fails) when the
  manifest has no `products/*` entries, so a fresh clone that has never run
  `make assets-sync` does not fail the suite for an unrelated reason.

**Internal E2E** — `GET /v1/products` against the service URL returns eight products, each
with a non-empty `categories` array and an `image` whose `uri` is absolute and whose
`blurhash` is non-empty.

**Gateway E2E** — the same assertions through `API_GATEWAY_URL` with a real Cognito JWT.
Additionally fetches one `image.uri` and asserts `200` + `Content-Type: image/jpeg`, which is
the only layer that proves the seeded key, the uploaded object and the base URL agree. This
requires `make post-infra` + `make assets-sync`; when the bucket is absent the fetch assertion
is skipped with an explicit message rather than failing the suite.

## Risks and consequences

| Risk | Mitigation |
| --- | --- |
| Seed's embedded blurhashes drift from re-synced images | `ProductSeedManifestTests` fails on divergence |
| Existing local DBs keep the three placeholders | Documented above; `make clean` + `make bootstrap` is the path |
| `make bootstrap` without `make post-infra` yields URIs that 404 | Accepted, pre-existing: `ASSETS_BASE_URL` falls back to the derived value and the catalogue stays functional; only artwork is missing |
| A missing `ValueComparer` silently skips `UPDATE`s | Round-trip test, plus following the `Order.Tags` template |
| `openapi.yaml` left stale | §2a requirement; `dotnet build` regenerates it |

## Out of scope

- Category **filtering** on `GET /v1/products` (no query param, no `JSON_CONTAINS` predicate)
- Product search, admin CRUD, image upload
- Multiple images or responsive variants per product
- A `FEATURED` facet
- CloudFront in front of the assets bucket (the module already documents that seam)

## Related

- [[orders-service-design]]
- [[db-naming]]
- [[soft-delete]]
- [[env-files]]
- [[testing]]
- [[nano-id]]
