"""
image_processing.py — Nettoyage et préparation des images capturées
====================================================================
Responsabilité unique : prendre une image brute capturée depuis l'écran,
la recadrer selon la zone configurée, puis la déplacer dans un sous-dossier
daté.

Suppression vs version précédente :
    Le remplacement des couleurs dorées Dofus (replace_target_colors,
    _TARGET_COLORS_RGB, _COLOR_MIN, _COLOR_MAX, _COLOR_REPLACE) a été
    entièrement supprimé. L'inversion des couleurs est désormais faite
    dans ocr_engine.ocr_zone() (cv2.bitwise_not) au moment de l'OCR,
    sur la zone cible uniquement — pas sur l'image entière.

Dépendances internes :
    config.py      → CropConfig (zone de recadrage)
    text_utils.py  → extract_file_number (numérotation fichier)
"""

from __future__ import annotations

import logging
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from PIL import Image

from config import CropConfig
from text_utils import extract_file_number

log = logging.getLogger("DofusHDV")


# ══════════════════════════════════════════════════════════════════
#  CONSTANTES
# ══════════════════════════════════════════════════════════════════

# Extensions d'images acceptées par le pipeline
SUPPORTED_EXTENSIONS: tuple[str, ...] = (".png", ".jpg", ".jpeg", ".bmp")

# Zones à censurer (rectangles remplis en noir avant export).
CENSURE_ZONES: list[tuple[int, int, int, int]] = []


# ══════════════════════════════════════════════════════════════════
#  NETTOYAGE D'UNE IMAGE
# ══════════════════════════════════════════════════════════════════

def clean_single_image(
    source_path: str,
    output_dir:  str,
    crop:        Optional[CropConfig] = None,
) -> tuple[bool, str, str]:
    """
    Déplace une image capturée dans un sous-dossier daté.

    L'image est déjà à la bonne taille — mss a capturé exactement la zone
    définie par le crop. Aucun recadrage supplémentaire n'est appliqué.

    Étapes :
    1. Ouverture de l'image source
    2. Conversion RGB
    3. Application des zones de censure (CENSURE_ZONES) si définies
    4. Sauvegarde dans un fichier temporaire
    5. Déplacement dans output_dir/<date_modification>/
    6. Suppression du fichier source

    Args:
        source_path: Chemin absolu de l'image brute à traiter.
        output_dir:  Répertoire de sortie.
        crop:        Ignoré — conservé pour compatibilité de signature.

    Returns:
        Tuple (succès, message, chemin_destination).
    """
    source_filename = os.path.basename(source_path)
    clean_name      = extract_file_number(source_filename) + os.path.splitext(source_filename)[1]
    temp_path       = os.path.join(output_dir, f"temp_{clean_name}")

    try:
        with Image.open(source_path) as raw_image:
            image = raw_image.convert("RGB")

            if CENSURE_ZONES:
                from PIL import ImageDraw
                draw = ImageDraw.Draw(image)
                for zone in CENSURE_ZONES:
                    draw.rectangle(zone, fill="black")

            image.save(temp_path)

        modification_date = datetime.fromtimestamp(
            os.stat(source_path).st_mtime
        ).strftime("%Y-%m-%d")

        dated_dir = os.path.join(output_dir, modification_date)
        os.makedirs(dated_dir, exist_ok=True)

        destination_path = os.path.join(dated_dir, clean_name)
        shutil.move(temp_path, destination_path)
        os.remove(source_path)

        return True, f"✓ {clean_name} → {modification_date}/", destination_path

    except Exception as exc:
        try:
            os.remove(temp_path)
        except OSError:
            pass
        return False, f"✗ {source_filename}: {exc}", ""


# ══════════════════════════════════════════════════════════════════
#  UTILITAIRES
# ══════════════════════════════════════════════════════════════════

def is_supported_image(filename: str) -> bool:
    """
    Vérifie si un nom de fichier correspond à une image supportée.

    Args:
        filename: Nom de fichier (avec extension).

    Returns:
        True si l'extension est dans SUPPORTED_EXTENSIONS.
    """
    return Path(filename).suffix.lower() in SUPPORTED_EXTENSIONS


def is_temp_file(filename: str) -> bool:
    """
    Vérifie si un fichier est un fichier temporaire de traitement.

    Args:
        filename: Nom de fichier (basename uniquement).

    Returns:
        True si le fichier commence par "temp_".
    """
    return filename.startswith("temp_")
