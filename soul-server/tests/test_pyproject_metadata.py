"""pyproject.toml 메타데이터 invariant — Pillow base deps 승격 회귀 차단.

caller-info v1(PR #10) 머지로 portrait_utils가 PIL을 실사용하게 되었으나
운영 venv에 Pillow가 미설치되는 결함이 있었다 (imaging extras로만 정의되었던
탓에 sentinel/haniel의 `pip install -e .` 동기화에서 누락).

본 모듈은 다음을 invariant로 보호한다.

1. `Pillow`는 `[project.dependencies]`에 있어야 한다 — 운영 sync flow가 base
   install이므로 base에 있어야 자동 적재된다.
2. `imaging` extras 그룹은 부재해야 한다 — Pillow가 base와 extras 양쪽에
   동시 존재하면 design-principles §3 (정본 하나)를 위배한다.

이 테스트는 stdlib(tomllib + pathlib)만 사용하므로 어떤 venv·extras 조합에서도
동작한다.
"""
from __future__ import annotations

import tomllib
from pathlib import Path

_PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _load_pyproject() -> dict:
    with open(_PYPROJECT, "rb") as fp:
        return tomllib.load(fp)


def _has_pillow(specs: list[str]) -> bool:
    """`Pillow>=10.0.0` 같은 PEP 508 식에서 distribution 이름이 Pillow인지 확인."""
    for spec in specs:
        # distribution 이름은 첫 번째 비교/extras/공백 토큰 이전까지
        head = spec.split(";")[0]  # marker 분리
        for sep in ("==", ">=", "<=", "~=", "!=", ">", "<", "[", " ", "@"):
            head = head.split(sep)[0]
        name = head.strip().lower()
        if name == "pillow":
            return True
    return False


def test_pillow_in_base_dependencies() -> None:
    """Pillow는 `[project.dependencies]`에 있어야 한다.

    portrait_utils.load_and_resize_portrait가 PIL.Image를 실사용한다.
    운영 sync flow(sentinel `pip install -e .`, haniel `post_pull` hook)가
    extras 미지정 install이므로 base에 있어야 자동 적재된다.
    """
    toml = _load_pyproject()
    deps = toml["project"]["dependencies"]
    assert _has_pillow(deps), (
        "Pillow must be declared in [project.dependencies] (not optional). "
        f"Current dependencies: {deps}"
    )


def test_imaging_extras_group_absent() -> None:
    """`imaging` extras 그룹은 base 승격 후 제거되어야 한다.

    base와 extras 양쪽에 Pillow를 두면 정본이 둘이 되어 design-principles §3
    위배. extras 그룹이 Pillow 단일 항목이었으므로 그룹 자체를 제거한다.
    누군가 extras로 되돌리는 회귀를 본 테스트가 차단한다.
    """
    toml = _load_pyproject()
    extras = toml["project"].get("optional-dependencies", {})
    assert "imaging" not in extras, (
        "[project.optional-dependencies].imaging group must be removed after "
        "base promotion (Pillow lives in base deps). "
        f"Current extras keys: {sorted(extras.keys())}"
    )
