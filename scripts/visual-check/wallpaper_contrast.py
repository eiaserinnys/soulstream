"""사진 배경 위 글 대비와 사진 보임, 사진 아닌 배경의 불변을 캡처 화소로 단언한다(카드 #1911 2차).

wallpaper_contrast.spec.mts가 남긴 캡처(.png)와 글자 상자 좌표(.json)를 읽는다. 글자 상자마다 둘레 띠의 중앙값을 바탕으로,
상자 안에서 바탕과 가장 먼 쪽 3% 분위 화소를 글자색으로 보고 WCAG 대비를 셈한다(계산된 스타일 값이 아니라 화소).
기준은 같은 화면(테마, 유리 경로, 폭, 유리 농도)의 보케 캡처 값이다: 사진 위 글의 대비 >= min(4.5, 보케 값) - 0.5.
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageChops

MARGIN = 0.5
PHOTOS = ["dawn-ridge", "aurora", "silk-curves", "lake-horizon", "desert-dunes", "misty-forest", "moonlit-sea", "milky-way"]
PLAIN_MODES = ("bokeh", "metal", "plain")
# 사진이 가려지는 정도: 사진 모드 덮개(위, 아래)의 알파와 색. 어두운 테마는 기존 덮개 그대로다.
VEIL = {"dark": ((10, 12, 18), 0.28, 0.40), "light": ((244, 245, 248), 0.10, 0.18)}
WEBGL_VEIL = {"dark": ((10, 12, 18), 0.34, 0.34), "light": ((244, 245, 248), 0.10, 0.18)}


def _lin(c: float) -> float:
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def _lum(px) -> float:
    return 0.2126 * _lin(px[0]) + 0.7152 * _lin(px[1]) + 0.0722 * _lin(px[2])


def _ratio(a: float, b: float) -> float:
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def measure(img: Image.Image, box: dict):
    x0, y0 = int(box["x"]), int(box["y"])
    x1, y1 = int(box["x"] + box["w"] + 0.999), int(box["y"] + box["h"] + 0.999)
    width, height = img.size
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
    if x1 - x0 < 3 or y1 - y0 < 3:
        return None
    pixels = img.load()
    inner = sorted(_lum(pixels[x, y]) for y in range(y0, y1) for x in range(x0, x1))
    ring = sorted(_lum(pixels[x, y]) for x in range(max(0, x0 - 3), min(width, x1 + 3)) for y in (max(0, y0 - 3), min(height - 1, y1 + 2)))
    background = ring[len(ring) // 2]
    k = max(1, len(inner) * 3 // 100)
    dark, light = inner[k], inner[-k - 1]
    foreground = dark if abs(dark - background) > abs(light - background) else light
    return _ratio(foreground, background)


def load(folder: Path, name: str) -> dict:
    meta = json.loads((folder / f"{name}.json").read_text())
    img = Image.open(folder / f"{name}.png").convert("RGB")
    values = {}
    for box in meta["boxes"]:
        if box["panel"] == "v3-postit-card":
            continue
        value = measure(img, box)
        if value is not None:
            values[(box["text"], round(box["x"]), round(box["y"]))] = (value, box)
    return {"meta": meta, "img": img, "values": values}


def combo_key(meta: dict) -> tuple:
    combo = meta["combo"]
    return (combo["theme"], combo["glass"], combo["width"], combo.get("tint"))


def names(folder: Path, prefix: str) -> list[str]:
    return sorted(path.stem for path in folder.glob(f"{prefix}*.json") if prefix or not path.stem.startswith("before-"))


def contrast_checks(folder: Path, prefix: str = "") -> list[dict]:
    """사진 캡처마다 기준 캡처(같은 조합의 보케)보다 나쁜 글을 센다."""
    loaded = {name: load(folder, name) for name in names(folder, prefix)}
    refs = {combo_key(item["meta"]): item for item in loaded.values() if item["meta"]["combo"]["wallpaper"] == "bokeh"}
    results = []
    for name, item in loaded.items():
        combo = item["meta"]["combo"]
        if combo["wallpaper"] not in PHOTOS:
            continue
        ref = refs[combo_key(item["meta"])]
        worse = []
        for key, (value, box) in item["values"].items():
            if key in ref["values"]:
                base = ref["values"][key][0]
                if value < min(4.5, base) - MARGIN:
                    worse.append((value, base, box["text"]))
        worse.sort()
        results.append({"name": name, "texts": len(item["values"]), "worse": len(worse), "lowest": worse[0] if worse else None,
                        "webgl": item["meta"].get("webglState")})
    return results


def unchanged_checks(after: Path, before: Path, after_prefix: str = "", before_prefix: str = "before-") -> list[dict]:
    """보케, 메탈, 단색 캡처가 고치기 전 빌드와 같은지 본다(다른 픽셀 50개 이하, 채널 차 8 이하)."""
    results = []
    for name in names(after, after_prefix):
        meta = json.loads((after / f"{name}.json").read_text())
        combo = meta["combo"]
        if combo["wallpaper"] not in PLAIN_MODES or combo["glass"] != "css":
            continue
        other = before / f"{before_prefix}{name[len(after_prefix):]}.png"
        if not other.exists():
            continue
        diff = ImageChops.difference(Image.open(after / f"{name}.png").convert("RGB"), Image.open(other).convert("RGB"))
        changed = [max(px) for px in diff.get_flattened_data() if max(px) > 0] if hasattr(diff, "get_flattened_data") else [max(px) for px in diff.getdata() if max(px) > 0]
        # 같은 화면을 두 번 찍어도 안티앨리어싱과 디더로 몇 픽셀, 채널 4 안팎이 달라진다. 색이 바뀐 것은 이보다 훨씬 많고 크다.
        results.append({"name": name, "identical": len(changed) <= 50 and max(changed, default=0) <= 8, "changed_pixels": len(changed), "max_delta": max(changed, default=0)})
    return results


def _cover(image: Image.Image, width: int, height: int) -> Image.Image:
    scale = max(width / image.width, height / image.height)
    resized = image.resize((max(width, round(image.width * scale)), max(height, round(image.height * scale))))
    left, top = (resized.width - width) // 2, (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height))


def photo_visibility(folder: Path, wallpapers: Path, prefix: str = "") -> list[dict]:
    """패널 밖(사이와 바깥 여백)의 화소가 덮개를 씌운 사진과 같은 모양인지 본다. 패널과 겹치지 않는 열이 없으면 건너뛴다."""
    results = []
    for name in names(folder, prefix):
        item = load(folder, name)
        combo = item["meta"]["combo"]
        if combo["wallpaper"] not in PHOTOS:
            continue
        img = item["img"]
        width, height = img.size
        panels = item["meta"]["panels"]
        free = [x for x in range(width) if not any(p["x"] - 1 <= x <= p["x"] + p["w"] + 1 and p["y"] < 800 and p["y"] + p["h"] > 100 for p in panels)]
        if len(free) < 6:
            results.append({"name": name, "skipped": True})
            continue
        photo = _cover(Image.open(wallpapers / f"{combo['wallpaper']}.webp").convert("RGB"), width, height)
        color, top_alpha, bottom_alpha = (WEBGL_VEIL if combo["glass"] == "webgl" else VEIL)[combo["theme"]]
        errors = []
        for y in range(100, 800, 7):
            alpha = top_alpha + (bottom_alpha - top_alpha) * y / height
            for x in free[:: max(1, len(free) // 40)]:
                got, base = img.getpixel((x, y)), photo.getpixel((x, y))
                expect = tuple(base[i] * (1 - alpha) + color[i] * alpha for i in range(3))
                errors.append(sum(abs(got[i] - expect[i]) for i in range(3)) / 3)
        results.append({"name": name, "skipped": False, "columns": len(free), "mean_error": sum(errors) / len(errors)})
    return results
