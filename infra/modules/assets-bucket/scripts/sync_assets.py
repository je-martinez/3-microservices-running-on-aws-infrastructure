#!/usr/bin/env python
"""Optimise the images under assets/ and upload them to the assets bucket.

Two entry points, both landing here:
  - `make assets-sync` — the day-to-day one. Re-uploads without touching
    infrastructure, against an already-running stack.
  - the post-effects root (environments/local/post/assets.tf), so a freshly
    provisioned environment has its assets in place without a second command.

Idempotent by construction: every step (resize, put_object, manifest write) is a
full overwrite of a deterministic output, so running it twice leaves exactly the
same bucket and the same manifest. There is no "already uploaded" bookkeeping to
get out of sync — re-running is the repair mechanism.

Output is a manifest JSON in assets/ mapping each logical asset name to its
public URL plus the dimensions, so a consumer (the email templates, later) reads
a URL instead of reconstructing one from a bucket name and an endpoint style.

WHY NO WEBP. Deliberately not generated, and this comment is here so nobody adds
it later "for performance". WebP is not usable in email: Outlook on Windows (the
Word rendering engine) and Apple Mail do not support it, and Gmail converts it
to JPG on the way through. It would be a third variant to generate, upload and
keep in the manifest, whose only readers are clients that render the PNG just as
well. The saving is real on the web and zero here.

SVG passes through untouched: the ones in this repo are already smaller than the
raster derivatives, and a minifier would add a dependency to shave bytes off a
file that is not the problem. GIF likewise — re-encoding animation frames is a
different job from resizing a still.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image

from lib3mrai import aws
from lib3mrai.console import inf, no, ok
from lib3mrai.execution_log import record_execution

SCRIPT_NAME = "sync_assets.py"

# Extensions we consider an image at all. Any format, not just png — the walk
# below must not silently ignore a jpg someone drops into assets/img/.
CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",  # served if one already exists; never generated
}

# Only these are re-encoded. GIF (animation) and SVG (vector) pass through, and
# an existing WebP is uploaded as found.
OPTIMISABLE = {".png", ".jpg", ".jpeg"}

# Objects are content-addressed by nothing and overwritten in place, so a long
# max-age would pin a stale logo in an email client's cache. One year is still
# the right value: these are display masters that change on a human timescale,
# the manifest is regenerated whenever they do, and email clients cache
# aggressively regardless of what we send. `immutable` is deliberately omitted —
# it forbids revalidation entirely, which we would regret on a logo swap.
CACHE_CONTROL = "public, max-age=31536000"

# Per-asset resize targets, keyed by the path relative to assets/.
#
# Both logos are 1000px+ display masters (1254x1254 and 1024x1024). The email
# header renders the mark at 42x42 CSS px and the footer at 32x32 (see
# assets/email/DESIGN.md), so 168px is 4x the largest use — beyond any retina
# density an email client will ask for, and still an order of magnitude smaller
# than the master. Anything not listed here is uploaded at its original size.
RESIZE_TARGETS = {
    "img/standalone-logo.png": 168,
    "img/logo.png": 168,
}

# Files under assets/ that are not web assets: design sources and shader
# snippets live beside the images but must never reach a public bucket.
SKIP_DIRS = {"web-app"}


@dataclass
class SyncedAsset:
    """One uploaded object, as recorded in the manifest."""

    key: str  # logical name, e.g. "img/standalone-logo.png"
    url: str
    width: int | None
    height: int | None
    content_type: str
    bytes_before: int
    bytes_after: int


def _repo_root() -> Path:
    """Repo root, derived from this file's location.

    modules/assets-bucket/scripts/sync_assets.py -> up four levels is infra/'s
    parent. Derived rather than taken from cwd because local-exec runs the
    script from the calling root's directory, not from here.
    """
    return Path(__file__).resolve().parents[4]


def _iter_images(assets_dir: Path):
    """Every image under assets/, at any depth, of any supported format."""
    for path in sorted(assets_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(assets_dir)
        if rel.parts and rel.parts[0] in SKIP_DIRS:
            continue
        if path.suffix.lower() in CONTENT_TYPES:
            yield path, rel.as_posix()


def _optimise(path: Path, key: str) -> tuple[bytes, int | None, int | None]:
    """Return (body, width, height) for one asset.

    Non-raster formats (SVG, GIF) and anything Pillow cannot read are returned
    byte-for-byte, with no dimensions claimed rather than guessed.
    """
    raw = path.read_bytes()
    suffix = path.suffix.lower()

    if suffix not in OPTIMISABLE:
        return raw, None, None

    with Image.open(BytesIO(raw)) as img:
        img.load()
        target = RESIZE_TARGETS.get(key)
        if target and max(img.size) > target:
            # thumbnail() preserves the aspect ratio and never upscales, so a
            # master smaller than the target is left alone instead of being
            # blown up into a blurry copy.
            img.thumbnail((target, target), Image.LANCZOS)

        buf = BytesIO()
        if suffix == ".png":
            # PNG re-encode is lossless; optimize=True runs the extra filter
            # search. The palette is left alone — quantising a logo with a soft
            # edge to 256 colours is where visible banding comes from.
            img.save(buf, format="PNG", optimize=True)
        else:
            # 85 is the usual quality/size knee for photographic content;
            # progressive helps a slow connection paint something early.
            img.convert("RGB").save(
                buf, format="JPEG", quality=85, optimize=True, progressive=True
            )
        return buf.getvalue(), img.size[0], img.size[1]


def sync(bucket: str, base_url: str, assets_dir: Path, manifest_path: Path) -> int:
    s3 = aws.client("s3")
    synced: list[SyncedAsset] = []

    for path, key in _iter_images(assets_dir):
        before = path.stat().st_size
        body, width, height = _optimise(path, key)
        content_type = CONTENT_TYPES[path.suffix.lower()]

        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType=content_type,
            CacheControl=CACHE_CONTROL,
        )

        synced.append(
            SyncedAsset(
                key=key,
                url=f"{base_url.rstrip('/')}/{key}",
                width=width,
                height=height,
                content_type=content_type,
                bytes_before=before,
                bytes_after=len(body),
            )
        )
        pct = (1 - len(body) / before) * 100 if before else 0.0
        ok(f"{key}: {before:,} -> {len(body):,} bytes ({pct:.1f}% smaller)")

    if not synced:
        no(f"no images found under {assets_dir}")
        return 1

    manifest = {
        # Written so a consumer never has to guess: what the asset is, where to
        # fetch it, and how big it is (email templates must set width/height
        # attributes explicitly — Outlook does not honour CSS sizing on images).
        "bucket": bucket,
        "base_url": base_url.rstrip("/"),
        "assets": {
            a.key: {
                "url": a.url,
                "content_type": a.content_type,
                "width": a.width,
                "height": a.height,
                "bytes": a.bytes_after,
            }
            for a in synced
        },
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    inf(f"manifest written to {manifest_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bucket",
        default=os.environ.get("ASSETS_BUCKET"),
        help="Target bucket. Defaults to $ASSETS_BUCKET.",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("ASSETS_BASE_URL"),
        help=(
            "Public base URL an object key is appended to. Defaults to "
            "$ASSETS_BASE_URL. This is the module's public_base_url output; "
            "when CloudFront eventually fronts the bucket, this becomes the "
            "distribution domain and nothing else here changes."
        ),
    )
    args = parser.parse_args()

    if not args.bucket or not args.base_url:
        no("--bucket/$ASSETS_BUCKET and --base-url/$ASSETS_BASE_URL are required")
        return 2

    root = _repo_root()
    assets_dir = root / "assets"
    if not assets_dir.is_dir():
        no(f"assets directory not found: {assets_dir}")
        return 1

    # Traceability only — never a skip. Same contract as every other
    # awscli-fallback script (see lib3mrai/execution_log.py).
    with record_execution(SCRIPT_NAME, args.bucket):
        return sync(
            args.bucket, args.base_url, assets_dir, assets_dir / "assets.manifest.json"
        )


if __name__ == "__main__":
    sys.exit(main())
