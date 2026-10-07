"""Fetch the official AWS Architecture Icons package and extract the group/generic icons diagrams use."""
from __future__ import annotations

import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

PAGE = "https://aws.amazon.com/architecture/icons/"
OUT = Path(__file__).resolve().parent.parent / "public" / "aws-icons"

GROUP = {
    "aws-cloud": "AWS-Cloud-logo_32.svg",
    "region": "Region_32.svg",
    "vpc": "Virtual-private-cloud-VPC_32.svg",
    "public-subnet": "Public-subnet_32.svg",
    "private-subnet": "Private-subnet_32.svg",
    "account": "AWS-Account_32.svg",
    "corporate": "Corporate-data-center_32.svg",
    "server": "Server-contents_32.svg",
}
GENERIC = {
    "users": "Res_Users_48_Light.svg",
    "client": "Res_Client_48_Light.svg",
    "internet": "Res_Internet_48_Light.svg",
    "server": "Res_Server_48_Light.svg",
    "office-building": "Res_Office-building_48_Light.svg",
    "firewall": "Res_Firewall_48_Light.svg",
    "data-table": "Res_Data-Table_48_Light.svg",
}


def find_package_url(html: str) -> str:
    match = re.search(r"https://[^\"' ]*Icon-package_[^\"' ]*\.zip", html)
    if not match:
        raise SystemExit(f"no Icon-package zip link found on {PAGE}")
    return match.group(0)


def select(names: list[str], group: dict[str, str], generic: dict[str, str]) -> dict[tuple[str, str], str]:
    usable = [n for n in names if not n.startswith("__MACOSX/")]
    picked: dict[tuple[str, str], str] = {}
    for kind, wanted in (("group", group), ("generic", generic)):
        for key, filename in wanted.items():
            hits = [n for n in usable if n.endswith("/" + filename)]
            if not hits:
                raise SystemExit(f"icon {kind}/{key} ({filename}) not found in the package")
            picked[(kind, key)] = hits[0]
    return picked


def main() -> None:
    request = urllib.request.Request(PAGE, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(request, timeout=60).read().decode("utf-8", "replace")
    url = find_package_url(html)
    archive = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url, timeout=300).read()))
    picked = select(archive.namelist(), GROUP, GENERIC)
    manifest: dict[str, object] = {"package": url.rsplit("/", 1)[-1], "fetched": date.today().isoformat(), "group": {}, "generic": {}}
    for (kind, key), member in picked.items():
        target = OUT / kind / f"{key}.svg"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.read(member))
        manifest[kind][key] = f"{kind}/{key}.svg"  # type: ignore[index]
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(picked)} icons from {manifest['package']}")


if __name__ == "__main__":
    sys.exit(main())
