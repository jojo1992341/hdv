"""
gui/benchmark.py — Fenêtre de benchmark OCR avec vs sans prétraitement
======================================================================
Responsabilité unique : comparer côte à côte les résultats OCR obtenus
avec le prétraitement standard (grayscale + THRESH_BINARY) et sans
prétraitement (image couleur directe).

Flux :
    1. L'utilisateur clique "🔬 Benchmark" dans un onglet
    2. BenchmarkWindow s'ouvre avec la liste des fichiers sources
    3. L'utilisateur choisit le scale et lance
    4. Deux pools parallèles tournent : ocr_*_image et ocr_*_image_raw
    5. Les résultats sont comparés champ par champ
    6. Un tableau affiche : source | champ | avec | sans | verdict
    7. Un résumé statistique est affiché en bas

Verdicts par champ :
    ✓ identique    : les deux versions produisent le même résultat
    ↑ amélioré     : la version sans prétraitement est meilleure
    ↓ dégradé      : la version sans prétraitement est moins bonne
    ~ différent    : les deux diffèrent sans qu'on puisse trancher
    ✗ tous vides   : les deux versions échouent
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ProcessPoolExecutor, as_completed
from multiprocessing import cpu_count
from pathlib import Path
from typing import Callable, Optional
import tkinter as tk
from tkinter import ttk

from ocr_engine import (
    ocr_resource_image,     ocr_equipment_image,
    ocr_resource_image_raw, ocr_equipment_image_raw,
    OCR_SCALE,
)
from config import get_config_manager

log = logging.getLogger("DofusHDV")


# ── Champs comparés selon le mode ──────────────────────────────────
_RESOURCE_FIELDS  = ["nom", "niveau", "type", "prix_moyen",
                     "prix_1", "prix_10", "prix_100", "prix_1000"]
_EQUIPMENT_FIELDS = ["nom", "niveau", "type", "prix_moyen", "prix"]


def _score(value) -> int:
    """Retourne 1 si la valeur est non nulle, 0 sinon."""
    return 0 if value is None or value == "" else 1


def _verdict(with_val, raw_val) -> str:
    """
    Calcule le verdict de comparaison pour un champ.

    Règles :
        identique  : mêmes valeurs (y compris deux None)
        amélioré   : raw a une valeur, with n'en a pas
        dégradé    : with a une valeur, raw n'en a pas
        différent  : les deux ont des valeurs différentes
        tous vides : les deux sont None/vide
    """
    w_empty = with_val is None or with_val == ""
    r_empty = raw_val  is None or raw_val  == ""

    if w_empty and r_empty:
        return "✗ vides"
    if str(with_val) == str(raw_val):
        return "✓"
    if w_empty and not r_empty:
        return "↑ raw+"
    if not w_empty and r_empty:
        return "↓ raw-"
    return "~ diff"


class BenchmarkWindow:
    """
    Fenêtre Toplevel de benchmark OCR avec vs sans prétraitement.

    Usage :
        BenchmarkWindow(
            parent=root,
            mode="ressources",
            source_paths=["/path/to/img1.png", ...],
            config_dict={...},
            workers=4,
        )
    """

    def __init__(
        self,
        parent:       tk.Widget,
        mode:         str,
        source_paths: list[str],
        config_dict:  dict,
        workers:      int,
    ) -> None:
        self._mode         = mode
        self._source_paths = source_paths
        self._config_dict  = config_dict
        self._workers      = workers

        # Fenêtre modale
        self._window = tk.Toplevel(parent)
        self._window.title(f"🔬 Benchmark OCR — {mode.capitalize()}")
        self._window.geometry("1200x700")
        self._window.transient(parent)
        self._window.grab_set()

        self._build_ui()
        self._window.after(200, self._run_benchmark)

    # ── Construction de l'interface ────────────────────────────────

    def _build_ui(self) -> None:
        """Construit le tableau comparatif et la barre de statut."""
        main = ttk.Frame(self._window, padding=10)
        main.pack(fill=tk.BOTH, expand=True)

        # ── En-tête ─────────────────────────────────────────────────
        header = ttk.Frame(main)
        header.pack(fill=tk.X, pady=(0, 8))

        ttk.Label(
            header,
            text=f"🔬 Benchmark — {self._mode.capitalize()} "
                 f"({len(self._source_paths)} image(s))",
            font=("Segoe UI", 12, "bold"),
        ).pack(side=tk.LEFT)

        self._status_label = ttk.Label(
            header, text="⏳ Lancement…", font=("Consolas", 9), foreground="gray"
        )
        self._status_label.pack(side=tk.RIGHT)

        # ── Tableau de résultats ────────────────────────────────────
        cols = ("source", "champ", "avec_pretraitement", "sans_pretraitement", "verdict")
        col_widths = {
            "source":             160,
            "champ":               90,
            "avec_pretraitement": 300,
            "sans_pretraitement": 300,
            "verdict":             80,
        }

        tree_frame = ttk.Frame(main)
        tree_frame.pack(fill=tk.BOTH, expand=True)

        self._tree = ttk.Treeview(
            tree_frame, columns=cols, show="headings", height=22
        )

        # Tags de couleur pour les verdicts
        self._tree.tag_configure("ok",   background="#003300", foreground="#aaffaa")
        self._tree.tag_configure("bad",  background="#330000", foreground="#ffaaaa")
        self._tree.tag_configure("diff", background="#332200", foreground="#ffddaa")
        self._tree.tag_configure("void", background="#1a1a2e", foreground="#666688")

        col_labels = {
            "source":             "Source",
            "champ":              "Champ",
            "avec_pretraitement": "Avec prétraitement",
            "sans_pretraitement": "Sans prétraitement",
            "verdict":            "Verdict",
        }
        for col in cols:
            self._tree.heading(col, text=col_labels[col])
            self._tree.column(
                col, width=col_widths[col], minwidth=60, anchor="w"
            )

        vsb = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL,   command=self._tree.yview)
        hsb = ttk.Scrollbar(tree_frame, orient=tk.HORIZONTAL, command=self._tree.xview)
        self._tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)

        self._tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        tree_frame.rowconfigure(0,    weight=1)
        tree_frame.columnconfigure(0, weight=1)

        # ── Résumé statistique ──────────────────────────────────────
        self._summary_frame = ttk.LabelFrame(main, text="📊 Résumé", padding=6)
        self._summary_frame.pack(fill=tk.X, pady=(8, 0))

        self._summary_label = ttk.Label(
            self._summary_frame,
            text="En attente des résultats…",
            font=("Consolas", 9),
        )
        self._summary_label.pack(anchor="w")

        # ── Bouton fermer ───────────────────────────────────────────
        ttk.Button(
            main, text="✗ Fermer", command=self._window.destroy
        ).pack(anchor="e", pady=(8, 0))

    # ── Exécution du benchmark ─────────────────────────────────────

    def _run_benchmark(self) -> None:
        """Lance les deux passes OCR dans un thread dédié."""
        threading.Thread(
            target=self._benchmark_thread,
            daemon=True,
            name=f"Benchmark-{self._mode}",
        ).start()

    def _benchmark_thread(self) -> None:
        """
        Exécute les deux OCR en parallèle et compare les résultats.

        Les deux fonctions (avec/sans) sont soumises au même pool pour
        maximiser l'utilisation CPU. Les résultats sont indexés par
        basename source pour la comparaison.
        """
        mode        = self._mode
        paths       = self._source_paths
        config_dict = self._config_dict
        workers     = self._workers

        ocr_with = ocr_resource_image     if mode == "ressources" else ocr_equipment_image
        ocr_raw  = ocr_resource_image_raw if mode == "ressources" else ocr_equipment_image_raw
        fields   = _RESOURCE_FIELDS       if mode == "ressources" else _EQUIPMENT_FIELDS

        results_with: dict[str, dict] = {}
        results_raw:  dict[str, dict] = {}

        total   = len(paths) * 2
        done    = 0

        def _update_status(msg: str) -> None:
            self._window.after(0, self._status_label.configure, {"text": msg})

        _update_status(f"⏳ 0 / {total} zones traitées…")

        with ProcessPoolExecutor(max_workers=workers) as pool:
            # Soumettre les deux séries en une seule fois
            futures_with = {
                pool.submit(ocr_with, p, config_dict): p for p in paths
            }
            futures_raw = {
                pool.submit(ocr_raw,  p, config_dict): p for p in paths
            }

            for future in as_completed({**futures_with, **futures_raw}):
                done += 1
                _update_status(f"⏳ {done} / {total} traitées…")

                path = futures_with.get(future) or futures_raw.get(future)
                key  = Path(path).name

                try:
                    result = future.result()
                    if result is None:
                        continue
                    if future in futures_with:
                        results_with[key] = result
                    else:
                        results_raw[key]  = result
                except Exception as exc:
                    log.warning(f"🔬 Benchmark erreur {Path(path).name}: {exc}")

        # Compiler toutes les sources trouvées
        all_sources = sorted(set(results_with) | set(results_raw))

        rows:     list[tuple] = []
        stats     = {"ok": 0, "bad": 0, "diff": 0, "void": 0}

        for source in all_sources:
            r_with = results_with.get(source, {})
            r_raw  = results_raw.get(source,  {})

            for field in fields:
                v_with = r_with.get(field)
                v_raw  = r_raw.get(field)
                v      = _verdict(v_with, v_raw)

                tag = "void"
                if v == "✓":
                    tag = "ok"
                    stats["ok"] += 1
                elif v in ("↑ raw+", "↓ raw-"):
                    tag = "bad" if v == "↓ raw-" else "diff"
                    stats["bad" if v == "↓ raw-" else "diff"] += 1
                elif v == "~ diff":
                    tag = "diff"
                    stats["diff"] += 1
                else:
                    stats["void"] += 1

                rows.append((
                    source,
                    field,
                    str(v_with) if v_with is not None else "",
                    str(v_raw)  if v_raw  is not None else "",
                    v,
                    tag,
                ))

        self._window.after(0, self._display_results, rows, stats, len(all_sources))

    def _display_results(
        self,
        rows:        list[tuple],
        stats:       dict[str, int],
        nb_sources:  int,
    ) -> None:
        """
        Affiche les résultats dans le Treeview et met à jour le résumé.

        Args:
            rows:       Liste de (source, champ, avec, sans, verdict, tag).
            stats:      Compteurs ok/bad/diff/void.
            nb_sources: Nombre de fichiers traités.
        """
        for row in rows:
            *values, tag = row
            self._tree.insert("", tk.END, values=values, tags=(tag,))

        total_fields = sum(stats.values())
        pct_ok       = 100 * stats["ok"]   / total_fields if total_fields else 0
        pct_bad      = 100 * stats["bad"]  / total_fields if total_fields else 0
        pct_diff     = 100 * stats["diff"] / total_fields if total_fields else 0
        pct_void     = 100 * stats["void"] / total_fields if total_fields else 0

        summary = (
            f"{nb_sources} image(s) — {total_fields} champs comparés   |   "
            f"✓ identiques : {stats['ok']} ({pct_ok:.0f}%)   "
            f"↑ raw meilleur : {stats['diff']} ({pct_diff:.0f}%)   "
            f"↓ raw moins bon : {stats['bad']} ({pct_bad:.0f}%)   "
            f"✗ vides : {stats['void']} ({pct_void:.0f}%)"
        )
        self._summary_label.configure(text=summary)
        self._status_label.configure(text=f"✅ Terminé — {nb_sources} image(s)")

        log.info(f"🔬 Benchmark terminé — {summary}")
