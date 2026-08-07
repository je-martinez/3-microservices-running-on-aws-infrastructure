# `assets-bucket`

S3 bucket for public image assets — today the email-template logos, tomorrow
anything a rendered document must fetch over plain HTTP.

Email clients will not reliably render a `data:` URI (Outlook and Gmail strip or
refuse them at size), and base64-inlining a 1.4 MB master into every message is
worse. The templates need a real URL, which is what this module plus
`scripts/sync_assets.py` produce.

## Local vs production — expressed, not hidden

| | local (Floci) | production |
|---|---|---|
| `public_read` | `true` (explicit opt-in) | `false` (the default) |
| how it is served | bucket read directly, anonymously | CloudFront + OAC in front of a private bucket |
| `endpoint_url` | `http://localhost:4566` (path-style) | `null` → virtual-host S3 domain |

`public_read` **defaults to the safe value**. The production intent is a private
bucket behind CloudFront with an Origin Access Control, so a future prod wiring
is purely *additive* — it adds the distribution and never has to first undo a
public default that a new environment would otherwise inherit silently.

### Why local cannot use CloudFront

Floci does not emulate CloudFront's data plane at all. `create-distribution`
succeeds, returns a real Id/ARN/`DomainName` and reports `Status: "Deployed"` —
but the `<id>.cloudfront.net` domain resolves to nothing and serves nothing
(`curl` → HTTP `000`), and unlike API Gateway's `/restapis/<id>/...` there is no
local invoke URL to point a template at. [Floci's own
docs](https://floci.io/floci/services/cloudfront/) say it outright: *"Actual
content delivery is not emulated — this is a management-plane-only
implementation."* Terraform apply state alone will not tell you a CDN-fronted
asset is unreachable; only curling the domain does.

So locally, direct public bucket access is the only option that yields a
fetchable URL.

### Verified: Floci does not enforce S3 object auth at all

Probed 2026-08-07 rather than assumed. Floci **accepts** `put-bucket-policy`
with `Principal: "*"` and `put-public-access-block`, and `get-bucket-policy`
reads the policy back intact — but a bucket with **no policy whatsoever** also
answers an anonymous `GET` with `200`. The policy is therefore cosmetic locally:
what makes the object fetchable is Floci not checking, not the grant.

It is still the right thing to declare, because this module is not local-only —
against real S3 the policy is exactly what makes the object public, and the
`depends_on` ordering (relax the public-access block *before* attaching the
policy) is what real S3 requires, since it rejects an anonymous-access policy
while `BlockPublicPolicy` is on. Nothing here relies on the local leniency.

## What is deliberately absent

- **No versioning / encryption / lifecycle rules.** Same minimal posture as
  `modules/tf-backend`. These objects are derived artifacts regenerable from
  `assets/` in one command, so versioning would only accumulate copies of files
  already in git.
- **No CloudFront distribution.** Out of scope and unvalidatable locally — see
  above. `bucket_regional_domain_name` is exported as the seam for it.
- **No WebP variant** (in the sync script). Outlook Windows and Apple Mail do
  not support it and Gmail converts it to JPG; it would be a variant to maintain
  with no benefit in email.

## Usage

```hcl
module "assets_bucket" {
  source = "../../../modules/assets-bucket"

  context      = { id = module.label.id, tags = module.label.tags }
  public_read  = true                      # local only
  endpoint_url = "http://localhost:4566"   # local only
}
```

Then upload with `scripts/sync_assets.py`, which walks `assets/`, resizes the
raster masters, uploads with the right `Content-Type` and a long `Cache-Control`,
and writes `assets/assets.manifest.json` (gitignored — see
`assets/assets.manifest.example.json` for the shape).

Two entry points:

- `make assets-sync` — the day-to-day one. No plan, no apply; safe against a
  running stack and safely re-runnable.
- `infra/environments/local/post/assets.tf` — the post-effects wiring, so a
  freshly provisioned environment already has its assets.

## Related

- [`../../environments/local/post/assets.tf`](../../environments/local/post/assets.tf)
- [`../../../docs/lessons/floci-vs-ministack-spike-findings.md`](../../../docs/lessons/floci-vs-ministack-spike-findings.md)
- [`../../../docs/shared/decisions/ADR-0001-terraform-cloudposse-naming.md`](../../../docs/shared/decisions/ADR-0001-terraform-cloudposse-naming.md)
