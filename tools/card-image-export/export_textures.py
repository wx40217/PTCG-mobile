#!/usr/bin/env python3
"""Export textures from a Unity asset bundle (read-only, one bundle at a time).

Used only to verify whether the Z: card-image `.asar` package can yield
readable card images. Requires the third-party `UnityPy` package; see
tools/card-image-export/README.md for the pinned version and how to install it
into a throwaway virtualenv that is never committed.

Usage:
    python export_textures.py <bundle> --out <dir> [--json]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys


def export(bundle_path: str, out_dir: str) -> dict:
    import UnityPy  # imported lazily so --help works without the dependency

    env = UnityPy.load(bundle_path)
    os.makedirs(out_dir, exist_ok=True)
    result = {
        "bundle": bundle_path,
        "bundle_bytes": os.path.getsize(bundle_path),
        "bundle_sha256": hashlib.sha256(open(bundle_path, "rb").read()).hexdigest(),
        "objects": [],
        "textures": [],
        "material_manifest": None,
    }
    for obj in env.objects:
        result["objects"].append({"type": obj.type.name, "path_id": obj.path_id})
        if obj.type.name == "MonoBehaviour":
            try:
                tree = obj.read_typetree()
            except Exception:  # unknown script, keep the sample going
                continue
            if tree.get("m_Name") == "MaterialManifest":
                result["material_manifest"] = {
                    "card_id": tree.get("_c"),
                    "weak_texture_id": tree.get("_w"),
                    "foil_type": tree.get("_f"),
                    "asset_path": tree.get("_p"),
                }
        if obj.type.name != "Texture2D":
            continue
        data = obj.read()
        name = getattr(data, "m_Name", "") or f"texture_{obj.path_id}"
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
        target = os.path.join(out_dir, f"{safe}.png")
        with open(target, "wb") as handle:
            handle.write(data.image.save(handle, format="PNG") or b"")
        with open(target, "rb") as handle:
            payload = handle.read()
        result["textures"].append(
            {
                "name": name,
                "path_id": obj.path_id,
                "width": data.m_Width,
                "height": data.m_Height,
                "format": int(getattr(data.m_TextureFormat, "value", data.m_TextureFormat)),
                "png": os.path.basename(target),
                "png_bytes": len(payload),
                "png_sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("--out", required=True)
    parser.add_argument("--json", action="store_true", help="emit a JSON report on stdout")
    args = parser.parse_args()
    report = export(args.bundle, args.out)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        for tex in report["textures"]:
            print(f"{tex['name']}\t{tex['width']}x{tex['height']}\t{tex['png']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
