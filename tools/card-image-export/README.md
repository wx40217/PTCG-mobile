# card-image-export

Turns a Unity asset bundle extracted from a card-image `.asar` pack into a PNG
card face, and (with `screen_evidence.mjs`) OCR-screens a bounded list of
entries so their visible script and printed number can be recorded.

`UnityPy` is required but is **not** a repository dependency: it is installed
into a throwaway virtualenv that is never committed.

```powershell
py -m venv .scratch/venv
./.scratch/venv/Scripts/python.exe -m pip install UnityPy==1.25.3
$env:UNITYPY_PYTHON = ".scratch/venv/Scripts/python.exe"   # used by screen_evidence.mjs
```

Usage:

```powershell
# one bundle -> PNG report
./.scratch/venv/Scripts/python.exe tools/card-image-export/export_textures.py <bundle> --out <dir> --json

# bounded screen over explicit asar entries (extract + decode + OCR + classify)
node tools/card-image-export/screen_evidence.mjs --asar <pack.asar> --work .scratch `
  --entry files/sv1_en_001 --entry files/sm10_en_001
```

OCR uses the OCR engine bundled with Windows through
`tools/ocr/ocr-windows.ps1`, so no additional install is needed.

Findings produced with these tools (mixed Traditional/Simplified/English card
faces, id numbering versus printed numbering) are recorded in
`data/evidence/asar-2025060501-sample.json` and
`docs/data/frozen-environment-and-resources.md`.
