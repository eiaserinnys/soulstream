"""
MetadataExtractor - YAML 규칙 기반 세션 메타데이터 추출

tool_result 이벤트의 tool_name과 result를 YAML 규칙에 매칭하여
구조화된 메타데이터 엔트리를 추출한다.
"""

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml

logger = logging.getLogger(__name__)


class MetadataExtractor:
    """YAML 규칙을 로드하고 tool_result 이벤트에서 메타데이터를 추출한다."""

    def __init__(self, rules_path: Path):
        """규칙 파일을 로드한다.

        Args:
            rules_path: YAML 규칙 파일 경로

        Raises:
            FileNotFoundError: 규칙 파일이 존재하지 않을 때
        """
        if not rules_path.exists():
            raise FileNotFoundError(f"Metadata rules file not found: {rules_path}")

        with open(rules_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)

        self._rules = data.get("rules", [])

        # tool_name 정규식 사전 컴파일
        for rule in self._rules:
            if rule.get("tool_name_regex"):
                rule["_tool_name_compiled"] = re.compile(rule["tool_name"])
            if rule.get("result_mode") == "regex" and rule.get("result_pattern"):
                rule["_result_compiled"] = re.compile(rule["result_pattern"])

        logger.info(f"Loaded {len(self._rules)} metadata extraction rules from {rules_path}")

    def extract(
        self, tool_name: str, result: str, is_error: bool
    ) -> Optional[dict]:
        """tool_result 이벤트에서 메타데이터 엔트리를 추출한다.

        규칙은 위에서 아래로 순회하며, 첫 번째 매칭이 반환된다 (first-match-wins).
        규칙 파일의 순서가 우선순위를 결정하므로, 더 구체적인 규칙을 위에 배치해야 한다.

        Args:
            tool_name: 도구 이름
            result: 도구 실행 결과 텍스트
            is_error: 도구 실행 오류 여부

        Returns:
            매칭된 메타데이터 엔트리 dict, 없으면 None
            엔트리 형태: {type, value, label?, url?, timestamp, tool_name}
        """
        if is_error:
            return None

        for rule in self._rules:
            if not self._match_tool_name(rule, tool_name):
                continue

            entry = self._extract_by_mode(rule, result, tool_name)
            if entry is not None:
                return entry

        return None

    def _match_tool_name(self, rule: dict, tool_name: str) -> bool:
        """도구 이름이 규칙에 매칭되는지 확인한다."""
        compiled = rule.get("_tool_name_compiled")
        if compiled:
            return compiled.search(tool_name) is not None
        return rule.get("tool_name") == tool_name

    def _extract_by_mode(
        self, rule: dict, result: str, tool_name: str
    ) -> Optional[dict]:
        """규칙의 result_mode에 따라 메타데이터를 추출한다."""
        mode = rule.get("result_mode", "regex")
        extract = rule.get("extract", {})

        if mode == "regex":
            return self._extract_regex(rule, result, tool_name, extract)
        elif mode == "json":
            return self._extract_json(result, tool_name, extract)
        return None

    def _extract_regex(
        self, rule: dict, result: str, tool_name: str, extract: dict
    ) -> Optional[dict]:
        """정규식 모드로 메타데이터를 추출한다."""
        compiled = rule.get("_result_compiled")
        if compiled is None:
            return None

        match = compiled.search(result)
        if match is None:
            return None

        entry = {
            "type": extract.get("type", "unknown"),
            "value": self._substitute_groups(extract.get("value", ""), match),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "tool_name": tool_name,
        }

        if "label" in extract:
            entry["label"] = self._substitute_groups(extract["label"], match)
        if "url" in extract:
            entry["url"] = self._substitute_groups(extract["url"], match)

        return entry

    def _extract_json(
        self, result: str, tool_name: str, extract: dict
    ) -> Optional[dict]:
        """JSON 모드로 메타데이터를 추출한다."""
        try:
            data = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return None

        # MCP content block unwrap: [{"type":"text","text":"..."}] → inner JSON
        data = self._unwrap_mcp_content(data)

        if not isinstance(data, dict):
            return None

        value = self._resolve_json_path(data, extract.get("value", ""))
        if value is None:
            return None

        entry = {
            "type": extract.get("type", "unknown"),
            "value": str(value),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "tool_name": tool_name,
        }

        if "label" in extract:
            label = self._resolve_json_path(data, extract["label"])
            if label is not None:
                entry["label"] = str(label)
        if "url" in extract:
            url = self._resolve_json_path(data, extract["url"])
            if url is not None:
                entry["url"] = str(url)

        return entry

    @staticmethod
    def _unwrap_mcp_content(data: Any) -> Any:
        """MCP content block 배열에서 실제 JSON을 추출한다.

        MCP 도구 결과는 [{"type":"text","text":"실제JSON"}] 형태로 래핑된다.
        message_processor.py가 이를 json.dumps()로 직렬화하므로,
        json.loads() 결과가 list일 수 있다.
        """
        if (
            isinstance(data, list)
            and len(data) == 1
            and isinstance(data[0], dict)
            and data[0].get("type") == "text"
            and "text" in data[0]
        ):
            try:
                return json.loads(data[0]["text"])
            except (json.JSONDecodeError, TypeError):
                pass
        return data

    @staticmethod
    def _substitute_groups(template: str, match: re.Match) -> str:
        """$1, $2 등의 캡처 그룹 참조를 실제 값으로 치환한다."""
        result = template
        for i in range(1, len(match.groups()) + 1):
            group_value = match.group(i) or ""
            result = result.replace(f"${i}", group_value)
        return result

    @staticmethod
    def _resolve_json_path(data: dict, path: str) -> Any:
        """간단한 JSON 경로 ($.field 또는 $.field.subfield)로 값을 추출한다."""
        if not path.startswith("$."):
            return None

        keys = path[2:].split(".")
        current = data
        for key in keys:
            if not isinstance(current, dict) or key not in current:
                return None
            current = current[key]
        return current
