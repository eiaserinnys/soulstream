#!/usr/bin/env python3
"""운영 빌드와 시안 묶음을 찍은 PNG 쌍(NN-real.png, NN-mock.png)을 화소 단위로 견준다.

사용: python3 compare-captures.py <캡처 폴더> [--sheet N]
폴더마다 다른 화소 수와 그 범위를 적고, --sheet 로 고른 단계는 나란히 붙인 그림을 만든다.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops


def compare(real: Path, mock: Path):
    a, b = Image.open(real).convert("RGB"), Image.open(mock).convert("RGB")
    if a.size != b.size:
        return {"size": [a.size, b.size], "different": None}
    diff = np.asarray(ImageChops.difference(a, b)).max(axis=2)
    changed = int((diff > 0).sum())
    box = ImageChops.difference(a, b).getbbox()
    return {"different": changed, "total": int(diff.size), "box": box}


def sheet(real: Path, mock: Path, out: Path):
    a, b = Image.open(real).convert("RGB"), Image.open(mock).convert("RGB")
    gap = 24
    canvas = Image.new("RGB", (a.width + b.width + gap, max(a.height, b.height)), (128, 128, 128))
    canvas.paste(a, (0, 0))
    canvas.paste(b, (a.width + gap, 0))
    canvas.save(out)


def layout(folder: Path):
    """견본별로 보이는 요소의 자리, 크기, 글자 모양이 같은지 본다. 클래스 이름은 견주지 않는다."""
    def visible(parts):
        rows = []
        for part in parts:
            name, x, y, w, h, *style = part.split("|")
            if w == "0" and h == "0":
                continue
            rows.append("|".join([name.split(".")[0], x, y, w, h, *style]))
        return rows
    real = json.loads((folder / "layout-real.json").read_text(encoding="utf-8"))
    mock = json.loads((folder / "layout-mock.json").read_text(encoding="utf-8"))
    return [a["label"] for a, b in zip(real, mock) if visible(a["parts"]) != visible(b["parts"])]


def main():
    root = Path(sys.argv[1])
    sheets = {int(sys.argv[i + 1]) for i, arg in enumerate(sys.argv) if arg == "--sheet"}
    report = {}
    for folder in sorted(p for p in root.iterdir() if (p / "summary.json").exists()):
        rows = []
        for real in sorted(folder.glob("*-real.png")):
            step = int(real.name.split("-")[0])
            mock = real.with_name(real.name.replace("-real", "-mock"))
            rows.append({"step": step, **compare(real, mock)})
            if step in sheets:
                sheet(real, mock, folder / f"{step:02d}-side-by-side.png")
        summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
        report[folder.name] = {
            "scrollHeight": summary["scrollHeight"], "samples": summary["samples"],
            "layoutDifferent": layout(folder) if (folder / "layout-real.json").exists() else None,
            "identical": sum(1 for r in rows if r["different"] == 0), "steps": len(rows),
            "different": [r for r in rows if r["different"] != 0],
        }
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
