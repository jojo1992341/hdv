"""
config.py — Configuration centrale de l'outil Dofus HDV
========================================================
Responsabilité unique : définir, charger et sauvegarder
la configuration des coordonnées de capture et d'OCR.

Simplification v2 :
    CaptureRegion a été supprimé. La région de capture (zone de l'écran
    à capturer avec mss) est désormais dérivée directement du CropConfig :
        left   = crop.x1
        top    = crop.y1
        width  = crop.width   (= crop.x2 - crop.x1)
        height = crop.height  (= crop.y2 - crop.y1)

    Le crop définit donc simultanément :
        - la position absolue de la popup sur l'écran (x1, y1)
        - les dimensions de la zone capturée (width, height)

    L'étape "Région capture" du wizard a été supprimée en conséquence.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

log = logging.getLogger("DofusHDV")

# ── Chemins ────────────────────────────────────────────────────────
BASE_DIR    = Path(__file__).parent
CONFIGS_DIR = BASE_DIR / "configs"
COORDS_FILE = CONFIGS_DIR / "coords.json"

# ── Coordonnées par défaut ─────────────────────────────────────────
DEFAULT_COORDS: dict = {
    "crop": [0, 0, 420, 420],
    "popup_rects": {
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
    },
    "equip_price_rects": [
        [131, 236, 283, 263],
        [131, 263, 283, 288],
    ],
    "capture": {
        "color_tolerance_pct": 50,
        "click_delay": 0.5,
        "debounce": 0.3,
    },
}


# ══════════════════════════════════════════════════════════════════
#  DATACLASSES DE CONFIGURATION
# ══════════════════════════════════════════════════════════════════

@dataclass
class CropConfig:
    """
    Zone de recadrage ET position de capture sur l'écran.

    x1, y1 : coordonnées absolues du coin supérieur gauche sur l'écran.
    x2, y2 : coordonnées absolues du coin inférieur droit sur l'écran.

    La région mss est dérivée directement :
        left=x1, top=y1, width=x2-x1, height=y2-y1
    """
    x1: int = 0
    y1: int = 0
    x2: int = 420
    y2: int = 420

    @property
    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.x1, self.y1, self.x2, self.y2)

    @property
    def width(self) -> int:
        return self.x2 - self.x1

    @property
    def height(self) -> int:
        return self.y2 - self.y1

    @property
    def size(self) -> tuple[int, int]:
        return (self.width, self.height)

    def to_mss_region(self) -> dict:
        """Retourne la région au format mss {'left','top','width','height'}."""
        return {
            "left":   self.x1,
            "top":    self.y1,
            "width":  self.width,
            "height": self.height,
        }

    def to_list(self) -> list[int]:
        return [self.x1, self.y1, self.x2, self.y2]

    @classmethod
    def from_list(cls, values: list[int]) -> "CropConfig":
        return cls(x1=values[0], y1=values[1], x2=values[2], y2=values[3])


@dataclass
class CaptureConfig:
    """
    Paramètres de la capture automatique post-clic.
    La région n'est plus stockée ici — elle est dérivée du CropConfig.
    """
    color_tolerance_pct: int   = 50   # conservé pour compatibilité config existante
    click_delay:         float = 0.5
    debounce:            float = 0.3

    def to_dict(self) -> dict:
        return {
            "color_tolerance_pct": self.color_tolerance_pct,
            "click_delay":         self.click_delay,
            "debounce":            self.debounce,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "CaptureConfig":
        return cls(
            color_tolerance_pct=data.get("color_tolerance_pct", 50),
            click_delay=data.get("click_delay", 0.5),
            debounce=data.get("debounce", 0.3),
        )

    def update(
        self,
        tolerance_pct: Optional[int]   = None,
        click_delay:   Optional[float] = None,
        debounce:      Optional[float] = None,
    ) -> None:
        if tolerance_pct is not None:
            self.color_tolerance_pct = tolerance_pct
        if click_delay is not None:
            self.click_delay = click_delay
        if debounce is not None:
            self.debounce = debounce


@dataclass
class ZoneRect:
    """Rectangle de lecture OCR pour un champ donné (x1, y1, x2, y2)."""
    x1: int
    y1: int
    x2: int
    y2: int

    @property
    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.x1, self.y1, self.x2, self.y2)

    def to_list(self) -> list[int]:
        return [self.x1, self.y1, self.x2, self.y2]

    @classmethod
    def from_list(cls, values: list[int]) -> "ZoneRect":
        return cls(x1=values[0], y1=values[1], x2=values[2], y2=values[3])


@dataclass
class LotRect:
    """Paire de zones OCR pour un lot : quantité + prix."""
    lot:  ZoneRect
    prix: ZoneRect

    def to_dict(self) -> dict:
        return {
            "lot":  self.lot.to_list(),
            "prix": self.prix.to_list(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LotRect":
        return cls(
            lot=ZoneRect.from_list(data["lot"]),
            prix=ZoneRect.from_list(data["prix"]),
        )


@dataclass
class PopupRects:
    """Zones de lecture OCR dans la popup HDV."""
    nom:        ZoneRect
    niveau:     ZoneRect
    type_item:  ZoneRect
    prix_moyen: ZoneRect
    lots:       list[LotRect] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "nom":        self.nom.to_list(),
            "niveau":     self.niveau.to_list(),
            "type":       self.type_item.to_list(),
            "prix_moyen": self.prix_moyen.to_list(),
            "lots":       [lot.to_dict() for lot in self.lots],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "PopupRects":
        return cls(
            nom=ZoneRect.from_list(data["nom"]),
            niveau=ZoneRect.from_list(data["niveau"]),
            type_item=ZoneRect.from_list(data["type"]),
            prix_moyen=ZoneRect.from_list(data["prix_moyen"]),
            lots=[LotRect.from_dict(lot) for lot in data.get("lots", [])],
        )


# ══════════════════════════════════════════════════════════════════
#  VALEURS PAR DÉFAUT
# ══════════════════════════════════════════════════════════════════

def _build_default_popup_rects() -> PopupRects:
    return PopupRects(
        nom=ZoneRect(83, 70, 380, 91),
        niveau=ZoneRect(83, 94, 143, 108),
        type_item=ZoneRect(145, 94, 380, 108),
        prix_moyen=ZoneRect(169, 115, 244, 128),
        lots=[
            LotRect(lot=ZoneRect(60, 250, 165, 272),  prix=ZoneRect(180, 250, 290, 272)),
            LotRect(lot=ZoneRect(60, 282, 165, 312),  prix=ZoneRect(180, 282, 290, 312)),
            LotRect(lot=ZoneRect(60, 322, 165, 352),  prix=ZoneRect(180, 322, 290, 352)),
            LotRect(lot=ZoneRect(60, 362, 165, 383),  prix=ZoneRect(180, 362, 290, 383)),
        ],
    )

def _build_default_equip_price_rects() -> list[ZoneRect]:
    return [
        ZoneRect(131, 236, 283, 263),
        ZoneRect(131, 263, 283, 288),
    ]


# ══════════════════════════════════════════════════════════════════
#  CONFIGURATION GLOBALE DE L'APPLICATION
# ══════════════════════════════════════════════════════════════════

@dataclass
class AppConfig:
    """
    Configuration complète de l'application.
    Point d'accès unique — remplace toutes les variables globales mutables.
    """
    crop:               CropConfig    = field(default_factory=CropConfig)
    capture:            CaptureConfig = field(default_factory=CaptureConfig)
    popup_rects:        PopupRects    = field(default_factory=_build_default_popup_rects)
    equip_price_rects:  list[ZoneRect] = field(default_factory=_build_default_equip_price_rects)

    def to_dict(self) -> dict:
        return {
            "crop":              self.crop.to_list(),
            "popup_rects":       self.popup_rects.to_dict(),
            "equip_price_rects": [rect.to_list() for rect in self.equip_price_rects],
            "capture":           self.capture.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "AppConfig":
        return cls(
            crop=CropConfig.from_list(data.get("crop", [0, 0, 420, 420])),
            capture=CaptureConfig.from_dict(data.get("capture", {})),
            popup_rects=PopupRects.from_dict(
                data.get("popup_rects", _build_default_popup_rects().to_dict())
            ),
            equip_price_rects=[
                ZoneRect.from_list(r)
                for r in data.get("equip_price_rects", [])
            ] or _build_default_equip_price_rects(),
        )

    @classmethod
    def default(cls) -> "AppConfig":
        return cls()


# ══════════════════════════════════════════════════════════════════
#  GESTIONNAIRE DE CONFIGURATION
# ══════════════════════════════════════════════════════════════════

class ConfigManager:
    """
    Gère la persistance de la configuration sur disque.
    Instance unique partagée dans l'application via get_config_manager().
    """

    def __init__(self, coords_file: Path = COORDS_FILE) -> None:
        self._file      = coords_file
        self._config    = AppConfig.default()
        self._is_loaded = False

    @property
    def config(self) -> AppConfig:
        return self._config

    @property
    def is_loaded_from_file(self) -> bool:
        return self._is_loaded

    def load(self) -> bool:
        if self._file.exists():
            try:
                with self._file.open(encoding="utf-8") as fh:
                    data = json.load(fh)
                self._config    = AppConfig.from_dict(data)
                self._is_loaded = True
                log.info(f"📐 Coordonnées chargées depuis {self._file}")
                return True
            except Exception as exc:
                log.warning(f"📐 Erreur de lecture ({self._file}): {exc} — défauts appliqués")

        self._config    = AppConfig.default()
        self._is_loaded = False
        return False

    def save(self, config: Optional[AppConfig] = None) -> None:
        if config is not None:
            self._config = config

        self._file.parent.mkdir(parents=True, exist_ok=True)
        with self._file.open("w", encoding="utf-8") as fh:
            json.dump(self._config.to_dict(), fh, ensure_ascii=False, indent=2)

        log.info(f"📐 Configuration sauvegardée dans {self._file}")

    def apply(self, data: dict) -> None:
        self._config = AppConfig.from_dict(data)
        self.save()

    def load_raw(self) -> dict:
        if self._file.exists():
            try:
                with self._file.open(encoding="utf-8") as fh:
                    return json.load(fh)
            except Exception:
                pass
        return self._config.to_dict()


# ══════════════════════════════════════════════════════════════════
#  INSTANCE PARTAGÉE (SINGLETON LÉGER)
# ══════════════════════════════════════════════════════════════════

_config_manager: Optional[ConfigManager] = None


def get_config_manager() -> ConfigManager:
    global _config_manager
    if _config_manager is None:
        _config_manager = ConfigManager()
    return _config_manager


def get_config() -> AppConfig:
    return get_config_manager().config


def save_coords(data: dict) -> None:
    get_config_manager().apply(data)


def _apply_coords(data: dict) -> None:
    get_config_manager()._config = AppConfig.from_dict(data)


# ══════════════════════════════════════════════════════════════════
#  CHEMINS DES DICTIONNAIRES
# ══════════════════════════════════════════════════════════════════

DICT_PATHS_FILE = CONFIGS_DIR / "dict_paths.json"
DICT_MODES = ("ressources", "equipements")


def load_dict_paths() -> dict[str, str]:
    defaults: dict[str, str] = {mode: "" for mode in DICT_MODES}
    if DICT_PATHS_FILE.exists():
        try:
            with DICT_PATHS_FILE.open(encoding="utf-8") as fh:
                saved = json.load(fh)
            for mode in DICT_MODES:
                if mode in saved and isinstance(saved[mode], str):
                    defaults[mode] = saved[mode]
        except Exception as exc:
            log.warning(f"📂 Erreur lecture dict_paths.json : {exc}")
    return defaults


def save_dict_path(mode: str, path: str) -> None:
    if mode not in DICT_MODES:
        log.warning(f"📂 Mode inconnu pour save_dict_path : '{mode}'")
        return
    current = load_dict_paths()
    current[mode] = path
    try:
        DICT_PATHS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with DICT_PATHS_FILE.open("w", encoding="utf-8") as fh:
            json.dump(current, fh, ensure_ascii=False, indent=2)
        log.info(f"📂 Chemin dict [{mode}] sauvegardé")
    except Exception as exc:
        log.error(f"📂 Erreur sauvegarde dict_paths.json : {exc}")


# ══════════════════════════════════════════════════════════════════
#  CHEMINS DES FICHIERS DE RÉSULTATS
# ══════════════════════════════════════════════════════════════════

OUTPUT_PATHS_FILE = CONFIGS_DIR / "output_paths.json"

DEFAULT_OUTPUT_NAMES: dict[str, str] = {
    "ressources":  "Ressources_resultats.json",
    "equipements": "Equipements_résultats.json",
}


def load_output_paths() -> dict[str, str]:
    defaults: dict[str, str] = dict(DEFAULT_OUTPUT_NAMES)
    if OUTPUT_PATHS_FILE.exists():
        try:
            with OUTPUT_PATHS_FILE.open(encoding="utf-8") as fh:
                saved = json.load(fh)
            for mode in DICT_MODES:
                if mode in saved and isinstance(saved[mode], str) and saved[mode]:
                    defaults[mode] = saved[mode]
        except Exception as exc:
            log.warning(f"📂 Erreur lecture output_paths.json : {exc}")
    return defaults


def save_output_path(mode: str, path: str) -> None:
    if mode not in DICT_MODES:
        log.warning(f"📂 Mode inconnu pour save_output_path : '{mode}'")
        return
    current = load_output_paths()
    current[mode] = path
    try:
        OUTPUT_PATHS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with OUTPUT_PATHS_FILE.open("w", encoding="utf-8") as fh:
            json.dump(current, fh, ensure_ascii=False, indent=2)
        log.info(f"📂 Chemin résultats [{mode}] sauvegardé")
    except Exception as exc:
        log.error(f"📂 Erreur sauvegarde output_paths.json : {exc}")
