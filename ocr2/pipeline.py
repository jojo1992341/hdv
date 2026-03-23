"""
pipeline.py — Pipeline de surveillance et traitement continu des images HDV
============================================================================
Responsabilité unique : orchestrer la boucle de surveillance d'un dossier,
le nettoyage des images capturées, leur OCR en parallèle, puis le matching
des résultats contre le dictionnaire de référence.

Optimisation principale vs hdv-v10.py :
    L'original créait un ProcessPoolExecutor NEUF à chaque batch
    (appel _clean() puis _ocr()). Chaque création forke N processus,
    initialise leurs imports, charge leurs modules — overhead O(batch).

    Ici, le pool est créé UNE SEULE FOIS au start() et détruit au stop().
    Entre deux batchs, les workers sont en attente — pas de fork, pas
    de rechargement de modules. Gain particulièrement sensible quand
    les batchs sont petits (1–3 images), cas typique de la capture auto.

Cycle de vie du pipeline :
    start()  → charge dict → crée pool → lance thread _run_loop()
    _run_loop() → scan → clean (pool) → ocr (pool) → repeat
    stop()   → signal arrêt → attend fin → matching → on_stopped()
    cleanup()→ shutdown pool (sécurité atexit)

Thread-safety :
    _results et _seen sont protégés par _results_lock.
    _stats_* sont des compteurs atomiques (GIL Python suffit sur int).
    Le pool est accédé depuis _run_loop() uniquement (thread unique).

Dépendances internes :
    config.py            → ConfigManager.load_raw() (dict picklable)
    image_processing.py  → clean_single_image, is_supported_image, is_temp_file
    ocr_engine.py        → ocr_resource_image, ocr_equipment_image
    matching.py          → load_item_dictionary, run_multipass_matching,
                           deduplicate_results, build_search_index
"""

from __future__ import annotations

import atexit
import logging
import os
import time
import threading
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime
from multiprocessing import cpu_count
from pathlib import Path
from typing import Any, Callable, Optional

from config import get_config_manager, CropConfig, save_dict_path
from image_processing import (
    clean_single_image,
    is_supported_image,
    is_temp_file,
)
from ocr_engine import ocr_resource_image, ocr_equipment_image
import matching as _matching_module
from matching import (
    load_item_dictionary,
    run_multipass_matching,
    deduplicate_results,
    build_search_index,
)

log = logging.getLogger("DofusHDV")

# Limite du parallélisme OCR indépendamment du nombre de CPU
MAX_OCR_WORKERS: int = 4

# Délai d'attente en secondes avant de lire la taille d'un fichier
# une seconde fois — s'assure que l'écriture est terminée
_FILE_STABILITY_DELAY: float = 0.15


# ══════════════════════════════════════════════════════════════════
#  PIPELINE CONTINU
# ══════════════════════════════════════════════════════════════════

class ContinuousPipeline:
    """
    Pipeline de traitement continu des captures HDV.

    Surveille un dossier source à intervalle régulier, nettoie les
    nouvelles images trouvées, les soumet à l'OCR en parallèle, puis
    réalise le matching fuzzy contre le dictionnaire de référence.

    Le pool de workers multiprocessing est maintenu en vie entre les
    batchs pour éviter le surcoût de fork répété.

    Usage :
        pipeline = ContinuousPipeline(
            source_dir="~/Screenshots",
            dict_path="json/cache/ressources.json",
            max_workers=4,
            mode="ressources",
            on_image_ocr=lambda r: print(r),
            on_stopped=lambda results: export(results),
        )
        pipeline.start()
        # ... (surveillance en arrière-plan)
        pipeline.stop()
    """

    __slots__ = (
        "source_dir", "dict_path", "max_workers", "poll_interval", "mode",
        "on_image_ocr", "on_status", "on_stopped",
        "_stop_event", "_thread", "_pool",
        "_results", "_results_lock", "_seen",
        "_stats_cleaned", "_stats_ocr", "_stats_duplicates", "_start_time",
        "_config_dict", "_crop",
    )

    def __init__(
        self,
        source_dir:    str,
        dict_path:     str,
        max_workers:   int,
        poll_interval: float                        = 2.0,
        mode:          str                          = "ressources",
        on_image_ocr:  Optional[Callable[[dict], None]]       = None,
        on_status:     Optional[Callable[[str], None]]        = None,
        on_stopped:    Optional[Callable[[list[dict]], None]] = None,
    ) -> None:
        """
        Args:
            source_dir:    Dossier surveillé (nouvelles captures déposées ici).
            dict_path:     Chemin vers le fichier JSON du dictionnaire Dofus.
            max_workers:   Nombre maximum de workers parallèles.
            poll_interval: Délai en secondes entre deux scans du dossier.
            mode:          "ressources" ou "equipements".
            on_image_ocr:  Callback appelé après chaque OCR réussi.
            on_status:     Callback de mise à jour du label de statut GUI.
            on_stopped:    Callback appelé avec les résultats finaux après arrêt.
        """
        self.source_dir    = source_dir
        self.dict_path     = dict_path
        self.max_workers   = max_workers
        self.poll_interval = poll_interval
        self.mode          = mode
        self.on_image_ocr  = on_image_ocr
        self.on_status     = on_status
        self.on_stopped    = on_stopped

        # Synchronisation
        self._stop_event    = threading.Event()
        self._thread:  Optional[threading.Thread] = None
        self._pool:    Optional[ProcessPoolExecutor] = None

        # Résultats et état
        self._results:       list[dict] = []
        self._results_lock   = threading.Lock()
        self._seen:          set[str]   = set()

        # Statistiques
        self._stats_cleaned:    int = 0
        self._stats_ocr:        int = 0
        self._stats_duplicates: int = 0
        self._start_time: Optional[datetime] = None

        # Configuration (chargée au start — dict brut picklable)
        self._config_dict: dict = {}
        self._crop: CropConfig  = CropConfig()

    # ── Propriétés publiques ───────────────────────────────────────

    @property
    def is_running(self) -> bool:
        """True si le thread de surveillance est actif."""
        return self._thread is not None and self._thread.is_alive()

    @property
    def results(self) -> list[dict]:
        """Copie thread-safe des résultats accumulés."""
        with self._results_lock:
            return list(self._results)

    @property
    def stats(self) -> dict[str, Any]:
        """Statistiques courantes du pipeline."""
        elapsed = (
            (datetime.now() - self._start_time).total_seconds()
            if self._start_time else 0.0
        )
        return {
            "cleaned":    self._stats_cleaned,
            "ocr":        self._stats_ocr,
            "duplicates": self._stats_duplicates,
            "elapsed":    elapsed,
        }

    @property
    def mode_label(self) -> str:
        """Libellé lisible du mode courant."""
        return "Ressources" if self.mode == "ressources" else "Équipements"

    # ── Cycle de vie ───────────────────────────────────────────────

    def start(self) -> None:
        """
        Démarre le pipeline :
            1. Réinitialise l'état interne
            2. Charge le dictionnaire de matching
            3. Crée le pool de workers persistant
            4. Lance le thread de surveillance en arrière-plan

        Sans effet si le pipeline est déjà en cours.
        """
        if self.is_running:
            return

        # Réinitialisation
        self._stop_event.clear()
        with self._results_lock:
            self._results.clear()
        self._seen.clear()
        self._stats_cleaned    = 0
        self._stats_ocr        = 0
        self._stats_duplicates = 0
        self._start_time       = datetime.now()

        # Chargement de la configuration (dict brut — picklable par les workers)
        self._config_dict = get_config_manager().load_raw()
        crop_list         = self._config_dict.get("crop", [0, 0, 420, 420])
        self._crop        = CropConfig.from_list(crop_list)

        # Chargement du dictionnaire de matching
        dict_resolved = Path(self.dict_path).resolve() if self.dict_path else None
        if not dict_resolved:
            log.warning("📚 Aucun chemin de dictionnaire fourni — matching désactivé")
        elif not dict_resolved.exists():
            log.warning(f"📚 Dictionnaire introuvable : '{dict_resolved}' — matching désactivé")
        else:
            try:
                count = load_item_dictionary(str(dict_resolved))
                build_search_index()
                log.info(f"📚 Dictionnaire OK : {count} items chargés depuis {dict_resolved}")
                save_dict_path(self.mode, str(dict_resolved))
            except Exception as exc:
                log.error(f"📚 Erreur chargement dictionnaire : {exc}")

        # Création du pool persistant
        # max_workers borné par MAX_OCR_WORKERS et le nombre de CPU
        effective_workers = min(self.max_workers, MAX_OCR_WORKERS, cpu_count())
        self._pool = ProcessPoolExecutor(max_workers=effective_workers)
        atexit.register(self._shutdown_pool)

        # Lancement du thread de surveillance
        self._thread = threading.Thread(
            target=self._run_loop, daemon=True, name=f"Pipeline-{self.mode}"
        )
        self._thread.start()

    def stop(self) -> None:
        """
        Demande l'arrêt du pipeline.
        Le thread finit son batch en cours, puis exécute le matching final
        avant d'appeler on_stopped(). L'appel est non-bloquant.
        """
        if not self.is_running:
            return
        log.info(f"⏹ [{self.mode_label}] Arrêt demandé…")
        if self.on_status:
            self.on_status("Arrêt + matching…")
        self._stop_event.set()

    def cleanup(self) -> None:
        """
        Arrêt forcé du pool — à appeler à la fermeture de l'application.
        Enregistré automatiquement via atexit.register().
        """
        self._shutdown_pool()

    def _shutdown_pool(self) -> None:
        """Ferme le pool de workers proprement."""
        if self._pool is not None:
            try:
                self._pool.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
            finally:
                self._pool = None

    # ── Boucle principale ──────────────────────────────────────────

    def _run_loop(self) -> None:
        """
        Boucle de surveillance exécutée dans le thread dédié.

        Cycle : scan → clean → ocr → attendre poll_interval → repeat.
        S'arrête dès que _stop_event est positionné.
        """
        log.info(f"🚀 [{self.mode_label}] Surveillance de {self.source_dir}")
        if self.on_status:
            self.on_status(f"🔄 [{self.mode_label}]")

        while not self._stop_event.is_set():
            new_files = self._scan_for_new_files()

            if new_files:
                log.info(f"📥 [{self.mode_label}] {len(new_files)} nouvelle(s) image(s)")
                cleaned_paths = self._clean_images(new_files)

                if cleaned_paths and not self._stop_event.is_set():
                    self._run_ocr(cleaned_paths)

                if self.on_status:
                    self.on_status(f"🔄 [{self.mode_label}] {self._stats_ocr}")
            else:
                if self.on_status:
                    self.on_status(f"👁 [{self.mode_label}] {self._stats_ocr}")

            self._stop_event.wait(timeout=self.poll_interval)

        self._finalize()

    # ── Scan du dossier ────────────────────────────────────────────

    def _scan_for_new_files(self) -> list[str]:
        """
        Scanne le dossier source pour trouver les nouvelles images.

        Filtre :
            - Fichiers image supportés uniquement
            - Pas les fichiers temporaires (temp_*)
            - Pas les fichiers déjà traités (_seen)
            - Taille > 0 et stable (double lecture avec délai)

        Returns:
            Liste de chemins absolus stables et non encore vus.
        """
        try:
            candidates: list[tuple[str, int]] = []

            for entry in os.scandir(self.source_dir):
                if not entry.is_file():
                    continue
                if not is_supported_image(entry.name):
                    continue
                if is_temp_file(entry.name):
                    continue
                if entry.path in self._seen:
                    continue

                try:
                    size = entry.stat().st_size
                    if size > 0:
                        candidates.append((entry.path, size))
                except OSError:
                    continue

        except OSError:
            return []

        if not candidates:
            return []

        # Double lecture pour s'assurer que l'écriture est terminée
        time.sleep(_FILE_STABILITY_DELAY)

        stable_files = []
        for path, original_size in candidates:
            try:
                if os.path.getsize(path) == original_size:
                    stable_files.append(path)
            except OSError:
                continue

        return stable_files

    # ── Nettoyage (pool persistant) ────────────────────────────────

    def _clean_images(self, file_paths: list[str]) -> list[str]:
        """
        Nettoie les images brutes en parallèle via le pool persistant.

        Chaque image est nettoyée par clean_single_image() dans un worker :
            - Remplacement des couleurs dorées
            - Recadrage selon CropConfig
            - Déplacement dans un sous-dossier daté

        Args:
            file_paths: Chemins des images brutes à nettoyer.

        Returns:
            Chemins des images nettoyées, prêtes pour l'OCR.
        """
        if self._pool is None:
            return []

        cleaned_paths: list[str] = []
        crop_tuple = self._crop.as_tuple

        futures = {
            self._pool.submit(clean_single_image, fp, self.source_dir, self._crop): fp
            for fp in file_paths
        }

        for future in as_completed(futures):
            source_path = futures[future]

            if self._stop_event.is_set():
                # Annuler les futures restantes sans détruire le pool
                for pending in futures:
                    pending.cancel()
                break

            # Marquer comme vu même en cas d'échec (évite re-traitement infini)
            self._seen.add(source_path)

            try:
                success, message, destination = future.result()
                if success:
                    self._stats_cleaned += 1
                    cleaned_paths.append(destination)
                    log.info(f"🧹 {message}")
                else:
                    log.warning(f"🧹 {message}")
            except Exception as exc:
                log.error(f"🧹 Erreur nettoyage {os.path.basename(source_path)}: {exc}")

        return cleaned_paths

    # ── OCR (pool persistant) ──────────────────────────────────────

    def _run_ocr(self, image_paths: list[str]) -> None:
        """
        Lance l'OCR en parallèle sur les images nettoyées via le pool persistant.

        Sélectionne la fonction OCR selon le mode (ressources / equipements).
        Les résultats sont ajoutés à _results de façon thread-safe et le
        callback on_image_ocr est appelé pour chaque résultat valide.

        Args:
            image_paths: Chemins des images nettoyées à analyser.
        """
        if self._pool is None:
            return

        # Sélection de la fonction OCR (doit rester picklable — niveau module)
        ocr_function = (
            ocr_resource_image
            if self.mode == "ressources"
            else ocr_equipment_image
        )
        config_dict = self._config_dict

        futures = {
            self._pool.submit(ocr_function, path, config_dict): path
            for path in image_paths
        }

        for future in as_completed(futures):
            image_path = futures[future]

            if self._stop_event.is_set():
                for pending in futures:
                    pending.cancel()
                break

            try:
                result = future.result()

                if result is not None:
                    self._stats_ocr += 1
                    with self._results_lock:
                        self._results.append(result)

                    log.info(
                        f"🔍 [{self._stats_ocr}] {result['source']} "
                        f"→ {result.get('nom', '?')}"
                    )

                    if self.on_image_ocr:
                        self.on_image_ocr(result)
                else:
                    log.warning(
                        f"🔍 {os.path.basename(image_path)} ignorée "
                        f"(OCR vide ou taille invalide)"
                    )

            except Exception as exc:
                log.error(
                    f"🔍 Erreur OCR {os.path.basename(image_path)}: {exc}"
                )

    # ── Finalisation ───────────────────────────────────────────────

    def _finalize(self) -> None:
        """
        Exécute le matching final après arrêt du pipeline.

        Étapes :
            1. Dédoublonnage des résultats
            2. Matching fuzzy multi-passes si dictionnaire chargé
            3. Fermeture du pool de workers
            4. Appel du callback on_stopped()
        """
        label = self.mode_label

        if self.on_status:
            self.on_status(f"🔄 [{label}] Dédoublonnage + Matching…")

        with self._results_lock:
            results = list(self._results)

        # Dédoublonnage
        count_before           = len(results)
        results                = deduplicate_results(results)
        self._stats_duplicates = count_before - len(results)

        # Matching fuzzy si dictionnaire disponible
        item_count = len(_matching_module._item_list)
        if item_count == 0:
            log.warning(f"📚 [{label}] Dictionnaire vide — matching ignoré (vérifiez le chemin du dict)")
        elif not results:
            log.info(f"📚 [{label}] Aucun résultat à matcher")
        else:
            log.info(f"📚 [{label}] Matching de {len(results)} résultat(s) contre {item_count} items…")
            results.sort(key=lambda r: r.get("source", ""))
            for result in results:
                result["id"] = None
            run_multipass_matching(results)

        # Mise à jour des résultats finaux
        with self._results_lock:
            self._results = results

        # Fermeture du pool
        self._shutdown_pool()

        # Rapport
        elapsed = (
            (datetime.now() - self._start_time).total_seconds()
            if self._start_time else 0.0
        )
        log.info(
            f"✅ [{label}] {elapsed:.1f}s — "
            f"{self._stats_cleaned}🧹 "
            f"{self._stats_duplicates}🔄 "
            f"{len(results)}🔍"
        )

        if self.on_stopped:
            self.on_stopped(results)
