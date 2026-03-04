import re
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class LotOffer:
    quantity: int
    total_price: int

    @property
    def unit_price(self) -> float:
        return self.total_price / self.quantity


@dataclass
class MarketMetrics:
    median_price: int
    average_price: int
    sold_count: Optional[int] = None


@dataclass
class LotAnalysis:
    quantity: int
    buy_total: int
    buy_unit: float
    target_sell_unit: float
    net_unit_after_fees: float
    expected_profit_total: float
    roi_pct: float
    profitable: bool


@dataclass
class FlipRecommendation:
    metrics: MarketMetrics
    offers: List[LotOffer]
    target_sell_unit: float
    fee_rate: float
    lot_analyses: List[LotAnalysis]

    @property
    def best_lot(self) -> Optional[LotAnalysis]:
        profitable = [lot for lot in self.lot_analyses if lot.profitable]
        if not profitable:
            return None
        return max(profitable, key=lambda lot: lot.expected_profit_total)


def normalize_kamas(raw_value: str) -> int:
    digits = re.sub(r"[^\d]", "", raw_value)
    if not digits:
        raise ValueError(f"Aucun nombre détecté dans '{raw_value}'")
    return int(digits)


def extract_market_metrics(ocr_text: str) -> MarketMetrics:
    median_match = re.search(r"prix\s*m[ée]dian\s*[:\-]?\s*([\d\s]+)", ocr_text, re.IGNORECASE)
    avg_match = re.search(r"prix\s*moyen\s*[:\-]?\s*([\d\s]+)", ocr_text, re.IGNORECASE)
    sold_match = re.search(r"([\d\s]+)\s*articles\s*vendus", ocr_text, re.IGNORECASE)

    if not median_match or not avg_match:
        raise ValueError(
            "Impossible d'extraire les prix médian/moyen du graphique. Vérifiez la lisibilité de l'image."
        )

    sold_count = normalize_kamas(sold_match.group(1)) if sold_match else None
    return MarketMetrics(
        median_price=normalize_kamas(median_match.group(1)),
        average_price=normalize_kamas(avg_match.group(1)),
        sold_count=sold_count,
    )


def extract_hdv_offers(ocr_text: str) -> List[LotOffer]:
    offers: List[LotOffer] = []
    line_pattern = re.compile(r"^\s*(1\s*000|1000|100|10|1)\D+([\d\s]{2,})\s*$")

    for line in ocr_text.splitlines():
        match = line_pattern.match(line)
        if not match:
            continue
        quantity = normalize_kamas(match.group(1))
        price = normalize_kamas(match.group(2))
        if quantity in {1, 10, 100, 1000} and price > 0:
            offers.append(LotOffer(quantity=quantity, total_price=price))

    if not offers:
        merged_pattern = re.compile(r"(1\s*000|1000|100|10|1)\s+([\d][\d\s]+)")
        for qty_raw, price_raw in merged_pattern.findall(ocr_text):
            quantity = normalize_kamas(qty_raw)
            price = normalize_kamas(price_raw)
            if quantity in {1, 10, 100, 1000} and price > 0:
                offers.append(LotOffer(quantity=quantity, total_price=price))

    unique = {(offer.quantity, offer.total_price): offer for offer in offers}
    return sorted(unique.values(), key=lambda offer: offer.quantity)


def compute_target_sell_price(metrics: MarketMetrics, safety_discount: float = 0.98) -> float:
    blended = (metrics.median_price * 0.7) + (metrics.average_price * 0.3)
    return blended * safety_discount


def analyze_flip(metrics: MarketMetrics, offers: List[LotOffer], fee_rate: float = 0.02) -> FlipRecommendation:
    if not offers:
        raise ValueError("Aucune offre HDV exploitable n'a été détectée.")

    target_sell_unit = compute_target_sell_price(metrics)
    lot_analyses: List[LotAnalysis] = []

    for offer in offers:
        buy_unit = offer.unit_price
        net_unit_after_fees = target_sell_unit * (1 - fee_rate)
        expected_profit_total = (net_unit_after_fees - buy_unit) * offer.quantity
        buy_total = offer.total_price
        roi_pct = (expected_profit_total / buy_total) * 100
        lot_analyses.append(
            LotAnalysis(
                quantity=offer.quantity,
                buy_total=buy_total,
                buy_unit=buy_unit,
                target_sell_unit=target_sell_unit,
                net_unit_after_fees=net_unit_after_fees,
                expected_profit_total=expected_profit_total,
                roi_pct=roi_pct,
                profitable=expected_profit_total > 0,
            )
        )

    return FlipRecommendation(
        metrics=metrics,
        offers=offers,
        target_sell_unit=target_sell_unit,
        fee_rate=fee_rate,
        lot_analyses=lot_analyses,
    )
