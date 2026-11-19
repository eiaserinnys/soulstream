"""Check that the completed lane measurements reject planted violations."""
import copy
import unittest

from frame_loading import (check_completed_error, check_completed_recovered, check_period_chips,
                           check_refresh_kept_cards)


def chip(value, left, top, width=110.94, height=48, scroll=60, client=60):
    return {'value': value, 'left': left, 'right': left + width, 'top': top, 'bottom': top + height,
            'width': width, 'height': height, 'minHeight': 48,
            'label': {'scrollWidth': scroll, 'clientWidth': client, 'text': value}}


def two_rows():
    return {
        'lane': {'left': 12, 'right': 254, 'width': 242},
        'track': {'left': 20, 'right': 246, 'width': 226},
        'viewportWidth': 480,
        'chips': [chip('7', 22, 100), chip('30', 133, 100), chip('all', 22, 148), chip('custom', 133, 148)],
        'error': None, 'retry': None, 'cards': 1, 'count': 1, 'firstCard': 'postit-card-a',
    }


def failed():
    metrics = two_rows()
    metrics['error'] = {'left': 20, 'right': 240, 'width': 220, 'height': 40, 'text': '완료 카드를 불러오지 못했습니다.'}
    metrics['retry'] = {'left': 20, 'right': 120, 'width': 100, 'height': 50, 'text': '다시 시도'}
    metrics['cards'], metrics['count'] = 0, 0
    return metrics


def checks(entries):
    return [entry['check'] for entry in entries]


class PeriodChipChecks(unittest.TestCase):
    def test_two_rows_and_one_row_pass(self):
        failures = []
        check_period_chips(two_rows(), 'two', failures)
        one = two_rows()
        one['chips'] = [chip(v, 20 + i * 56.5, 100, width=56.5) for i, v in enumerate(('7', '30', 'all', 'custom'))]
        check_period_chips(one, 'one', failures)
        self.assertEqual(failures, [])

    def test_planted_violations_fail(self):
        metrics = two_rows()
        metrics['chips'][2]['top'], metrics['chips'][2]['left'] = 100, 244
        failures = []
        check_period_chips(metrics, 'three-one', failures)
        self.assertIn('period chip rows', checks(failures))

        metrics = two_rows()
        metrics['chips'][1]['width'] = 100
        metrics['chips'][3]['right'] = 240
        metrics['chips'][0]['label']['scrollWidth'] = 70
        metrics['chips'][2]['height'] = 40
        metrics['track']['right'] = 260
        failures = []
        check_period_chips(metrics, 'broken', failures)
        self.assertEqual(sorted(set(checks(failures))), sorted([
            'period chip width', 'period chip row edges', 'period chip label clipped',
            'period chip hit height', 'period chips outside lane',
        ]))

        metrics = two_rows()
        metrics['chips'][3] = None
        failures = []
        check_period_chips(metrics, 'missing', failures)
        self.assertEqual(checks(failures), ['period chips missing'])


class RetryChecks(unittest.TestCase):
    def test_failure_screen_passes(self):
        failures = []
        check_completed_error(failed(), 'failed', failures, True)
        ranged = failed()
        ranged['retry'] = None
        ranged['error']['text'] = '시작일과 종료일을 확인해 주세요.'
        check_completed_error(ranged, 'range', failures, False, '시작일과 종료일을 확인해 주세요.')
        check_completed_recovered(two_rows(), 'recovered', failures)
        check_refresh_kept_cards({'cards': 16, 'count': 60, 'firstCard': 'a'}, {'cards': 14, 'count': 60, 'firstCard': 'a'}, 'kept', failures)
        self.assertEqual(failures, [])

    def test_planted_violations_fail(self):
        failures = []
        metrics = failed()
        metrics['retry'] = None
        check_completed_error(metrics, 'no-retry', failures, True)
        metrics = failed()
        metrics['retry'].update({'right': 260, 'height': 40, 'text': '재시도'})
        check_completed_error(metrics, 'bad-retry', failures, True)
        metrics = failed()
        metrics['retry'].update({'left': 20, 'right': 246, 'width': 226})
        check_completed_error(metrics, 'stretched', failures, True)
        check_completed_error(failed(), 'range-with-retry', failures, False)
        metrics = failed()
        metrics['error'] = None
        check_completed_error(metrics, 'no-error', failures, True)
        self.assertEqual(checks(failures), [
            'retry button missing', 'retry text', 'retry outside lane', 'retry hit height',
            'retry stretched to the lane width', 'retry must be absent', 'completed error missing',
        ])

        failures = []
        check_completed_recovered(failed(), 'still-failed', failures)
        recovered = two_rows()
        recovered['count'] = 59
        check_completed_recovered(recovered, 'fewer', failures, 60)
        check_refresh_kept_cards({'cards': 16, 'count': 60, 'firstCard': 'a'}, {'cards': 16, 'count': 0, 'firstCard': None}, 'dropped', failures)
        check_refresh_kept_cards({'cards': 16, 'count': 60, 'firstCard': 'a'}, {'cards': 16, 'count': 60, 'firstCard': 'b'}, 'moved', failures)
        self.assertEqual(checks(failures), [
            'completed not recovered', 'completed not recovered',
            'completed refresh failure dropped cards', 'completed refresh failure dropped cards',
        ])


if __name__ == '__main__':
    unittest.main()
