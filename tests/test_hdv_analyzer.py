import unittest

from src.hdv_analyzer import (
    analyze_flip,
    extract_hdv_offers,
    extract_market_metrics,
)


class AnalyzerTests(unittest.TestCase):
    def test_extract_market_metrics(self):
        text = "Prix médian : 1 262 K Prix moyen : 1 678 K 15 296 articles vendus"
        metrics = extract_market_metrics(text)
        self.assertEqual(metrics.median_price, 1262)
        self.assertEqual(metrics.average_price, 1678)
        self.assertEqual(metrics.sold_count, 15296)

    def test_extract_hdv_offers(self):
        text = """
        1 998
        10 12 797
        100 129 000
        1 000 1 280 000
        """
        offers = extract_hdv_offers(text)
        self.assertEqual(len(offers), 4)
        self.assertEqual(offers[0].quantity, 1)
        self.assertEqual(offers[0].total_price, 998)
        self.assertEqual(offers[-1].quantity, 1000)

    def test_analyze_flip_profitability(self):
        graph_text = "Prix médian : 1 262 K Prix moyen : 1 678 K"
        hdv_text = "1 998\n10 12 797\n100 129 000\n1 000 1 280 000"

        metrics = extract_market_metrics(graph_text)
        offers = extract_hdv_offers(hdv_text)
        result = analyze_flip(metrics, offers, fee_rate=0.02)

        self.assertIsNotNone(result.best_lot)
        self.assertTrue(any(lot.profitable for lot in result.lot_analyses))


if __name__ == "__main__":
    unittest.main()
