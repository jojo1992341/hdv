"""
ocr_engine.py — Moteur OCR Tesseract pour l'HDV Dofus
======================================================
Responsabilité unique : extraire les champs textuels et numériques
(nom, niveau, type, prix, lots) depuis une image recadrée de popup HDV,
en utilisant pytesseract avec OpenCV pour le prétraitement.

Architecture de traitement (v3 — OCR par zone + PSM différencié) :
    image PNG
      → ocr_zone(image, rect, mode)  : recadrage + agrandissement + seuillage + OCR
      → extract_common_fields()      : nom / niveau / type / prix_moyen
      → extract_resource_fields()    : + lots ×1/×10/×100/×1000
      → extract_equipment_fields()   : + prix unique équipement
      → dict résultat final

Modes OCR :
    _TESSERACT_TEXT : PSM 7, pas de whitelist
                      → zones textuelles : nom, type
    _TESSERACT_NUM  : PSM 8, whitelist "0-9 "
                      → zones numériques : prix, niveau, quantité lot

    PSM 8 ("single word") est plus fiable que PSM 7 ("single line") sur les
    nombres courts isolés (ex: "1", "15", "598"). La whitelist évite les
    confusions "1"→"l", "0"→"O", caractères parasites dans les chiffres.

Snap des quantités de lot :
    Les seules valeurs légales en HDV sont {1, 10, 100, 1000}.
    _snap_lot_quantity() mappe la valeur OCR vers la valeur légale la plus
    proche (dans ±50 %) pour absorber les erreurs résiduelles post-whitelist.

Suppressions vs v1 :
    run_tesseract()         — zoom global image entière
    extract_words_in_rect() — filtrage spatial
    _ocr_lot_row_fallback() — fusionné dans ocr_zone

Pickling :
    ocr_resource_image() et ocr_equipment_image() sont définies au
    niveau MODULE pour être picklables par ProcessPoolExecutor.

Dépendances internes :
    config.py     → coordonnées popup (dict brut pour pickling)
    text_utils.py → clean_item_name, clean_type_text, parse_integer
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import cv2
import numpy as np
import pytesseract

from text_utils import clean_item_name, clean_type_text, parse_integer, parse_first_integer, parse_first_integer

log = logging.getLogger("DofusHDV")


# ══════════════════════════════════════════════════════════════════
#  CONSTANTES OCR
# ══════════════════════════════════════════════════════════════════

OCR_SCALE:       int = 3
OCR_SCALE_FB:    int = 2
OCR_THRESHOLD:   int = 110
OCR_ZONE_MARGIN: int = 4

# ── Configurations Tesseract ───────────────────────────────────────
# PSM 7 : "Treat the image as a single text line."
# → Adapté aux zones textuelles propres sans icônes parasites : nom.
_TESSERACT_TEXT: str = "--psm 7 --oem 3"

# PSM 6 : "Assume a single uniform block of text."
# → Adapté aux zones contenant des icônes graphiques Dofus avant le texte.
# Ex : zone type contient "♦ 🛡 Chapeau" — les icônes à zoom élevé
# fragmentent la ligne et font échouer PSM 7. PSM 6 est plus tolérant
# aux éléments non textuels intercalés.
# Aussi utilisé pour le niveau ("Niv. 20") : le contexte textuel "Niv."
# aide Tesseract à localiser le chiffre mieux que la whitelist seule.
_TESSERACT_BLOCK: str = "--psm 6 --oem 3"

# PSM 7 + whitelist chiffres : zones numériques avec séparateurs d'espace.
# Ex : "599 951", "9 400", "1 000" — PSM 8 ("single word") tronquerait.
# La whitelist "0123456789 " empêche les confusions "1"↔"l"/"I", "0"↔"O".
_TESSERACT_NUM: str = "--psm 7 --oem 3 -c tessedit_char_whitelist=0123456789 "

# Lots valides en HDV Dofus — les seules quantités légales.
VALID_LOTS: frozenset[int] = frozenset({1, 10, 100, 1000})

# Plage légale pour un prix HDV Dofus (1 kama → 999 millions).
_MAX_PRICE: int = 999_999_999

# Valeur maximale acceptée pour un niveau item.
_MAX_LEVEL: int = 300

# Coordonnées par défaut pour les workers multiprocessing.
_DEFAULT_CROP: list[int] = [0, 0, 420, 420]
_DEFAULT_POPUP_RECTS: dict = {
    "nom":        [83,  70, 380,  91],
    "niveau":     [83,  94, 143, 108],
    "type":       [145, 94, 380, 108],
    "prix_moyen": [169, 115, 244, 128],
    "lots": [
        {"lot": [60, 250, 165, 272], "prix": [180, 250, 290, 272]},
        {"lot": [60, 282, 165, 312], "prix": [180, 282, 290, 312]},
        {"lot": [60, 322, 165, 352], "prix": [180, 322, 290, 352]},
        {"lot": [60, 362, 165, 383], "prix": [180, 362, 290, 383]},
    ],
}
_DEFAULT_EQUIP_PRICE_RECTS: list[list[int]] = [
    [131, 236, 283, 263],
    [131, 263, 283, 288],
]


# ══════════════════════════════════════════════════════════════════
#  LECTURE D'IMAGE AVEC SUPPORT UNICODE
# ══════════════════════════════════════════════════════════════════

def read_image_unicode(filepath: str) -> Optional[np.ndarray]:
    """
    Charge une image OpenCV depuis un chemin pouvant contenir des
    caractères Unicode.

    cv2.imread() échoue silencieusement sur les chemins non-ASCII.
    Contournement via np.fromfile().

    Args:
        filepath: Chemin absolu ou relatif vers l'image.

    Returns:
        Tableau numpy BGR, ou None si la lecture échoue.
    """
    try:
        return cv2.imdecode(
            np.fromfile(filepath, dtype=np.uint8),
            cv2.IMREAD_COLOR,
        )
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════════
#  OCR PAR ZONE
# ══════════════════════════════════════════════════════════════════

def ocr_zone(
    image:   np.ndarray,
    rect:    tuple[int, int, int, int],
    config:  str = _TESSERACT_TEXT,
    scale:   int = OCR_SCALE,
    margin:  int = OCR_ZONE_MARGIN,
) -> str:
    """
    Extrait le texte d une zone rectangulaire de l image via zoom local.

    Prétraitement : zoom + inversion des couleurs (cv2.bitwise_not).
    L inversion donne un fond blanc et du texte sombre, ce que Tesseract
    lit mieux que l interface dorée/sombre de Dofus.

    Args:
        image:  Image BGR numpy complète (popup recadrée, ex: 420x420).
        rect:   Zone cible (x1, y1, x2, y2) en coordonnées image.
        config: Configuration Tesseract.
        scale:  Facteur de zoom appliqué avant OCR.
        margin: Marge en pixels ajoutée autour du rect.

    Returns:
        Texte brut extrait par Tesseract, ou chaîne vide si zone invalide.
    """
    x1, y1, x2, y2 = rect
    h, w = image.shape[:2]

    y1c = max(0, y1 - margin)
    y2c = min(h, y2 + margin)
    x1c = max(0, x1 - margin)
    x2c = min(w, x2 + margin)

    crop = image[y1c:y2c, x1c:x2c]
    if crop.size == 0:
        return ""

    ch, cw   = crop.shape[:2]
    zoomed   = cv2.resize(crop, (cw * scale, ch * scale), interpolation=cv2.INTER_CUBIC)
    inverted = cv2.bitwise_not(zoomed)
    del zoomed

    # Tesseract attend du RGB — cv2 travaille en BGR
    rgb  = cv2.cvtColor(inverted, cv2.COLOR_BGR2RGB)
    del inverted

    text = pytesseract.image_to_string(rgb, config=config).strip()
    del rgb

    return text



# ══════════════════════════════════════════════════════════════════
#  SNAP DE QUANTITÉ LOT
# ══════════════════════════════════════════════════════════════════

def _snap_lot_quantity(raw_value: Optional[int]) -> Optional[int]:
    """
    Mappe une quantité OCR vers la valeur de lot légale la plus proche.

    Les seules quantités légales en HDV sont {1, 10, 100, 1000}.
    La whitelist _TESSERACT_NUM élimine la majorité des confusions
    lettre/chiffre. Ce snap couvre les erreurs résiduelles :
        2   → 1   (chiffre adjacent à 1)
        11  → 10
        105 → 100
        900 → 1000

    Seuil d'acceptation : ±50 % de la valeur légale cible.
    Au-delà (ex: 500 — équidistant de 100 et 1000), retourne None.

    Args:
        raw_value: Entier lu par OCR, ou None si lecture échouée.

    Returns:
        Valeur légale la plus proche si dans le seuil, None sinon.
    """
    if raw_value is None or raw_value <= 0:
        return None

    closest   = min(VALID_LOTS, key=lambda v: abs(v - raw_value))
    tolerance = closest * 0.5

    if abs(raw_value - closest) <= tolerance:
        return closest

    return None


# ══════════════════════════════════════════════════════════════════
#  VALIDATION DU PRIX
# ══════════════════════════════════════════════════════════════════

def _validate_price(raw_value: Optional[int]) -> Optional[int]:
    """
    Valide qu'un prix extrait par OCR est dans la plage légale HDV.

    Plage : [1, 999_999_999] — minimum 1 kama, maximum 999 millions.

    Args:
        raw_value: Entier lu par OCR, ou None si lecture échouée.

    Returns:
        raw_value si valide, None sinon.
    """
    if raw_value and 0 < raw_value <= _MAX_PRICE:
        return raw_value
    return None


# ══════════════════════════════════════════════════════════════════
#  EXTRACTION DE CHAMPS COMMUNS (nom, niveau, type, prix_moyen)
# ══════════════════════════════════════════════════════════════════

def extract_common_fields(
    image:       np.ndarray,
    popup_rects: dict,
    scale:       int = OCR_SCALE,
) -> dict[str, Any]:
    """
    Extrait les champs communs aux ressources et équipements.

    Dispatche les configs Tesseract selon la nature du champ :
        nom        → _TESSERACT_TEXT  (PSM 7, zone propre)
        niveau     → _TESSERACT_BLOCK (PSM 6, "Niv. 20" — contexte textuel)
        type       → _TESSERACT_BLOCK (PSM 6, icônes ♦ 🛡 avant le texte)
        prix_moyen → _TESSERACT_NUM   (PSM 7 + whitelist, icône 📈 après)

    Args:
        image:       Image BGR numpy complète (popup recadrée).
        popup_rects: Dict des zones OCR (format brut JSON — picklable).
        scale:       Facteur de zoom appliqué avant OCR.

    Returns:
        Dict avec clés : nom, niveau, type, prix_moyen.
    """
    def read_text(key: str) -> str:
        return ocr_zone(image, tuple(popup_rects[key]), _TESSERACT_TEXT, scale)

    def read_block(key: str) -> str:
        return ocr_zone(image, tuple(popup_rects[key]), _TESSERACT_BLOCK, scale)

    def read_num(key: str) -> str:
        return ocr_zone(image, tuple(popup_rects[key]), _TESSERACT_NUM, scale)

    nom = clean_item_name(read_text("nom")) or None

    # Niveau : PSM 6 (bloc) + parse_integer().
    # La zone contient "Niv. 20" — le contexte textuel "Niv." aide Tesseract
    # à localiser le chiffre. La whitelist (NUM) le masquait au lieu de l'aider
    # à certains scales, donnant un résultat vide.
    niveau_raw = parse_integer(read_block("niveau"))
    niveau     = niveau_raw if niveau_raw and 0 < niveau_raw < _MAX_LEVEL else None

    # Type : PSM 6 (bloc).
    # La zone contient des icônes graphiques Dofus (♦ 🛡) avant le texte du type.
    # À zoom élevé, ces icônes fragmentent la ligne et font échouer PSM 7.
    # PSM 6 traite la zone comme un bloc et est plus tolérant aux éléments
    # non textuels. clean_type_text() retire ensuite les caractères parasites.
    type_item = clean_type_text(read_block("type")) or None

    # prix_moyen : parse_first_integer() — icône 📈 après le nombre.
    raw_prix_moyen = read_num("prix_moyen")
    prix_moyen     = _validate_price(parse_first_integer(raw_prix_moyen))

    log.debug(
        f"OCR brut — "
        f"nom={read_text('nom')!r} "
        f"niveau={read_block('niveau')!r} "
        f"type={read_block('type')!r} "
        f"prix_moyen={raw_prix_moyen!r}"
    )

    return {
        "nom":        nom,
        "niveau":     niveau,
        "type":       type_item,
        "prix_moyen": prix_moyen,
    }


# ══════════════════════════════════════════════════════════════════
#  EXTRACTION RESSOURCES (+ lots ×1/×10/×100/×1000)
# ══════════════════════════════════════════════════════════════════

def extract_resource_fields(
    image:       np.ndarray,
    popup_rects: dict,
    scale:       int = OCR_SCALE,
) -> dict[str, Any]:
    """
    Extrait tous les champs d'une image ressource HDV.

    Zones lot et prix lues en _TESSERACT_NUM.
    La quantité est snapée vers {1, 10, 100, 1000} via _snap_lot_quantity().
    Le prix est validé dans [1, 999_999_999] via _validate_price().

    Stratégie de résolution des lots (trois passes) :
        1. Lecture directe de chaque ligne configurée dans popup_rects
        2. Si ×1 absent : zone projetée une ligne au-dessus de la première
           ligne calibrée (lot ×1 physiquement au-dessus de la config)
        3. Si toujours vide : assignment séquentiel des prix disponibles

    Args:
        image:       Image BGR numpy complète (popup recadrée).
        popup_rects: Dict des zones OCR (format brut JSON — picklable).
        scale:       Facteur de zoom appliqué avant OCR.

    Returns:
        Dict avec clés : nom, niveau, type, prix_moyen,
        prix_1, prix_10, prix_100, prix_1000.
    """
    result      = extract_common_fields(image, popup_rects, scale)
    lots_config = popup_rects.get("lots", _DEFAULT_POPUP_RECTS["lots"])
    prices: dict[int, int] = {}

    # ── Stratégie 1 : lecture directe de chaque ligne ───────────────
    for lot_row in lots_config:
        lot_text  = ocr_zone(image, tuple(lot_row["lot"]),  _TESSERACT_NUM, scale)
        prix_text = ocr_zone(image, tuple(lot_row["prix"]), _TESSERACT_NUM, scale)

        log.debug(f"OCR lot brut — lot={lot_text!r} prix={prix_text!r}")

        quantite = _snap_lot_quantity(parse_integer(lot_text))
        prix     = _validate_price(parse_first_integer(prix_text))

        if quantite is not None and prix is not None:
            prices[quantite] = prix

    # ── Stratégie 2 : lot ×1 manquant → zone projetée au-dessus ────
    if 1 not in prices and len(lots_config) >= 2:
        lot0        = lots_config[0]
        lot1        = lots_config[1]
        row_spacing = lot1["lot"][1] - lot0["lot"][1]

        if row_spacing > 0:
            dy             = row_spacing
            proj_lot_rect  = (
                lot0["lot"][0],  lot0["lot"][1]  - dy,
                lot0["lot"][2],  lot0["lot"][3]  - dy,
            )
            proj_prix_rect = (
                lot0["prix"][0], lot0["prix"][1] - dy,
                lot0["prix"][2], lot0["prix"][3] - dy,
            )

            prix_proj = _validate_price(
                parse_first_integer(ocr_zone(image, proj_prix_rect, _TESSERACT_NUM, scale))
            )
            if prix_proj is not None:
                # Si la zone projetée contient un prix, c'est nécessairement
                # le lot ×1 — la seule ligne possible au-dessus de la config.
                prices[1] = prix_proj

    # ── Stratégie 3 : assignment séquentiel des prix disponibles ────
    if not prices:
        for lot_qty, lot_row in zip([1, 10, 100, 1000], lots_config):
            prix = _validate_price(
                parse_first_integer(ocr_zone(image, tuple(lot_row["prix"]), _TESSERACT_NUM, scale))
            )
            if prix is not None:
                prices[lot_qty] = prix

    result.update({
        "prix_1":    prices.get(1),
        "prix_10":   prices.get(10),
        "prix_100":  prices.get(100),
        "prix_1000": prices.get(1000),
    })
    return result


# ══════════════════════════════════════════════════════════════════
#  EXTRACTION ÉQUIPEMENTS (+ prix unique)
# ══════════════════════════════════════════════════════════════════

def extract_equipment_fields(
    image:             np.ndarray,
    popup_rects:       dict,
    equip_price_rects: list,
    scale:             int = OCR_SCALE,
) -> dict[str, Any]:
    """
    Extrait tous les champs d'une image équipement HDV.

    Le prix est lu en _TESSERACT_NUM et validé dans [1, 999_999_999].
    Tente chaque zone equip_price_rects dans l'ordre — retourne le premier
    prix valide trouvé.

    Args:
        image:             Image BGR numpy complète (popup recadrée).
        popup_rects:       Dict des zones OCR (format brut JSON — picklable).
        equip_price_rects: Liste de tuples (x1,y1,x2,y2) pour le prix.
        scale:             Facteur de zoom appliqué avant OCR.

    Returns:
        Dict avec clés : nom, niveau, type, prix_moyen, prix.
    """
    result         = extract_common_fields(image, popup_rects, scale)
    result["prix"] = None

    for price_rect in equip_price_rects:
        raw_prix = ocr_zone(image, tuple(price_rect), _TESSERACT_NUM, scale)
        log.debug(f"OCR équip prix brut — {raw_prix!r}")
        prix = _validate_price(parse_first_integer(raw_prix))
        if prix is not None:
            result["prix"] = prix
            break

    return result


# ══════════════════════════════════════════════════════════════════
#  HELPERS DE PARSING DE CONFIGURATION (DICT BRUT JSON)
# ══════════════════════════════════════════════════════════════════

def _parse_popup_rects_from_dict(config_dict: dict) -> dict:
    """Extrait et normalise les zones popup depuis un dict de configuration brut."""
    raw = config_dict.get("popup_rects", _DEFAULT_POPUP_RECTS)
    return {
        "nom":        tuple(raw["nom"]),
        "niveau":     tuple(raw["niveau"]),
        "type":       tuple(raw["type"]),
        "prix_moyen": tuple(raw["prix_moyen"]),
        "lots": [
            {"lot": tuple(r["lot"]), "prix": tuple(r["prix"])}
            for r in raw["lots"]
        ],
    }


def _parse_equip_price_rects_from_dict(config_dict: dict) -> list[tuple]:
    """Extrait les rectangles de prix équipement depuis un dict de config brut."""
    raw = config_dict.get("equip_price_rects", _DEFAULT_EQUIP_PRICE_RECTS)
    return [tuple(r) for r in raw]


def _validate_image_size(image: "np.ndarray", config_dict: dict) -> bool:
    """
    Vérifie que l'image a les dimensions attendues par la configuration.
    Tolère un écart de ±5 pixels.
    """
    crop       = config_dict.get("crop", _DEFAULT_CROP)
    expected_w = crop[2] - crop[0]
    expected_h = crop[3] - crop[1]
    actual_h, actual_w = image.shape[:2]
    return abs(actual_h - expected_h) <= 5 and abs(actual_w - expected_w) <= 5


# ══════════════════════════════════════════════════════════════════
#  FONCTIONS PUBLIQUES — NIVEAU MODULE (PICKLABLES)
#  Ces fonctions sont soumises au ProcessPoolExecutor.
#  Elles NE DOIVENT PAS être déplacées dans une classe.
# ══════════════════════════════════════════════════════════════════

def ocr_resource_image(
    image_path:  str,
    config_dict: dict,
) -> Optional[dict[str, Any]]:
    """
    Point d'entrée OCR pour une image de ressource HDV.

    Fonction picklable — peut être soumise directement à un
    ProcessPoolExecutor sans sérialisation d'objet.

    Tente d'abord à OCR_SCALE (×3), puis à OCR_SCALE_FB (×2) en fallback.
    Retourne None si l'image est illisible ou de mauvaise taille.

    Args:
        image_path:  Chemin absolu vers l'image PNG nettoyée.
        config_dict: Dict de configuration brut (sortie de ConfigManager.load_raw()).

    Returns:
        Dict résultat avec clés nom/niveau/type/prix_moyen/prix_1...prix_1000/id/source,
        ou None si le traitement échoue.
    """
    image = read_image_unicode(image_path)
    if image is None:
        return None

    if not _validate_image_size(image, config_dict):
        return None

    popup_rects = _parse_popup_rects_from_dict(config_dict)
    scale       = int(config_dict.get("ocr_scale", OCR_SCALE))
    scale_fb    = max(1, scale - 1)

    try:
        result = extract_resource_fields(image, popup_rects, scale)
    except Exception:
        try:
            result = extract_resource_fields(image, popup_rects, scale_fb)
        except Exception:
            return None

    result["id"]     = None
    result["source"] = os.path.basename(image_path)
    return result


def ocr_equipment_image(
    image_path:  str,
    config_dict: dict,
) -> Optional[dict[str, Any]]:
    """
    Point d'entrée OCR pour une image d'équipement HDV.

    Fonction picklable — peut être soumise directement à un
    ProcessPoolExecutor sans sérialisation d'objet.

    Tente d'abord à OCR_SCALE (×3), puis à OCR_SCALE_FB (×2) en fallback.
    Retourne None si l'image est illisible ou de mauvaise taille.

    Args:
        image_path:  Chemin absolu vers l'image PNG nettoyée.
        config_dict: Dict de configuration brut (sortie de ConfigManager.load_raw()).

    Returns:
        Dict résultat avec clés nom/niveau/type/prix_moyen/prix/id/source,
        ou None si le traitement échoue.
    """
    image = read_image_unicode(image_path)
    if image is None:
        return None

    if not _validate_image_size(image, config_dict):
        return None

    popup_rects       = _parse_popup_rects_from_dict(config_dict)
    equip_price_rects = _parse_equip_price_rects_from_dict(config_dict)
    scale             = int(config_dict.get("ocr_scale", OCR_SCALE))
    scale_fb          = max(1, scale - 1)

    try:
        result = extract_equipment_fields(image, popup_rects, equip_price_rects, scale)
    except Exception:
        try:
            result = extract_equipment_fields(image, popup_rects, equip_price_rects, scale_fb)
        except Exception:
            return None

    result["id"]     = None
    result["source"] = os.path.basename(image_path)
    return result
