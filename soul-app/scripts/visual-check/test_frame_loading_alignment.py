"""Check that alignment measurements reject missing and misplaced elements."""
import unittest

from frame_loading import check_alignment_metrics


class AlignmentChecks(unittest.TestCase):
    def test_alignment_and_partial_lane_failures(self):
        metrics = {
            'title': {'left': 20}, 'heading': {'left': 20}, 'card': {'left': 20},
            'board': {'left': 12, 'right': 500},
            'visible': [{'left': 12, 'right': 250}], 'review': {'left': 12, 'right': 250},
        }
        failures = []
        check_alignment_metrics(metrics, 'aligned', failures, True, True, True)
        self.assertEqual(failures, [])
        metrics['card'] = None
        metrics['visible'][0]['left'] = 8
        metrics['review'] = None
        check_alignment_metrics(metrics, 'broken', failures, True, True, True)
        self.assertEqual([entry['check'] for entry in failures], [
            'board start alignment', 'partial board lane', 'review lane not fully visible',
        ])


if __name__ == '__main__':
    unittest.main()
