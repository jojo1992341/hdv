"""
text_utils.py — Utilitaires texte partagés
===========================================
Responsabilité unique : normalisation de texte, REGEX pré-compilées,
et corrections des erreurs de reconnaissance OCR.

Ce module est un module feuille : il n'importe aucun autre module
interne. Il peut être importé librement par ocr_engine.py et matching.py
sans risque de cycle d'import.

Optimisations vs hdv-v10.py :
- lru_cache porté à 16 384 entrées (vs 8 192)
- Invalidation ciblée via clear_normalize_cache() au lieu de cache_clear() global
- Toutes les REGEX centralisées ici, compilées une seule fois à l'import
"""

from __future__ import annotations

import os
import re
import unicodedata
from functools import lru_cache


# ══════════════════════════════════════════════════════════════════
#  REGEX PRÉ-COMPILÉES
# ══════════════════════════════════════════════════════════════════

# Supprime tout caractère non numérique — utilisé par parse_integer()
# pour concaténer TOUS les chiffres d'une chaîne.
RE_DIGITS_ONLY = re.compile(r"\D")

# Extrait le PREMIER groupe de chiffres contigus dans une chaîne.
# Utilisé par parse_first_integer() pour ignorer les artefacts OCR
# qui suivent un nombre valide (ex: icône graphique lue comme "4" après "531").
RE_FIRST_DIGITS = re.compile(r"\d+")

# Extrait le numéro entre parenthèses dans un nom de fichier — ex: "item(42).png" → "42"
RE_FILE_NUMBER = re.compile(r"\((\d+)\)")

# Normalisation : conserve lettres minuscules, chiffres, accents courants et espaces
RE_NORMALIZE_CHARS = re.compile(r"[^a-z0-9\u00e0-\u00ff ]")

# Collapse les espaces multiples en un seul espace
RE_MULTI_SPACES = re.compile(r"\s+")

# Supprime les caractères non alphabétiques en début de chaîne
RE_LEADING_NON_ALPHA = re.compile(r"^[^A-Za-z\u00C0-\u00FFŒœ]+")

# Nettoie les caractères indésirables dans un nom d'item (conserve apostrophes et tirets)
RE_CLEAN_NAME_CHARS = re.compile(r"[^A-Za-z\u00C0-\u00FFŒœ0-9 '\u2019\-]")

# Nettoie les caractères indésirables dans un type d'item (lettres et espaces uniquement)
RE_CLEAN_TYPE_CHARS = re.compile(r"[^A-Za-zÀ-ÿŒœ ]")

# Supprime les préfixes de type courts (ex: "Ar Niv." → "Niv.")
RE_TYPE_PREFIX = re.compile(r"^(?:[A-Za-z]{1,2}\s+)+")

# Supprime les lettres majuscules isolées collées à "Niv." (artefacts OCR)
RE_PRE_NAME_ARTIFACT = re.compile(r"(?<![A-Za-z])[A-Z]{1,2}(?=Niv\.)")

# ── Extraction du nom principal ────────────────────────────────────
_CHAR = r"[A-Za-z\u00C0-\u00FFŒœ]"
_APOS = r"['\u2018\u2019\u02bc]"

RE_NAME_EXTRACT = re.compile(
    r"([A-Z\u00C0-\u00DCŒ]" + _CHAR + r"{2,}"
    r"(?:[-]" + _CHAR + r"+)*"
    r"(?:\s+"
    r"(?:(?:de |du |des |\u00e0 |au |aux |en )"
    r"|(?:d" + _APOS + r"|l" + _APOS + r"|\u00e0 l" + _APOS + r"))?"
    + _CHAR + r"+"
    r"(?:" + _APOS + _CHAR + r"+)*"
    r"(?:[-]" + _CHAR + r"+)*"
    r")*)"
)


# ══════════════════════════════════════════════════════════════════
#  CORRECTIONS D'ERREURS OCR
# ══════════════════════════════════════════════════════════════════

OCR_CORRECTIONS: list[tuple[str, str]] = [
    # ── Confusions Œuf ──────────────────────────────────────────────
    ("CEuf", "Œuf"), ("OEuf", "Œuf"),
    ("3uf",  "Œuf"), ("3 uf", "Œuf"),
    ("0uf",  "Œuf"),
    ("Quf",  "Œuf"),
    ("Ouf",  "Œuf"),
    ("GEuf", "Œuf"), ("Guf",  "Œuf"),
    ("CUf",  "Œuf"), ("Cuf",  "Œuf"),
    (" uf ", " Œuf "), ("+ uf", "+ Œuf"),
    ("• uf", "• Œuf"), ("* uf", "* Œuf"),
    ("¢ uf", "¢ Œuf"),
    # ── Confusions Œil ──────────────────────────────────────────────
    ("CEil", "Œil"), ("OEil", "Œil"),
    ("3il",  "Œil"), ("3 il", "Œil"),
    ("0il",  "Œil"),
    ("Gil",  "Œil"), ("Qil",  "Œil"),
    ("Oil",  "Œil"),
    ("Cil",  "Œil"),
    (" il ", " Œil "), ("+ il", "+ Œil"),
    ("• il", "• Œil"), ("* il", "* Œil"),
    # ── Formes minuscules ────────────────────────────────────────────
    ("eeuf",   "œuf"), ("ceuf",  "œuf"),
    ("eeil",   "œil"), ("ceil",  "œil"),
    ("eeuvre", "œuvre"),
    # ── Accents manquants ────────────────────────────────────────────
    ("Vétement",  "Vêtement"),
    ("vétement",  "vêtement"),
    # ── Prépositions mal reconnues ───────────────────────────────────
    (" a l'",      " à l'"),
    (" a l\u2019", " à l\u2019"),
    (" a la ",     " à la "),
    (" a le ",     " à le "),
]


# ══════════════════════════════════════════════════════════════════
#  FONCTIONS DE NORMALISATION
# ══════════════════════════════════════════════════════════════════

@lru_cache(maxsize=16_384)
def normalize(text: str, strip_accents: bool = False) -> str:
    """
    Normalise une chaîne pour la comparaison fuzzy.

    Args:
        text:          Chaîne brute à normaliser.
        strip_accents: Si True, supprime les diacritiques (accents).

    Returns:
        Chaîne normalisée, prête pour SequenceMatcher.
    """
    if not text:
        return ""

    normalized = unicodedata.normalize("NFD", text.lower())

    if strip_accents:
        normalized = "".join(
            char for char in normalized
            if unicodedata.category(char) != "Mn"
        )
    else:
        normalized = unicodedata.normalize("NFC", normalized)

    return RE_MULTI_SPACES.sub(
        " ",
        RE_NORMALIZE_CHARS.sub(" ", normalized)
    ).strip()


def clear_normalize_cache() -> None:
    """Invalide le cache de normalize(). À appeler lors du chargement d'un nouveau dictionnaire."""
    normalize.cache_clear()


def normalize_cached_info() -> str:
    """Retourne les statistiques du cache normalize() sous forme lisible."""
    info = normalize.cache_info()
    return (
        f"normalize cache — hits:{info.hits} misses:{info.misses} "
        f"size:{info.currsize}/{info.maxsize}"
    )


def fix_ocr_text(raw_text: str) -> str:
    """
    Applique les corrections d'erreurs OCR connues sur un texte brut.

    Args:
        raw_text: Texte brut issu de Tesseract.

    Returns:
        Texte corrigé.
    """
    for wrong, correct in OCR_CORRECTIONS:
        raw_text = raw_text.replace(wrong, correct)
    return raw_text


def clean_item_name(raw_text: str) -> str:
    """
    Extrait et nettoie le nom d'un item depuis un texte OCR brut.

    Args:
        raw_text: Texte OCR brut de la zone "nom".

    Returns:
        Nom nettoyé, ou chaîne vide si non extractible.
    """
    text = fix_ocr_text(raw_text)
    text = RE_PRE_NAME_ARTIFACT.sub("", text)

    match = RE_NAME_EXTRACT.search(text)
    if match:
        return match.group(1).strip()

    text = RE_LEADING_NON_ALPHA.sub("", text).strip()
    return RE_CLEAN_NAME_CHARS.sub("", text).strip()


_TYPE_RESIDUAL_FIXES: dict[str, str] = {
    "uf":  "Œuf",
    "il":  "Œil",
}


def clean_type_text(raw_text: str) -> str:
    """
    Nettoie le texte OCR de la zone "type" d'un item.

    Args:
        raw_text: Texte OCR brut de la zone "type".

    Returns:
        Type nettoyé, ou chaîne vide.
    """
    text = fix_ocr_text(raw_text)
    text = RE_MULTI_SPACES.sub(" ", RE_CLEAN_TYPE_CHARS.sub(" ", text).strip()).strip()
    text = RE_TYPE_PREFIX.sub("", text).strip()

    corrected = _TYPE_RESIDUAL_FIXES.get(text)
    if corrected:
        return corrected

    return text


def parse_integer(raw_text: str) -> int | None:
    """
    Extrait un entier depuis une chaîne OCR en concaténant TOUS les chiffres.

    Adapté aux zones où le nombre est seul et sans artefact suivant,
    notamment les quantités de lot et les prix de lot (whitelist déjà active).

    ⚠ Ne pas utiliser pour les zones qui peuvent contenir des artefacts
    graphiques après le nombre (ex: prix_moyen suivi d'une icône 📈).
    Utiliser parse_first_integer() dans ce cas.

    Args:
        raw_text: Texte OCR brut (ex: "1 000", "599 951").

    Returns:
        Entier extrait, ou None si aucun chiffre trouvé.
    """
    digits = RE_DIGITS_ONLY.sub("", raw_text)
    return int(digits) if digits else None


def parse_first_integer(raw_text: str) -> int | None:
    """
    Extrait le PREMIER groupe de chiffres contigus d'une chaîne OCR.

    Contrairement à parse_integer() qui concatène TOUS les chiffres,
    cette fonction s'arrête au premier groupe et ignore ce qui suit.

    Cas d'usage typique :
        Prix moyen suivi d'une icône graphique 📈 lue par Tesseract
        comme un chiffre parasite :
            "531 4"  → parse_integer()       → 5314  ❌
            "531 4"  → parse_first_integer() → 531   ✓

        Autres exemples :
            "1 234"  → 1234   (espace séparateur de milliers)
            "67"     → 67
            "5 314"  → 5314   (si l'espace est dans le nombre réel)

    Limitation connue :
        Les nombres avec séparateurs d'espace (ex: "1 000") sont traités
        correctement SEULEMENT si l'artefact produit un espace avant son
        chiffre parasite. Si l'artefact colle directement au nombre
        (ex: "5314" sans espace), le résultat sera incorrect dans les
        deux fonctions. La whitelist Tesseract et le zoom réduisent ce risque.

    Args:
        raw_text: Texte OCR brut pouvant contenir des artefacts après le nombre.

    Returns:
        Premier entier extrait (en ignorant les espaces séparateurs de milliers),
        ou None si aucun chiffre trouvé.
    """
    if not raw_text:
        return None

    # Extraire tous les groupes de chiffres contigus (séparés par espaces)
    groups = RE_FIRST_DIGITS.findall(raw_text)
    if not groups:
        return None

    # Ne conserver que les groupes qui "forment" le nombre principal :
    # un nombre avec séparateurs d'espace comme "1 000" produit ["1", "000"].
    # On distingue un séparateur de milliers (groupe de 3 chiffres après
    # le premier) d'un artefact (groupe court ou incohérent).
    #
    # Règle : concaténer les groupes consécutifs si le groupe suivant
    # fait exactement 3 chiffres (séparateur de milliers français).
    # Sinon, s'arrêter au premier groupe.
    result_digits = groups[0]

    for group in groups[1:]:
        if len(group) == 3:
            # Séparateur de milliers : "531" + "000" → "531000"
            result_digits += group
        else:
            # Artefact OCR (ex: "4" produit par l'icône 📈) → stop
            break

    return int(result_digits) if result_digits else None


def extract_file_number(filename: str) -> str:
    """
    Extrait le numéro entre parenthèses d'un nom de fichier.

    Ex: "capture(42).png" → "42"
        "capture_20240101.png" → "capture_20240101" (nom sans extension)

    Args:
        filename: Nom de fichier (avec ou sans extension).

    Returns:
        Numéro extrait sous forme de chaîne, ou nom sans extension.
    """
    match = RE_FILE_NUMBER.search(filename)
    return match.group(1) if match else os.path.splitext(filename)[0]


# Alias de compatibilité
clean_type_field = clean_type_text
