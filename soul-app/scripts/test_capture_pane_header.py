#!/usr/bin/env python3
"""접근성 이름 판정기가 실제 제목 누락을 잡는지 확인한다."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('capture_pane_header', Path(__file__).with_name('capture-pane-header.py'))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class TitleAccessibilityCheckTest(unittest.TestCase):
    def check_label(self, title, label):
        checks = capture.Checks()
        capture.check_title_read('표본', {'titleRead': {
            'fullText': title, 'accessibilityLabel': label,
            'naturalLineCount': None, 'container': None, 'lineCount': None, 'text': title,
        }}, checks)
        return next(entry['passed'] for entry in checks.entries if entry['name'].endswith('읽기 제목 접근성 이름'))

    def test_visible_title_is_required(self):
        self.assertTrue(self.check_label('작업 폴더', '폴더 제목 작업 폴더'))
        self.assertFalse(self.check_label('작업 폴더', '폴더 제목'))
        self.assertTrue(self.check_label('', '폴더 제목'))


if __name__ == '__main__':
    unittest.main()
