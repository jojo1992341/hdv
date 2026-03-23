"""
matching.py -- Matching fuzzy multi-passes entre résultats OCR et dictionnaire
==============================================================================
Responsabilité unique : associer chaque résultat OCR à un item du dictionnaire
de référence Dofus en utilisant un algorithme de correspondance multi-passes
avec tolérance progressive.

Architecture :
    load_item_dictionary()     -> charge et indexe le dictionnaire JSON
    correct_ocr_type()         -> corrige le type OCR vers le type Dofus canonique
    run_multipass_matching()   -> orchestre les passes de matching
    deduplicate_results()      -> élimine les doublons par (nom, type, niveau)

Optimisations vs hdv-v10.py :
    1. Cache SequenceMatcher borné (50 000 paires) -- inter-images.
    2. Early-exit à score >= 0.98 sur les quasi-correspondances parfaites.
    3. Index _FI construit une seule fois par session via build_search_index().
    4. _PASSES définies comme constante de module.
    5. correct_ocr_type() corrige les erreurs OCR sur le type AVANT le filtrage
       des candidats -- une erreur de type ne bloque plus tout le matching.

Types canoniques :
    Chargés depuis configs/dictionnaire_type.json au démarrage.
    Fallback sur listes vides avec warning si le fichier est absent.
    Pour mettre à jour les types reconnus, éditer uniquement ce fichier JSON.

Dépendances internes :
    text_utils.py -> normalize, clear_normalize_cache
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Optional

from text_utils import normalize, clear_normalize_cache

log = logging.getLogger("DofusHDV")

# Chemin du fichier de types -- même répertoire que config.py
_BASE_DIR        = Path(__file__).parent
_TYPE_DICT_FILE  = _BASE_DIR / "configs" / "dictionnaire_type.json"


# ══════════════════════════════════════════════════════════════════
#  CONSTANTES DE MATCHING
# ══════════════════════════════════════════════════════════════════

MATCHING_TIMEOUT: float = 30.0
EARLY_EXIT_SCORE: float = 0.98
_RATIO_CACHE_MAX_SIZE: int = 50_000

_MATCHING_PASSES: list[tuple[bool, bool, float, bool]] = [
    (False, True, 1.00, False),
    (True,  True, 1.00, False),
    (False, True, 0.75, False),
    (True,  True, 0.75, False),
    (False, True, 0.50, False),
    (True,  True, 0.50, False),
    (False, True, 0.25, False),
    (True,  True, 0.25, False),
]


# ══════════════════════════════════════════════════════════════════
#  CHARGEMENT DES TYPES CANONIQUES DEPUIS JSON
# ══════════════════════════════════════════════════════════════════

def _load_type_dictionary() -> tuple[frozenset[str], frozenset[str]]:
    """
    Charge les types Dofus canoniques depuis configs/dictionnaire_type.json.

    Format attendu :
        {
            "équipements": ["Amulette", "Anneau", ...],
            "ressources":  ["Aile", "Bois", ...]
        }

    Returns:
        Tuple (resource_types, equipment_types) de frozensets.
        Retourne deux frozensets vides avec un warning si le fichier est absent.
    """
    if not _TYPE_DICT_FILE.exists():
        log.warning(
            f"🏷️  {_TYPE_DICT_FILE} introuvable -- "
            "correction de type désactivée. "
            "Créez ce fichier pour activer la correction OCR des types."
        )
        return frozenset(), frozenset()

    try:
        with _TYPE_DICT_FILE.open(encoding="utf-8") as fh:
            data = json.load(fh)

        resource_types  = frozenset(data.get("ressources",   []))
        equipment_types = frozenset(data.get("équipements",  []))

        total = len(resource_types) + len(equipment_types)
        log.debug(
            f"🏷️  Types chargés depuis {_TYPE_DICT_FILE.name} -- "
            f"{len(resource_types)} ressources, {len(equipment_types)} équipements "
            f"({total} total)"
        )
        return resource_types, equipment_types

    except Exception as exc:
        log.warning(f"🏷️  Erreur lecture {_TYPE_DICT_FILE} : {exc} -- correction désactivée")
        return frozenset(), frozenset()


# Chargement à l'import -- une seule fois par session.
_RESOURCE_TYPES, _EQUIPMENT_TYPES = _load_type_dictionary()

# Union des deux listes -- utilisée pour la correction OCR tous modes confondus.
_ALL_VALID_TYPES: list[str] = sorted(_RESOURCE_TYPES | _EQUIPMENT_TYPES)

# Versions normalisées pré-calculées à l'import (avec et sans accents).
# Forme : liste de (type_canonique, norm_avec_accents, norm_sans_accents)
_TYPES_NORMALIZED: list[tuple[str, str, str]] = [
    (t, normalize(t, strip_accents=False), normalize(t, strip_accents=True))
    for t in _ALL_VALID_TYPES
]

# Seuil de correction par défaut.
_TYPE_CORRECTION_THRESHOLD: float = 0.75


def reload_type_dictionary() -> int:
    """
    Recharge les types depuis configs/dictionnaire_type.json sans redémarrer.

    Met à jour _RESOURCE_TYPES, _EQUIPMENT_TYPES, _ALL_VALID_TYPES
    et _TYPES_NORMALIZED en place.

    Utile si l'utilisateur modifie le fichier JSON pendant une session.

    Returns:
        Nombre total de types chargés.
    """
    global _RESOURCE_TYPES, _EQUIPMENT_TYPES, _ALL_VALID_TYPES, _TYPES_NORMALIZED

    _RESOURCE_TYPES, _EQUIPMENT_TYPES = _load_type_dictionary()
    _ALL_VALID_TYPES   = sorted(_RESOURCE_TYPES | _EQUIPMENT_TYPES)
    _TYPES_NORMALIZED  = [
        (t, normalize(t, strip_accents=False), normalize(t, strip_accents=True))
        for t in _ALL_VALID_TYPES
    ]

    total = len(_ALL_VALID_TYPES)
    log.info(f"🏷️  Types rechargés -- {total} types reconnus")
    return total


# ══════════════════════════════════════════════════════════════════
#  ÉTAT DU DICTIONNAIRE (SESSION)
# ══════════════════════════════════════════════════════════════════

_item_list:    list[tuple[dict, str, str, int]] = []
_item_list_a:  list[tuple[dict, str, str, int]] = []
_search_index: defaultdict[tuple, set]          = defaultdict(set)
_flat_index:   list[tuple[dict, str, str, int]] = []
_index_built:  bool                             = False


# ══════════════════════════════════════════════════════════════════
#  CACHE SÉQUENCE MATCHER -- INTER-IMAGES
# ══════════════════════════════════════════════════════════════════

_ratio_cache: dict[tuple[str, str], float] = {}


def _compute_ratio(string_a: str, string_b: str) -> float:
    """
    Calcule le ratio SequenceMatcher entre deux chaînes normalisées.
    Utilise un cache borné à _RATIO_CACHE_MAX_SIZE paires.
    """
    cache_key = (string_a, string_b) if string_a <= string_b else (string_b, string_a)

    cached = _ratio_cache.get(cache_key)
    if cached is not None:
        return cached

    ratio = SequenceMatcher(None, string_a, string_b).ratio()

    if len(_ratio_cache) >= _RATIO_CACHE_MAX_SIZE:
        oldest_key = next(iter(_ratio_cache))
        del _ratio_cache[oldest_key]

    _ratio_cache[cache_key] = ratio
    return ratio


def clear_ratio_cache() -> None:
    """Vide le cache de ratios SequenceMatcher."""
    _ratio_cache.clear()


def ratio_cache_info() -> str:
    """Retourne les statistiques du cache de ratios sous forme lisible."""
    return f"ratio_cache -- size:{len(_ratio_cache)}/{_RATIO_CACHE_MAX_SIZE}"


# ══════════════════════════════════════════════════════════════════
#  CORRECTION OCR DU TYPE
# ══════════════════════════════════════════════════════════════════

def correct_ocr_type(
    raw_type:  str,
    threshold: float = _TYPE_CORRECTION_THRESHOLD,
) -> str:
    """
    Corrige le type OCR vers le type Dofus canonique le plus proche.

    Les types canoniques sont lus depuis configs/dictionnaire_type.json
    au démarrage. Pour ajouter ou modifier un type reconnu, éditer
    uniquement ce fichier -- aucune modification du code nécessaire.

    Utilisée AVANT le filtrage des candidats dans run_multipass_matching().
    Sans cette correction, une erreur OCR sur le type (accent manquant,
    troncature, caractère parasite) bloque _get_candidates() qui retourne
    une liste vide -- aucun candidat, aucun matching possible.

    Exemples de corrections typiques :
        "Etoffe"    -> "Étoffe"      (accent manquant)
        "Vetement"  -> "Vêtement"    (accent manquant)
        "Minerais"  -> "Minerai"     (pluriel OCR)
        "Boi"       -> "Bois"        (lettre finale manquante)

    Args:
        raw_type:  Type brut issu de l'OCR (après clean_type_text).
        threshold: Seuil minimum de ratio pour accepter la correction.

    Returns:
        Type canonique Dofus si trouvé, raw_type inchangé sinon.
        Retourne raw_type inchangé si aucun type canonique n'est chargé.
    """
    if not raw_type or not _TYPES_NORMALIZED:
        return raw_type

    norm_with    = normalize(raw_type, strip_accents=False)
    norm_without = normalize(raw_type, strip_accents=True)

    best_type  = raw_type
    best_score = 0.0

    for canonical, norm_ca_with, norm_ca_without in _TYPES_NORMALIZED:
        score = max(
            _compute_ratio(norm_with,    norm_ca_with),
            _compute_ratio(norm_without, norm_ca_without),
        )
        if score > best_score:
            best_score = score
            best_type  = canonical

    if best_score >= threshold and best_type != raw_type:
        log.info(f"🏷️  Type corrigé : '{raw_type}' -> '{best_type}' ({best_score:.2f})")
        return best_type

    return raw_type


# ══════════════════════════════════════════════════════════════════
#  HELPERS D'ACCÈS AU DICTIONNAIRE
# ══════════════════════════════════════════════════════════════════

def _get_item_level(item: dict) -> Optional[int]:
    return item.get("level")


def _get_item_type_normalized(item: dict) -> str:
    return normalize(
        (item.get("type") or {}).get("name", {}).get("fr", ""),
        strip_accents=False,
    )


def _get_item_type_normalized_no_accent(item: dict) -> str:
    return normalize(
        (item.get("type") or {}).get("name", {}).get("fr", ""),
        strip_accents=True,
    )


def _extract_source_sequence_number(result: dict) -> int:
    source  = os.path.splitext(result.get("source", ""))[0]
    numbers = re.findall(r"\d+", source)
    return int(numbers[-1]) if numbers else 0


# ══════════════════════════════════════════════════════════════════
#  CHARGEMENT DU DICTIONNAIRE D'ITEMS
# ══════════════════════════════════════════════════════════════════

def load_item_dictionary(path: str) -> int:
    """
    Charge le dictionnaire d'items Dofus depuis un fichier JSON.

    Args:
        path: Chemin vers le fichier JSON du dictionnaire.

    Returns:
        Nombre d'items chargés.
    """
    global _item_list, _item_list_a, _index_built

    clear_normalize_cache()
    _index_built = False

    with open(path, encoding="utf-8") as fh:
        raw_items = json.load(fh)

    if isinstance(raw_items, dict):
        raw_items = raw_items.get("items", list(raw_items.values()))

    _item_list = []
    for item in raw_items:
        french_name = (item.get("name") or {}).get("fr") or ""
        if not french_name:
            continue
        norm_name           = normalize(french_name, strip_accents=False)
        norm_name_no_accent = normalize(french_name, strip_accents=True)
        _item_list.append((item, norm_name, norm_name_no_accent, len(norm_name)))

    _item_list_a = list(_item_list)

    log.info(f"📚 Dictionnaire chargé : {len(_item_list)} items")
    return len(_item_list)


def build_search_index() -> None:
    """
    Construit l'index de recherche par (type_normalisé, niveau).
    Construit une seule fois par session.
    Fenêtre de niveau : ±2 niveaux pour absorber les erreurs OCR.
    """
    global _search_index, _flat_index, _index_built

    _search_index = defaultdict(set)
    _flat_index   = list(_item_list)

    for idx, entry in enumerate(_item_list):
        item         = entry[0]
        item_level   = _get_item_level(item)
        type_norm    = _get_item_type_normalized(item)
        type_norm_na = _get_item_type_normalized_no_accent(item)

        if item_level is not None:
            for delta in range(-2, 3):
                for type_key in (type_norm, type_norm_na):
                    _search_index[(type_key, item_level + delta)].add(idx)

        for type_key in (type_norm, type_norm_na):
            _search_index[(type_key, None)].add(idx)

    _index_built = True
    log.debug(f"📚 Index construit -- {len(_search_index)} entrées")


def _get_candidates(
    type_normalized:  str,
    ocr_level:        Optional[int],
    require_both:     bool,
    name_only:        bool,
    already_assigned: set,
) -> list[int]:
    """
    Retourne les indices des items candidats pour une passe donnée.
    """
    if require_both:
        if not type_normalized:
            return []
        if ocr_level is not None:
            return [
                idx for idx in _search_index.get((type_normalized, ocr_level), set())
                if _item_list[idx][0].get("id") not in already_assigned
            ]
        return [
            idx for idx in _search_index.get((type_normalized, None), set())
            if _item_list[idx][0].get("id") not in already_assigned
        ]


# ══════════════════════════════════════════════════════════════════
#  DÉDUPLICATION
# ══════════════════════════════════════════════════════════════════

def deduplicate_results(results: list[dict]) -> list[dict]:
    """
    Élimine les doublons parmi les résultats OCR.
    Clé : (nom.lower(), type.lower(), niveau).
    En cas de doublon, conserve la capture la plus récente.
    """
    if not results:
        return results

    groups: dict[tuple, list[dict]] = {}
    for result in results:
        key = (
            (result.get("nom")  or "").strip().lower(),
            (result.get("type") or "").strip().lower(),
            result.get("niveau"),
        )
        groups.setdefault(key, []).append(result)

    deduplicated  = []
    removed_count = 0

    for key, group in groups.items():
        if len(group) == 1:
            deduplicated.append(group[0])
        else:
            group.sort(key=_extract_source_sequence_number, reverse=True)
            deduplicated.append(group[0])
            removed_count += len(group) - 1
            log.info(f"🔄 Doublon '{key[0]}' -- conservé {group[0].get('source', '?')}")

    if removed_count:
        log.info(f"🔄 {removed_count} doublon(s) supprimé(s), {len(deduplicated)} restants")

    return deduplicated


# ══════════════════════════════════════════════════════════════════
#  MATCHING MULTI-PASSES PRINCIPAL
# ══════════════════════════════════════════════════════════════════

def run_multipass_matching(ocr_results: list[dict]) -> None:
    """
    Associe chaque résultat OCR à un item du dictionnaire de référence.

    Modifie ocr_results en place.

    Étape 0 : correct_ocr_type() sur chaque résultat avant toutes les passes.
    """
    if not _item_list:
        log.warning("📚 Dictionnaire vide -- matching ignoré")
        return

    if not _index_built:
        build_search_index()

    start_time    = time.monotonic()
    assigned_ids: set = set()
    unresolved:   list[int] = list(range(len(ocr_results)))

    # ── Étape 0 : correction OCR des types ─────────────────────────
    corrections = 0
    for result in ocr_results:
        raw_type       = result.get("type") or ""
        corrected_type = correct_ocr_type(raw_type)
        if corrected_type != raw_type:
            result["type"] = corrected_type
            corrections   += 1

    if corrections:
        log.info(f"🏷️  {corrections} type(s) corrigé(s) avant matching")

    # ── Pré-calcul des chaînes normalisées ──────────────────────────
    precomputed: dict[int, dict] = {}
    for idx in unresolved:
        result       = ocr_results[idx]
        raw_name     = result.get("nom")  or ""
        raw_type     = result.get("type") or ""
        norm_name    = normalize(raw_name, strip_accents=False)
        norm_name_na = normalize(raw_name, strip_accents=True)
        norm_type    = normalize(raw_type, strip_accents=False)
        norm_type_na = normalize(raw_type, strip_accents=True)
        precomputed[idx] = {
            "name":     {False: norm_name,    True: norm_name_na},
            "type":     {False: norm_type,    True: norm_type_na},
            "name_len": {False: len(norm_name), True: len(norm_name_na)},
        }

    # ── Boucle sur les passes ───────────────────────────────────────
    for pass_number, (strip_accents, require_both, threshold, name_only) in \
            enumerate(_MATCHING_PASSES, start=1):

        if not unresolved:
            break

        elapsed = time.monotonic() - start_time
        if elapsed > MATCHING_TIMEOUT:
            log.warning(
                f"⏱ Matching timeout ({MATCHING_TIMEOUT}s) à la passe {pass_number} "
                f"-- {len(unresolved)} non résolus"
            )
            break

        newly_resolved: list[int] = []

        for idx in unresolved:
            if time.monotonic() - start_time > MATCHING_TIMEOUT:
                break

            result = ocr_results[idx]

            if result.get("id") is not None:
                newly_resolved.append(idx)
                continue

            pc           = precomputed[idx]
            ocr_name     = pc["name"][strip_accents]
            ocr_type     = pc["type"][strip_accents]
            ocr_level    = result.get("niveau")
            ocr_name_len = pc["name_len"][strip_accents]

            candidates = _get_candidates(
                ocr_type, ocr_level, require_both=True, name_only=False,
                already_assigned=assigned_ids,
            )
            if not candidates:
                continue

            best_index = -1
            best_score = -1.0

            for candidate_idx in candidates:
                entry = _item_list[candidate_idx]

                if entry[0].get("id") in assigned_ids:
                    continue

                candidate_name     = entry[2] if strip_accents else entry[1]
                candidate_name_len = len(candidate_name) if strip_accents else entry[3]

                if not _quick_length_ratio_check(ocr_name_len, candidate_name_len, threshold):
                    continue

                score = _compute_ratio(ocr_name, candidate_name)

                if score > best_score:
                    best_score = score
                    best_index = candidate_idx

                if best_score >= EARLY_EXIT_SCORE:
                    break

            if best_index >= 0 and best_score >= threshold:
                matched_item = _item_list[best_index][0]
                matched_id   = matched_item.get("id")
                assigned_ids.add(matched_id)

                french_name = (matched_item.get("name") or {}).get("fr", "")
                french_type = (matched_item.get("type") or {}).get("name", {}).get("fr", "")

                if result.get("nom") != french_name:
                    log.info(
                        f"  P{pass_number} [{best_score:.2f}]: "
                        f"'{result.get('nom')}' -> '{french_name}'"
                    )

                result["nom"]    = french_name or result.get("nom")
                result["type"]   = french_type or result.get("type")
                result["niveau"] = matched_item.get("level") or result.get("niveau")
                result["id"]     = matched_id
                newly_resolved.append(idx)

        if newly_resolved:
            resolved_set = set(newly_resolved)
            unresolved   = [i for i in unresolved if i not in resolved_set]

    # ── Rapport final ───────────────────────────────────────────────
    total_time = time.monotonic() - start_time
    resolved   = len(ocr_results) - len(unresolved)

    log.info(
        f"📚 Matching : {resolved}/{len(ocr_results)} résolus "
        f"en {total_time:.1f}s | {ratio_cache_info()}"
    )

    for idx in unresolved:
        if ocr_results[idx].get("id") is None:
            ocr_results[idx]["id"] = None


def _quick_length_ratio_check(len_a: int, len_b: int, threshold: float) -> bool:
    """
    Vérifie rapidement si deux chaînes peuvent atteindre le seuil de similarité.
    SequenceMatcher garantit ratio(a,b) <= 2*min(|a|,|b|) / (|a|+|b|).
    """
    if len_a == 0 or len_b == 0:
        return threshold <= 0.0
    return (2.0 * min(len_a, len_b)) / (len_a + len_b) >= threshold

