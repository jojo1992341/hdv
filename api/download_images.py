#!/usr/bin/env python3
"""
DOFUS RUNES — Téléchargeur d'icônes (parallèle)
=================================================
Lit recettes_dofus.json, télécharge toutes les icônes manquantes
en parallèle dans ./images/ et patche le JSON pour utiliser les
chemins locaux.

Usage :
    python3 download_images.py [--workers N] [--timeout N]

Exemples :
    python3 download_images.py
    python3 download_images.py --workers 64 --timeout 15

Prérequis : Python 3.10+. Aucune dépendance tierce.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse
import urllib.request
import urllib.error

# =============================================================================
# CONSTANTES
# =============================================================================

JSON_FILE  = "../json/recettes_dofus.json"
IMG_DIR    = Path("../images")
MAX_RETRY  = 3
BAR_WIDTH  = 38

# ── Codes couleurs ANSI ──────────────────────────────────────────────────────
#  Noms explicites pour éviter les variables à une lettre illisibles.
RESET  = "\033[0m"
GREEN  = "\033[92m"
YELLOW = "\033[93m"
RED    = "\033[91m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
DIM    = "\033[2m"

# =============================================================================
# ÉTAT THREAD-SAFE
# =============================================================================

@dataclass
class DownloadState:
    """
    Encapsule tous les compteurs de progression.
    Thread-safe via un verrou interne.
    """
    total:   int = 0
    done:    int = 0
    success: int = 0
    skipped: int = 0
    errors:  list[str] = field(default_factory=list)
    _lock:   threading.Lock = field(default_factory=threading.Lock, repr=False)

    def increment_skipped(self) -> None:
        with self._lock:
            self.done    += 1
            self.skipped += 1

    def increment_success(self) -> None:
        with self._lock:
            self.done    += 1
            self.success += 1

    def add_error(self, url: str) -> None:
        with self._lock:
            self.done += 1
            self.errors.append(url)

    def print_bar(self) -> None:
        """Affiche la barre de progression en ligne (écrase la ligne courante)."""
        pct    = self.done / self.total if self.total else 0
        filled = int(BAR_WIDTH * pct)
        bar    = "█" * filled + "░" * (BAR_WIDTH - filled)
        err_color = RED if self.errors else ""
        print(
            f"\r  [{bar}] {self.done:>5}/{self.total}  "
            f"{GREEN}{self.success} ✓{RESET}  "
            f"{DIM}{self.skipped} ↩{RESET}  "
            f"{err_color}{len(self.errors)} ✗{RESET}  ",
            end="", flush=True,
        )

# =============================================================================
# UTILITAIRES
# =============================================================================

def url_to_filename(url: str) -> str:
    """
    Dérive un nom de fichier local depuis une URL d'image.
    Utilise le basename de l'URL ; repli sur un hash MD5 si le basename
    est absent ou sans extension.

    >>> url_to_filename("https://example.com/images/95006-64.png")
    '95006-64.png'
    """
    name = Path(urlparse(url).path).name
    if not name or "." not in name:
        name = hashlib.md5(url.encode()).hexdigest()[:12] + ".png"
    return name

# =============================================================================
# TÉLÉCHARGEMENT
# =============================================================================

def download_one(url: str, dest: Path, timeout: int, state: DownloadState) -> tuple[str, bool]:
    """
    Télécharge une image vers `dest` avec jusqu'à MAX_RETRY tentatives.

    Saute le téléchargement si le fichier de destination existe déjà
    et est de taille valide (> 100 octets).

    Utilise une écriture atomique via un fichier temporaire `.tmp`
    pour éviter les fichiers corrompus en cas d'interruption.

    :param url:     URL de l'image à télécharger.
    :param dest:    Chemin de destination local.
    :param timeout: Timeout réseau en secondes.
    :param state:   État partagé pour la progression.
    :returns:       (url, succès).
    """
    # Cache hit
    if dest.exists() and dest.stat().st_size > 100:
        state.increment_skipped()
        state.print_bar()
        return url, True

    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; DofusRunesBot/2.0)",
        "Accept":     "image/webp,image/png,image/*,*/*",
    }

    for attempt in range(1, MAX_RETRY + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            if len(data) < 100:
                raise ValueError(f"Réponse trop courte ({len(data)} octets)")
            # Écriture atomique : .tmp → destination finale
            tmp = dest.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(dest)
            state.increment_success()
            state.print_bar()
            return url, True
        except Exception:
            if attempt < MAX_RETRY:
                time.sleep(0.3 * attempt)

    state.add_error(url)
    state.print_bar()
    return url, False

# =============================================================================
# COLLECTE DES URLS
# =============================================================================

def collect_urls(items: list[dict]) -> dict[str, str]:
    """
    Parcourt une liste d'items (équipements ou ressources) et collecte
    un dictionnaire url → nom_de_fichier_local.

    Gère deux cas :
      - Icône HTTP directe (cas standard, première exécution).
      - Icône déjà patchée en chemin local mais fichier manquant :
        utilise le champ ``icone_url`` sauvegardé lors du dernier patch.

    :param items: Liste d'équipements ou de ressources.
    :returns:     Dictionnaire {url: filename} des images à (re)télécharger.
    """
    url_map: dict[str, str] = {}

    for item in items:
        icone = item.get("icone", "").strip()
        if not icone:
            continue

        if icone.startswith("http"):
            url_map[icone] = url_to_filename(icone)
        else:
            # Déjà patché — fichier manquant : tenter de restaurer via icone_url
            local_path = Path(icone)
            if local_path.exists() and local_path.stat().st_size > 100:
                continue  # Fichier local OK, rien à faire

            original_url = item.get("icone_url", "").strip()
            if original_url.startswith("http"):
                url_map[original_url] = url_to_filename(original_url)

    return url_map

# =============================================================================
# PATCH DU JSON
# =============================================================================

def patch_items(items: list[dict], failed_urls: set[str]) -> int:
    """
    Remplace les URLs d'icône par les chemins locaux dans une liste d'items.
    Sauvegarde l'URL d'origine dans ``icone_url`` pour permettre la restauration.
    En cas d'échec du téléchargement, remet l'URL d'origine dans ``icone``.

    :param items:       Liste d'items à patcher (modifiée en place).
    :param failed_urls: Set des URLs dont le téléchargement a échoué.
    :returns:           Nombre d'items effectivement patchés.
    """
    patched = 0

    for item in items:
        old = item.get("icone", "").strip()
        if not old:
            continue

        if old.startswith("http"):
            fn   = url_to_filename(old)
            dest = IMG_DIR / fn
            if old not in failed_urls and dest.exists() and dest.stat().st_size > 100:
                item["icone_url"] = old
                item["icone"]     = str(dest).replace("\\", "/")
                patched += 1

        else:
            original_url = item.get("icone_url", "").strip()
            if not original_url.startswith("http"):
                continue
            fn   = url_to_filename(original_url)
            dest = IMG_DIR / fn
            if dest.exists() and dest.stat().st_size > 100:
                item["icone"] = str(dest).replace("\\", "/")
                patched += 1
            elif original_url in failed_urls:
                # Remettre l'URL pour que le prochain run la retente
                item["icone"] = original_url
                patched += 1

    return patched

# =============================================================================
# EXÉCUTION PRINCIPALE
# =============================================================================

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Télécharge les icônes DOFUS et patche recettes_dofus.json."
    )
    parser.add_argument("--workers", type=int, default=8,
                        help="Nombre de threads parallèles (défaut : 8)")
    parser.add_argument("--timeout", type=int, default=10,
                        help="Timeout réseau en secondes (défaut : 10)")
    args = parser.parse_args()

    # ── Chargement du JSON ───────────────────────────────────────────────────
    if not Path(JSON_FILE).exists():
        print(f"{RED}Erreur : {JSON_FILE} introuvable.{RESET}")
        sys.exit(1)

    IMG_DIR.mkdir(exist_ok=True)

    print(f"\n{BOLD}{CYAN}⚗  DOFUS RUNES — Téléchargeur d'icônes (parallèle){RESET}\n")
    print(f"  Lecture de {JSON_FILE}...", end=" ", flush=True)

    with open(JSON_FILE, encoding="utf-8") as f:
        data = json.load(f)

    print(f"{GREEN}OK{RESET}")

    equipements = data.get("equipements", [])
    ressources  = data.get("ressources",  [])

    # ── Collecte des URLs ────────────────────────────────────────────────────
    url_map = collect_urls(equipements + ressources)

    state        = DownloadState(total=len(url_map))
    cached       = sum(1 for fn in url_map.values()
                       if (IMG_DIR / fn).exists() and (IMG_DIR / fn).stat().st_size > 100)
    to_download  = state.total - cached

    print(f"  {BOLD}{state.total}{RESET} icônes  "
          f"({DIM}{cached} en cache{RESET}, {BOLD}{to_download} à télécharger{RESET})")
    print(f"  {BOLD}{args.workers}{RESET} workers  |  timeout {args.timeout}s")

    if to_download > 0:
        estimated = max(1, int(to_download * 80 / 1000 / args.workers))
        print(f"  Durée estimée : {BOLD}~{estimated}s{RESET}\n")
    else:
        print()

    # ── Téléchargement parallèle ─────────────────────────────────────────────
    t0 = time.perf_counter()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(download_one, url, IMG_DIR / fn, args.timeout, state): url
            for url, fn in url_map.items()
        }
        for _ in as_completed(futures):
            pass

    elapsed = time.perf_counter() - t0
    speed   = f"{to_download / elapsed:.0f} img/s" if elapsed > 0 and to_download > 0 else ""

    # Ligne de bilan finale
    print(f"\r  [{'█' * BAR_WIDTH}] {state.total:>5}/{state.total}  "
          f"{GREEN}{state.success} ✓{RESET}  "
          f"{DIM}{state.skipped} ↩{RESET}  "
          f"{RED if state.errors else ''}{len(state.errors)} ✗{RESET}  "
          f"{DIM}{speed}{RESET}          ")
    print(f"\n  Temps total : {BOLD}{elapsed:.1f}s{RESET}"
          + (f"  |  {BOLD}{speed}{RESET}" if speed else ""))

    if state.errors:
        print(f"\n  {YELLOW}⚠  {len(state.errors)} échec(s) :{RESET}")
        for e in state.errors[:10]:
            print(f"    {DIM}{e}{RESET}")
        if len(state.errors) > 10:
            print(f"    ... et {len(state.errors) - 10} de plus")
        print(f"  {DIM}Relancez le script pour réessayer.{RESET}")

    # ── Patch du JSON ────────────────────────────────────────────────────────
    print(f"\n  Mise à jour de {JSON_FILE}...", end=" ", flush=True)

    failed_urls     = set(state.errors)
    patched_equip   = patch_items(equipements, failed_urls)
    patched_res     = patch_items(ressources,  failed_urls)

    with open(JSON_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"{GREEN}OK{RESET}  ({patched_equip} équipements + {patched_res} ressources patchés)")
    print(f"\n{BOLD}{GREEN}  ✔  Terminé !{RESET}")
    print(f"  Icônes dans {BOLD}./{IMG_DIR}/{RESET}")
    print(f"  {DIM}Relancez après une mise à jour du JSON pour ne télécharger{RESET}")
    print(f"  {DIM}que les nouvelles icônes.{RESET}\n")


if __name__ == "__main__":
    main()
