"""
gui/app.py — Interface principale de l'outil Dofus HDV
=======================================================
Responsabilité unique : construire et piloter la fenêtre principale
tkinter, connecter les widgets aux pipelines de traitement et gérer
les interactions utilisateur.

Séparation stricte :
    Thread UI     : tkinter mainloop + callbacks root.after()
    Thread métier : ContinuousPipeline (thread daemon interne)
    Thread rerun  : _rerun_ocr() — pool temporaire hors pipeline
    Jamais de traitement lourd dans le thread UI.

Fonctionnalités v2 :
    - Spinbox Scale OCR (1–4) + bouton Valider pour CPU et scale
    - Tri des colonnes Treeview par clic sur l'en-tête (asc/desc)
    - Suppression de lignes sélectionnées (bouton + touche Delete)
    - Relance OCR sur les résultats restants avec un scale différent

Renommages vs hdv-v10.py :
    _build        → _build_ui
    _btab         → _build_tab
    _setup_log    → _setup_log_handler
    _bsrc         → _browse_source_dir
    _bf           → _browse_dict_file
    _bs           → _browse_output_file
    _mcap         → _manual_capture
    _on_cap       → _on_capture_done
    _ucap         → _update_capture_status
    _open_wiz     → _open_wizard
    _wdone        → _on_wizard_done
    _rv           → _row_values
    _utt          → _update_tab_title
    _start        → _start_pipeline
    _stop         → _stop_pipeline
    _scap         → _stop_capture
    _ar           → _add_result
    _fin          → _on_pipeline_done
    _exp          → _export_results
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime
from multiprocessing import cpu_count
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext
import tkinter as tk
from tkinter import ttk
from typing import Optional

from PIL import Image

from capture import ClickCapture
from config import (
    get_config_manager, get_config,
    load_dict_paths, load_output_paths, save_output_path,
)
from gui.widgets import TextHandler, ZoomableCanvas
from gui.wizard import CoordinatesWizard
from ocr_engine import (
    ocr_resource_image, ocr_equipment_image,
    OCR_SCALE,
)
from pipeline import ContinuousPipeline

log = logging.getLogger("DofusHDV")

_BASE_DIR = Path(__file__).parent.parent


# ══════════════════════════════════════════════════════════════════
#  APPLICATION PRINCIPALE
# ══════════════════════════════════════════════════════════════════

class DofusHDVApp:
    """
    Fenêtre principale de l'outil Dofus HDV.

    Structure de l'interface :
        ┌─────────────────────────────────────────────┐
        │ 🎮 Dofus HDV Tool                  [Config] │  ← en-tête
        ├─────────────────────────────────────────────┤
        │ ⚙ Config (dossier, Scale, CPU)    [Valider] │  ← panneau config
        ├─────────────────────────────────────────────┤
        │ 📸 Capture auto                             │  ← panneau capture
        ├─────────────────────────────────────────────┤
        │ [📦 Ressources] [⚔ Équipements] [📋 Logs]  │  ← onglets
        └─────────────────────────────────────────────┘

    Chaque onglet Ressources / Équipements contient :
        - Champs dict + sortie JSON
        - Boutons Démarrer / Terminer / Supprimer / Relancer OCR
        - Filtre niveau + indicateur de statut
        - Tableau Treeview triable par colonne
    """

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Dofus HDV Tool")
        self.root.geometry("1100x850")
        self.root.minsize(950, 700)

        # Variables tkinter globales
        self.source_dir    = tk.StringVar(
            value=str(Path.home() / "Pictures" / "Screenshots")
        )
        self.workers       = tk.IntVar(value=min(cpu_count(), 4))
        self.poll_interval = tk.DoubleVar(value=2.0)
        self.ocr_scale     = tk.IntVar(value=OCR_SCALE)  # scale OCR (1–4)

        # État de l'application
        self.tabs:        dict[str, dict] = {}
        self.active_mode: Optional[str]   = None

        # Chargement de la configuration
        coords_exist = get_config_manager().load()

        # Capture automatique post-clic
        cfg = get_config_manager().config.capture
        self.click_capture = ClickCapture(
            output_dir=self.source_dir.get(),
            config=cfg,
            on_capture=self._on_capture_done,
        )

        self._build_ui()
        self._setup_log_handler()
        self._update_loop()

        if not coords_exist:
            self.root.after(200, self._open_wizard)

    # ══════════════════════════════════════════════════════════════
    #  CONSTRUCTION DE L'INTERFACE
    # ══════════════════════════════════════════════════════════════

    def _build_ui(self) -> None:
        """Construit l'ensemble de l'interface principale."""
        self._apply_styles()

        main = ttk.Frame(self.root, padding=10)
        main.pack(fill=tk.BOTH, expand=True)

        self._build_header(main)
        self._build_config_panel(main)
        self._build_capture_panel(main)
        self._build_notebook(main)

    def _apply_styles(self) -> None:
        """Configure les styles ttk de l'application."""
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("Title.TLabel",       font=("Segoe UI", 14, "bold"))
        style.configure("Stats.TLabel",       font=("Consolas", 10))
        style.configure("Start.TButton",      font=("Segoe UI", 11, "bold"), padding=8)
        style.configure("Stop.TButton",       font=("Segoe UI", 11, "bold"), padding=8)
        style.configure("Action.TButton",     font=("Segoe UI", 10, "bold"), padding=6)
        style.configure("TLabelframe.Label",  font=("Segoe UI", 10, "bold"))

    def _build_header(self, parent: ttk.Frame) -> None:
        """Construit la barre de titre avec le bouton de configuration."""
        header_row = ttk.Frame(parent)
        header_row.pack(fill=tk.X, pady=(0, 8))

        ttk.Label(
            header_row, text="🎮 Dofus HDV Tool", style="Title.TLabel"
        ).pack(side=tk.LEFT)

        ttk.Button(
            header_row, text="📐 Config", command=self._open_wizard
        ).pack(side=tk.RIGHT)

    def _build_config_panel(self, parent: ttk.Frame) -> None:
        """
        Construit le panneau de configuration.

        Contient :
            - Ligne dossier source
            - Ligne Scale OCR + CPU workers + bouton Valider
            - Label crop courant
        """
        config_frame = ttk.LabelFrame(parent, text="⚙ Config", padding=8)
        config_frame.pack(fill=tk.X, pady=(0, 8))

        # ── Ligne dossier source ────────────────────────────────────
        dir_row = ttk.Frame(config_frame)
        dir_row.pack(fill=tk.X, pady=2)
        ttk.Label(dir_row, text="Dossier:", width=16).pack(side=tk.LEFT)
        ttk.Entry(dir_row, textvariable=self.source_dir).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5)
        )
        ttk.Button(
            dir_row, text="📁", width=3, command=self._browse_source_dir
        ).pack(side=tk.RIGHT)

        self.source_dir.trace_add(
            "write",
            lambda *_: self.click_capture.update_output_dir(self.source_dir.get()),
        )

        # ── Ligne Scale + CPU + bouton Valider ─────────────────────
        hw_row = ttk.Frame(config_frame)
        hw_row.pack(fill=tk.X, pady=2)

        ttk.Label(hw_row, text="Scale OCR:", width=16).pack(side=tk.LEFT)
        ttk.Spinbox(
            hw_row, from_=1, to=4,
            textvariable=self.ocr_scale, width=4,
        ).pack(side=tk.LEFT)
        ttk.Label(
            hw_row, text="  (1=rapide, 4=lent+précis)", foreground="gray"
        ).pack(side=tk.LEFT)

        ttk.Label(hw_row, text="  CPU:", foreground="gray").pack(side=tk.LEFT, padx=(12, 0))
        ttk.Spinbox(
            hw_row, from_=1, to=cpu_count(),
            textvariable=self.workers, width=4,
        ).pack(side=tk.LEFT)
        ttk.Label(
            hw_row, text=f"/{cpu_count()}", foreground="gray"
        ).pack(side=tk.LEFT)

        ttk.Button(
            hw_row, text="✓ Valider",
            command=self._apply_config_settings,
        ).pack(side=tk.RIGHT, padx=(10, 0))

        self._config_validated_label = ttk.Label(
            hw_row, text="", foreground="#080", font=("Consolas", 8)
        )
        self._config_validated_label.pack(side=tk.RIGHT, padx=(0, 8))

        # ── Label crop courant ──────────────────────────────────────
        crop = get_config_manager().config.crop.as_tuple
        self._crop_label = ttk.Label(
            config_frame, text=f"📐 {crop}", foreground="gray"
        )
        self._crop_label.pack(anchor="w", pady=(4, 0))

    def _build_capture_panel(self, parent: ttk.Frame) -> None:
        """Construit le panneau de capture automatique."""
        cap_frame = ttk.LabelFrame(
            parent, text="📸 Capture auto (clic gauche)", padding=8
        )
        cap_frame.pack(fill=tk.X, pady=(0, 8))

        # ── Ligne 1 : statut + bouton capture manuelle + LED ────────
        cap_row = ttk.Frame(cap_frame)
        cap_row.pack(fill=tk.X)

        self._capture_status_label = ttk.Label(
            cap_row, text="⏸ Lance avec pipeline", font=("Consolas", 9)
        )
        self._capture_status_label.pack(side=tk.LEFT)

        self._capture_canvas = tk.Canvas(
            cap_row, width=16, height=16, highlightthickness=0
        )
        self._capture_canvas.pack(side=tk.RIGHT)
        self._capture_indicator_id = self._capture_canvas.create_oval(
            3, 3, 13, 13, fill="gray"
        )

        ttk.Button(
            cap_row, text="📸", command=self._manual_capture
        ).pack(side=tk.RIGHT, padx=(0, 10))

        # ── Ligne 2 : délai modifiable ──────────────────────────────
        cfg         = get_config_manager().config.capture
        click_delay = cfg.click_delay

        delay_row = ttk.Frame(cap_frame)
        delay_row.pack(fill=tk.X, pady=(4, 0))

        ttk.Label(delay_row, text="Délai (s):", font=("Consolas", 8)).pack(side=tk.LEFT)

        self._click_delay_var = tk.DoubleVar(value=click_delay)
        delay_spin = ttk.Spinbox(
            delay_row,
            from_=0.1, to=5.0, increment=0.1,
            textvariable=self._click_delay_var,
            width=5, format="%.1f",
        )
        delay_spin.pack(side=tk.LEFT, padx=(4, 12))
        delay_spin.bind("<FocusOut>", lambda e: self._apply_click_delay())
        delay_spin.bind("<Return>",   lambda e: self._apply_click_delay())

        # Avertissement dépendances manquantes
        missing_deps = []
        try:
            import mss  # noqa
        except ImportError:
            missing_deps.append("mss")
        try:
            from pynput import mouse  # noqa
        except ImportError:
            missing_deps.append("pynput")

        if missing_deps:
            ttk.Label(
                cap_frame,
                text=f"⚠ pip install {' '.join(missing_deps)}",
                foreground="red",
                font=("Segoe UI", 8),
            ).pack(anchor="w")

    def _build_notebook(self, parent: ttk.Frame) -> None:
        """Construit le Notebook avec les onglets Ressources, Équipements et Logs."""
        self.notebook = ttk.Notebook(parent)
        self.notebook.pack(fill=tk.BOTH, expand=True)

        for mode, icon, label in [
            ("ressources",  "📦", "Ressources"),
            ("equipements", "⚔",  "Équipements"),
        ]:
            tab_frame = ttk.Frame(self.notebook)
            self.notebook.add(tab_frame, text=f"{icon} {label} (0)")
            self._build_tab(tab_frame, mode)

        log_frame = ttk.Frame(self.notebook)
        self.notebook.add(log_frame, text="📋 Logs")

        # ── Barre d'outils logs ─────────────────────────────────────
        log_toolbar = ttk.Frame(log_frame)
        log_toolbar.pack(fill=tk.X, pady=(2, 0))

        self._debug_var = tk.BooleanVar(value=False)

        def _toggle_debug() -> None:
            lvl = logging.DEBUG if self._debug_var.get() else logging.INFO
            logging.getLogger("DofusHDV").setLevel(lvl)
            self._debug_status_label.configure(
                text="DEBUG actif — texte brut OCR visible"
                if self._debug_var.get() else ""
            )

        ttk.Checkbutton(
            log_toolbar,
            text="🔬 Mode DEBUG (texte brut OCR)",
            variable=self._debug_var,
            command=_toggle_debug,
        ).pack(side=tk.LEFT, padx=6)

        self._debug_status_label = ttk.Label(
            log_toolbar, text="", foreground="#0a0", font=("Consolas", 8)
        )
        self._debug_status_label.pack(side=tk.LEFT)

        ttk.Button(
            log_toolbar, text="🗑 Effacer",
            command=lambda: (
                self._log_widget.configure(state="normal"),
                self._log_widget.delete("1.0", tk.END),
                self._log_widget.configure(state="disabled"),
            ),
        ).pack(side=tk.RIGHT, padx=6)

        self._log_widget = scrolledtext.ScrolledText(
            log_frame,
            state="disabled",
            font=("Consolas", 9),
            bg="#1e1e2e",
            fg="#cdd6f4",
        )
        self._log_widget.pack(fill=tk.BOTH, expand=True)

    def _build_tab(self, frame: ttk.Frame, mode: str) -> None:
        """
        Construit un onglet complet (ressources ou équipements).

        Contient :
            - Champs dict JSON + fichier de sortie
            - Boutons : Démarrer / Terminer / Supprimer / Relancer OCR
            - Filtre niveau
            - Treeview triable par clic en-tête + suppression par touche Delete

        Args:
            frame: Frame parent de l'onglet.
            mode:  "ressources" ou "equipements".
        """
        tab: dict = {}

        # ── PanedWindow : prévisualisation gauche / contenu droit ───
        paned = ttk.PanedWindow(frame, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True)

        # Panneau gauche — canvas de prévisualisation
        left_panel = ttk.LabelFrame(paned, text="🖼 Prévisualisation", padding=4)
        paned.add(left_panel, weight=0)

        preview_canvas = ZoomableCanvas(left_panel)
        preview_canvas.pack(fill=tk.BOTH, expand=True)
        tab["preview_canvas"] = preview_canvas

        # Panneau droit — tout le contenu existant
        right_panel = ttk.Frame(paned)
        paned.add(right_panel, weight=1)

        # Toutes les constructions suivantes s'attachent à right_panel
        frame = right_panel

        # ── Panneau de configuration ────────────────────────────────
        config_frame = ttk.LabelFrame(frame, text="📋", padding=6)
        config_frame.pack(fill=tk.X, padx=5, pady=5)

        dict_row = ttk.Frame(config_frame)
        dict_row.pack(fill=tk.X, pady=2)
        ttk.Label(dict_row, text="Dict:", width=14).pack(side=tk.LEFT)
        saved_paths   = load_dict_paths()
        saved_path    = saved_paths.get(mode, "")
        fallback_path = (
            str(_BASE_DIR / "json" / "cache" / "ressources.json")
            if mode == "ressources"
            else str(_BASE_DIR / "json" / "cache" / "equipements.json")
        )
        dict_var = tk.StringVar(value=saved_path if saved_path else fallback_path)
        ttk.Entry(dict_row, textvariable=dict_var).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5)
        )
        ttk.Button(
            dict_row, text="📁", width=3,
            command=lambda v=dict_var: self._browse_dict_file(v),
        ).pack(side=tk.RIGHT)
        tab["dict_path"] = dict_var

        out_row = ttk.Frame(config_frame)
        out_row.pack(fill=tk.X, pady=2)
        ttk.Label(out_row, text="Sortie:", width=14).pack(side=tk.LEFT)
        saved_output_paths = load_output_paths()
        out_var = tk.StringVar(value=saved_output_paths.get(mode, ""))
        ttk.Entry(out_row, textvariable=out_var).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5)
        )
        ttk.Button(
            out_row, text="📁", width=3,
            command=lambda v=out_var: self._browse_output_file(v),
        ).pack(side=tk.RIGHT)
        tab["output_path"] = out_var

        # ── Boutons — ligne 1 : Démarrer / Terminer ─────────────────
        btn_row1 = ttk.Frame(frame)
        btn_row1.pack(fill=tk.X, padx=5, pady=(5, 2))

        btn_start = ttk.Button(
            btn_row1, text="▶  Démarrer",
            style="Start.TButton",
            command=lambda m=mode: self._start_pipeline(m),
        )
        btn_start.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 5))

        btn_stop = ttk.Button(
            btn_row1, text="⏹  Terminer & Exporter",
            style="Stop.TButton",
            command=lambda m=mode: self._stop_pipeline(m),
            state="disabled",
        )
        btn_stop.pack(side=tk.LEFT, expand=True, fill=tk.X)

        tab["btn_start"] = btn_start
        tab["btn_stop"]  = btn_stop

        # ── Boutons — ligne 2 : Supprimer / Relancer OCR ────────────
        btn_row2 = ttk.Frame(frame)
        btn_row2.pack(fill=tk.X, padx=5, pady=(0, 5))

        btn_delete = ttk.Button(
            btn_row2, text="🗑  Supprimer sélection",
            style="Action.TButton",
            command=lambda m=mode: self._delete_selected(m),
        )
        btn_delete.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 5))

        btn_rerun = ttk.Button(
            btn_row2, text="🔁  Relancer OCR",
            style="Action.TButton",
            command=lambda m=mode: self._rerun_ocr(m),
        )
        btn_rerun.pack(side=tk.LEFT, expand=True, fill=tk.X)

        tab["btn_delete"] = btn_delete
        tab["btn_rerun"]  = btn_rerun

        # ── Barre de statut ─────────────────────────────────────────
        status_bar = ttk.Frame(frame)
        status_bar.pack(fill=tk.X, padx=5, pady=(0, 4))

        status_label = ttk.Label(
            status_bar, text="⏸", style="Stats.TLabel", anchor="w"
        )
        status_label.pack(side=tk.LEFT, fill=tk.X, expand=True)

        stats_label = ttk.Label(
            status_bar, text="", style="Stats.TLabel", anchor="e"
        )
        stats_label.pack(side=tk.RIGHT)

        indicator_canvas = tk.Canvas(
            status_bar, width=16, height=16, highlightthickness=0
        )
        indicator_canvas.pack(side=tk.RIGHT, padx=(0, 5))
        indicator_id = indicator_canvas.create_oval(3, 3, 13, 13, fill="gray")

        tab["status_label"] = status_label
        tab["stats_label"]  = stats_label
        tab["indicator"]    = indicator_canvas
        tab["indicator_id"] = indicator_id
        tab["blink"]        = False

        # ── Filtre de niveau ────────────────────────────────────────
        filter_frame = ttk.LabelFrame(frame, text="🔍 Filtre niveau", padding=4)
        filter_frame.pack(fill=tk.X, padx=5, pady=(0, 3))

        ttk.Label(filter_frame, text="Min :").pack(side=tk.LEFT)
        level_min_var = tk.IntVar(value=0)
        ttk.Spinbox(
            filter_frame, from_=0, to=999,
            textvariable=level_min_var, width=5,
        ).pack(side=tk.LEFT, padx=(2, 10))

        ttk.Label(filter_frame, text="Max :").pack(side=tk.LEFT)
        level_max_var = tk.IntVar(value=999)
        ttk.Spinbox(
            filter_frame, from_=0, to=999,
            textvariable=level_max_var, width=5,
        ).pack(side=tk.LEFT, padx=(2, 10))

        filter_count_label = ttk.Label(
            filter_frame, text="", foreground="gray", font=("Consolas", 8)
        )
        filter_count_label.pack(side=tk.LEFT, padx=(8, 0))

        ttk.Button(
            filter_frame, text="✕ Réinitialiser",
            command=lambda mv=level_min_var, xv=level_max_var, m=mode: (
                mv.set(0), xv.set(999),
                self._apply_level_filter(m)
            ),
        ).pack(side=tk.RIGHT)

        ttk.Button(
            filter_frame, text="🎨 Trier couleur",
            command=lambda m=mode: self._sort_tree(m, "__color__"),
        ).pack(side=tk.RIGHT, padx=(0, 4))

        tab["level_min"]          = level_min_var
        tab["level_max"]          = level_max_var
        tab["filter_count_label"] = filter_count_label

        # ── Tableau des résultats ───────────────────────────────────
        tree_frame = ttk.Frame(frame)
        tree_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=(0, 5))

        if mode == "ressources":
            columns    = ("source", "nom", "niveau", "type",
                          "prix_moyen", "×1", "×10", "×100", "×1000", "id")
            col_widths = {
                "source": 80, "nom": 160, "niveau": 55, "type": 100,
                "prix_moyen": 85, "×1": 75, "×10": 75, "×100": 75, "×1000": 75,
                "id": 70,
            }
        else:
            columns    = ("source", "nom", "niveau", "type", "prix_moyen", "prix", "id")
            col_widths = {
                "source": 90, "nom": 210, "niveau": 60,
                "type": 140, "prix_moyen": 110, "prix": 110, "id": 70,
            }

        tree = ttk.Treeview(
            tree_frame, columns=columns, show="headings",
            height=12, selectmode="extended",
        )

        # En-têtes triables — clic déclenche _sort_tree()
        for col in columns:
            tree.heading(
                col, text=col.capitalize(),
                command=lambda c=col, m=mode: self._sort_tree(m, c),
            )
            tree.column(col, width=col_widths.get(col, 80), minwidth=50, anchor="center")

        # Tags de coloration : vert = cohérent, rouge = anomalie prix
        tree.tag_configure("ok",  background="#003300", foreground="#aaffaa")
        tree.tag_configure("bad", background="#330000", foreground="#ffaaaa")

        scrollbar = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL, command=tree.yview)
        tree.configure(yscrollcommand=scrollbar.set)
        tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Label aide sélection multiple
        ttk.Label(
            tree_frame,
            text="Ctrl+clic / Shift+clic pour sélection multiple",
            font=("Segoe UI", 7),
            foreground="gray",
        ).pack(anchor="e", pady=(2, 0))

        # Suppression via touche Delete
        tree.bind("<Delete>", lambda e, m=mode: self._delete_selected(m))

        # Prévisualisation au clic sur une ligne
        tree.bind(
            "<<TreeviewSelect>>",
            lambda e, m=mode: self._on_tree_select(m),
        )

        level_min_var.trace_add("write", lambda *_, m=mode: self._apply_level_filter(m))
        level_max_var.trace_add("write", lambda *_, m=mode: self._apply_level_filter(m))

        tab["tree"]         = tree
        tab["pipeline"]     = None
        tab["last_results"] = []
        tab["sort_col"]     = None   # colonne de tri actuelle
        tab["sort_reverse"] = False  # ordre du tri
        tab["color_map"]    = {}     # {source_basename: "ok" | "bad" | ""}

        self.tabs[mode] = tab

    # ══════════════════════════════════════════════════════════════
    #  PRÉVISUALISATION IMAGE + OVERLAYS OCR
    # ══════════════════════════════════════════════════════════════

    def _on_tree_select(self, mode: str) -> None:
        """
        Callback déclenché à chaque sélection dans le Treeview.

        Cherche le fichier image correspondant à la ligne sélectionnée,
        le charge dans le ZoomableCanvas et affiche les overlays des
        zones OCR configurées.

        Si plusieurs lignes sont sélectionnées, utilise la première.
        Si le fichier est introuvable, efface le canvas proprement.

        Args:
            mode: "ressources" ou "equipements".
        """
        tab  = self.tabs[mode]
        tree = tab["tree"]

        selected = tree.selection()
        if not selected:
            return

        # Récupérer le basename source depuis les valeurs de la ligne
        values = tree.item(selected[0], "values")
        if not values:
            return
        source_basename = str(values[0])  # colonne "source" toujours en 0

        # Chercher le résultat correspondant dans last_results
        # pour récupérer d'éventuels champs enrichis post-matching
        image_path = self._find_source_image(source_basename)

        canvas = tab["preview_canvas"]

        if not image_path:
            canvas.set_hint(f"⚠ Introuvable : {source_basename}")
            return

        try:
            img = Image.open(image_path).convert("RGB")
        except Exception as exc:
            canvas.set_hint(f"⚠ Erreur lecture : {exc}")
            return

        overlays = self._build_preview_overlays(mode)
        canvas.set_image(img)
        canvas.set_overlays(overlays)
        canvas.set_hint(source_basename)

    def _find_source_image(self, basename: str) -> Optional[str]:
        """
        Cherche un fichier image par son basename dans source_dir (récursif).

        La recherche est récursive pour couvrir les sous-dossiers datés
        créés par image_processing.clean_single_image().

        Args:
            basename: Nom de fichier (sans chemin) à rechercher.

        Returns:
            Chemin absolu du fichier si trouvé, None sinon.
        """
        source_dir = Path(self.source_dir.get())
        if not source_dir.is_dir():
            return None

        for path in source_dir.rglob(basename):
            if path.is_file():
                return str(path)

        return None

    def _build_preview_overlays(self, mode: str) -> list[dict]:
        """
        Construit la liste d'overlays à afficher sur le canvas de prévisualisation.

        Les zones sont lues depuis la configuration courante (coords.json)
        via get_config_manager().config — elles se mettent automatiquement
        à jour si le wizard modifie les coordonnées.

        Palette de couleurs :
            nom         → vert       #4f4
            niveau      → bleu clair #4af
            type        → magenta    #f4f
            prix_moyen  → orange     #fa0
            lot ×n      → cyan       #0cc
            prix lot    → jaune      #ff0
            prix équip  → rouge      #f44

        Args:
            mode: "ressources" ou "equipements" — détermine quels
                  overlays afficher (lots vs prix équipement).

        Returns:
            Liste de dicts overlay compatibles avec ZoomableCanvas.set_overlays().
        """
        cfg         = get_config_manager().config
        popup       = cfg.popup_rects
        overlays: list[dict] = []

        # ── Champs communs ──────────────────────────────────────────
        overlays.append({
            "rect":  popup.nom.as_tuple,
            "color": "#4f4",
            "label": "nom",
            "width": 2,
        })
        overlays.append({
            "rect":  popup.niveau.as_tuple,
            "color": "#4af",
            "label": "niveau",
            "width": 2,
        })
        overlays.append({
            "rect":  popup.type_item.as_tuple,
            "color": "#f4f",
            "label": "type",
            "width": 2,
        })
        overlays.append({
            "rect":  popup.prix_moyen.as_tuple,
            "color": "#fa0",
            "label": "prix moyen",
            "width": 2,
        })

        # ── Lots (ressources uniquement) ────────────────────────────
        if mode == "ressources":
            lot_labels = ["×1", "×10", "×100", "×1000"]
            for lot_rect, label in zip(popup.lots, lot_labels):
                overlays.append({
                    "rect":  lot_rect.lot.as_tuple,
                    "color": "#0cc",
                    "label": label,
                    "width": 2,
                })
                overlays.append({
                    "rect":  lot_rect.prix.as_tuple,
                    "color": "#ff0",
                    "label": f"prix {label}",
                    "width": 2,
                })

        # ── Prix équipement (équipements uniquement) ────────────────
        else:
            for i, price_rect in enumerate(cfg.equip_price_rects):
                overlays.append({
                    "rect":  price_rect.as_tuple,
                    "color": "#f44",
                    "label": f"prix{i + 1}",
                    "width": 2,
                })

        return overlays

    @staticmethod
    def _compute_row_tag(mode: str, result: dict) -> str:
        """
        Calcule le tag de coloration d'une ligne selon la cohérence des prix.

        Principe :
            Pour chaque prix par lot disponible, calcule le prix unitaire
            implicite (prix_lot / quantité) et le compare au prix_moyen.
            Si l'écart relatif dépasse 50 % sur au moins un lot → tag "bad".
            Si tous les écarts sont ≤ 50 % → tag "ok".
            Si prix_moyen absent ou aucun prix de lot → pas de tag ("").

        Formule d'écart :
            ecart = |prix_unitaire_lot - prix_moyen| / prix_moyen

        Args:
            mode:   "ressources" ou "equipements".
            result: Dict résultat OCR.

        Returns:
            "ok", "bad" ou "" (pas de coloration).
        """
        prix_moyen = result.get("prix_moyen")
        if not prix_moyen or prix_moyen <= 0:
            return ""

        # Paires (prix_lot, quantité) selon le mode
        if mode == "ressources":
            pairs = [
                (result.get("prix_1"),    1),
                (result.get("prix_10"),   10),
                (result.get("prix_100"),  100),
                (result.get("prix_1000"), 1000),
            ]
        else:
            pairs = [(result.get("prix"), 1)]

        valid_pairs = [(p, q) for p, q in pairs if p and p > 0]
        if not valid_pairs:
            return ""

        for prix_lot, quantite in valid_pairs:
            prix_unitaire = prix_lot / quantite
            ecart = abs(prix_unitaire - prix_moyen) / prix_moyen
            if ecart > 0.50:
                return "bad"

        return "ok"

    def _setup_log_handler(self) -> None:
        """Connecte le handler de logging au widget ScrolledText."""
        handler = TextHandler(self._log_widget)
        handler.setFormatter(
            logging.Formatter("%(asctime)s │ %(message)s", datefmt="%H:%M:%S")
        )
        log.addHandler(handler)

    # ══════════════════════════════════════════════════════════════
    #  ACTIONS UTILISATEUR — NAVIGATION FICHIERS
    # ══════════════════════════════════════════════════════════════

    def _browse_source_dir(self) -> None:
        directory = filedialog.askdirectory(initialdir=self.source_dir.get())
        if directory:
            self.source_dir.set(directory)

    def _browse_dict_file(self, var: tk.StringVar) -> None:
        path = filedialog.askopenfilename(filetypes=[("JSON", "*.json")])
        if path:
            var.set(path)

    def _browse_output_file(self, var: tk.StringVar) -> None:
        path = filedialog.asksaveasfilename(
            defaultextension=".json", filetypes=[("JSON", "*.json")]
        )
        if path:
            var.set(path)

    # ══════════════════════════════════════════════════════════════
    #  VALIDATION DE LA CONFIGURATION (Scale + CPU)
    # ══════════════════════════════════════════════════════════════

    def _apply_config_settings(self) -> None:
        """
        Valide et applique les réglages Scale OCR et CPU workers.

        Le scale est borné entre 1 et 4.
        Le nombre de workers est borné entre 1 et cpu_count().
        Un label de confirmation s'affiche brièvement.
        """
        try:
            scale = max(1, min(4, int(self.ocr_scale.get())))
            self.ocr_scale.set(scale)
        except (tk.TclError, ValueError):
            self.ocr_scale.set(OCR_SCALE)
            scale = OCR_SCALE

        try:
            workers = max(1, min(cpu_count(), int(self.workers.get())))
            self.workers.set(workers)
        except (tk.TclError, ValueError):
            self.workers.set(min(cpu_count(), 4))
            workers = self.workers.get()

        msg = f"✓ Scale×{scale}  CPU×{workers}"
        self._config_validated_label.configure(text=msg)
        self.root.after(3000, lambda: self._config_validated_label.configure(text=""))
        log.info(f"⚙ Config validée — {msg}")

    # ══════════════════════════════════════════════════════════════
    #  CAPTURE AUTOMATIQUE
    # ══════════════════════════════════════════════════════════════

    def _manual_capture(self) -> None:
        cfg = get_config_manager().config
        self.click_capture.update_output_dir(self.source_dir.get())
        self.click_capture.update_config(
            crop=cfg.crop.to_list(),
        )
        self.click_capture.manual_capture()

    def _apply_click_delay(self) -> None:
        try:
            raw = self._click_delay_var.get()
        except tk.TclError:
            return

        delay = max(0.1, min(5.0, round(float(raw), 1)))
        self._click_delay_var.set(delay)
        self.click_capture.update_config(click_delay=delay)

        if self.click_capture.is_active:
            self._capture_status_label.configure(text=f"🟢 clic+{delay}s")

        mgr = get_config_manager()
        mgr.config.capture.click_delay = delay
        try:
            raw_cfg = mgr.load_raw()
            if "capture" not in raw_cfg:
                raw_cfg["capture"] = {}
            raw_cfg["capture"]["click_delay"] = delay
            from config import COORDS_FILE
            COORDS_FILE.parent.mkdir(parents=True, exist_ok=True)
            import json as _json
            with COORDS_FILE.open("w", encoding="utf-8") as fh:
                _json.dump(raw_cfg, fh, ensure_ascii=False, indent=2)
        except Exception as exc:
            log.warning(f"📸 Impossible de persister le délai : {exc}")
        log.info(f"📸 Délai mis à jour : {delay}s")

    def _on_capture_done(self, filepath: str) -> None:
        self.root.after(0, self._update_capture_status)

    def _update_capture_status(self) -> None:
        if self.click_capture.is_active:
            count = self.click_capture.capture_count
            self._capture_status_label.configure(text=f"🟢 {count} captures")

    # ══════════════════════════════════════════════════════════════
    #  WIZARD DE CONFIGURATION
    # ══════════════════════════════════════════════════════════════

    def _open_wizard(self) -> None:
        if self.active_mode:
            messagebox.showwarning("Pipeline actif", "Arrêtez le pipeline avant de reconfigurer.")
            return
        CoordinatesWizard(
            parent=self.root,
            existing_data=get_config_manager().config.to_dict(),
            on_done=self._on_wizard_done,
        )

    def _on_wizard_done(self, data: Optional[dict]) -> None:
        crop = get_config_manager().config.crop.as_tuple
        self._crop_label.configure(text=f"📐 {crop}")

        if data and "capture" in data:
            cap   = data["capture"]
            delay = cap.get("click_delay", 0.5)
            self.click_capture.update_config(
                click_delay=delay,
                debounce=cap.get("debounce"),
            )
            self._click_delay_var.set(round(float(delay), 1))
            # Mettre à jour le crop (région dérivée automatiquement)
            crop = get_config_manager().config.crop
            self.click_capture.update_config(crop=crop.to_list())

        log.info(f"📐 {'Config OK' if data else 'Défauts appliqués'}: crop={crop}")

    # ══════════════════════════════════════════════════════════════
    #  TRI DES COLONNES
    # ══════════════════════════════════════════════════════════════

    def _sort_tree(self, mode: str, col: str) -> None:
        """
        Trie le Treeview de l'onglet selon la colonne cliquée.

        Premier clic → tri ascendant.
        Second clic sur la même colonne → tri descendant.
        Clic sur une autre colonne → repart en ascendant.

        Le tri porte sur last_results (données source) et réaffiche
        via _apply_level_filter() pour respecter le filtre niveau actif.

        Args:
            mode: "ressources" ou "equipements".
            col:  Identifiant de la colonne (ex: "nom", "×1", "niveau").
        """
        tab = self.tabs[mode]

        # Inverser si même colonne, sinon repartir en ascendant
        if tab["sort_col"] == col:
            tab["sort_reverse"] = not tab["sort_reverse"]
        else:
            tab["sort_col"]     = col
            tab["sort_reverse"] = False

        reverse = tab["sort_reverse"]

        # Mapping colonne Treeview → clé dans le dict résultat
        col_key_map = {
            "source": "source", "nom": "nom", "niveau": "niveau",
            "type": "type", "prix_moyen": "prix_moyen",
            "×1": "prix_1", "×10": "prix_10",
            "×100": "prix_100", "×1000": "prix_1000",
            "prix": "prix", "id": "id",
        }

        # Cas spécial : tri par couleur (anomalies en tête)
        if col == "__color__":
            # Ordre : "bad" < "" < "ok"  (anomalies d'abord en ascendant)
            color_order = {"bad": 0, "": 1, "ok": 2}
            tab["last_results"].sort(
                key=lambda r: color_order.get(
                    self._compute_row_tag(mode, r), 1
                ),
                reverse=reverse,
            )
            # Pas d'indicateur dans l'en-tête pour __color__
            self._apply_level_filter(mode)
            return

        key = col_key_map.get(col, col)

        def sort_key(result: dict):
            val = result.get(key)
            # None en fin de liste quelle que soit la direction
            if val is None:
                return (1, 0, "")
            if isinstance(val, (int, float)):
                return (0, val, "")
            return (0, 0, str(val).lower())

        tab["last_results"].sort(key=sort_key, reverse=reverse)

        # Mettre à jour l'indicateur de direction dans l'en-tête
        tree = tab["tree"]
        for c in tree["columns"]:
            text = c.capitalize()
            if c == col:
                text += " ▼" if reverse else " ▲"
            tree.heading(c, text=text)

        self._apply_level_filter(mode)

    # ══════════════════════════════════════════════════════════════
    #  SUPPRESSION DE LIGNES SÉLECTIONNÉES
    # ══════════════════════════════════════════════════════════════

    def _delete_selected(self, mode: str) -> None:
        """
        Supprime les lignes sélectionnées du Treeview et de last_results.

        La sélection multiple est supportée (Ctrl+clic, Shift+clic).
        La suppression porte sur last_results par correspondance de
        position dans le Treeview affiché (post-filtre).

        Args:
            mode: "ressources" ou "equipements".
        """
        tab  = self.tabs[mode]
        tree = tab["tree"]

        selected_items = tree.selection()
        if not selected_items:
            return

        # Construire l'ensemble des valeurs (tuples) à supprimer
        to_remove: set[tuple] = set()
        for item_id in selected_items:
            to_remove.add(tree.item(item_id, "values"))

        # Filtrer last_results en retirant les correspondances
        def matches(result: dict) -> bool:
            row = tuple(str(v) for v in self._row_values(mode, result))
            return row in to_remove

        before = len(tab["last_results"])
        tab["last_results"] = [r for r in tab["last_results"] if not matches(r)]
        removed = before - len(tab["last_results"])

        # Rafraîchir l'affichage
        self._apply_level_filter(mode)
        self._update_tab_title(mode, len(tab["last_results"]))
        log.info(f"🗑 {removed} item(s) supprimé(s) ({mode})")

    # ══════════════════════════════════════════════════════════════
    #  RELANCE OCR
    # ══════════════════════════════════════════════════════════════

    def _rerun_ocr(self, mode: str) -> None:
        """
        Relance l'OCR sur les fichiers sources des résultats restants.

        Utile après avoir modifié le scale ou supprimé des items incorrects.
        Lance le traitement dans un thread dédié pour ne pas bloquer l'UI.

        Flux :
            1. Récupère les basenames sources depuis last_results
            2. Cherche les fichiers correspondants dans source_dir (récursif)
            3. Crée un pool temporaire avec le scale et le CPU configurés
            4. Soumet ocr_resource_image / ocr_equipment_image pour chaque fichier
            5. Remplace last_results par les nouveaux résultats
            6. Rafraîchit l'affichage via root.after()

        Args:
            mode: "ressources" ou "equipements".
        """
        if self.active_mode:
            messagebox.showwarning("Pipeline actif", "Arrêtez le pipeline avant de relancer.")
            return

        tab     = self.tabs[mode]
        results = tab["last_results"]

        if not results:
            messagebox.showinfo("Aucun résultat", "Aucun résultat à relancer.")
            return

        # Valider le scale avant de lancer
        self._apply_config_settings()

        # Basenames des fichiers à relancer
        source_basenames: set[str] = {
            r["source"] for r in results if r.get("source")
        }

        # Recherche récursive des fichiers dans source_dir
        source_dir = Path(self.source_dir.get())
        found_paths: list[str] = []
        for path in source_dir.rglob("*"):
            if path.is_file() and path.name in source_basenames:
                found_paths.append(str(path))

        if not found_paths:
            messagebox.showwarning(
                "Fichiers introuvables",
                "Aucun fichier source trouvé dans le dossier.\n"
                "Les images ont peut-être été déplacées ou supprimées."
            )
            return

        # ── Figer le scale MAINTENANT dans le thread principal ──────
        # self.ocr_scale est un tk.IntVar lié à un Spinbox. Si le spinbox
        # n'a pas perdu le focus, la valeur peut ne pas être committée.
        # On force la lecture + validation ici, avant de lancer le thread,
        # pour garantir que la valeur capturée dans la closure est correcte.
        try:
            ocr_scale_value = max(1, min(4, int(self.ocr_scale.get())))
        except (tk.TclError, ValueError):
            ocr_scale_value = OCR_SCALE
        self.ocr_scale.set(ocr_scale_value)  # met à jour le spinbox si invalide

        # Configuration avec le scale injecté
        config_dict              = get_config_manager().load_raw()
        config_dict["ocr_scale"] = ocr_scale_value  # int figé — pas de référence tk
        workers                  = max(1, min(cpu_count(), int(self.workers.get())))
        ocr_fn                   = ocr_resource_image if mode == "ressources" else ocr_equipment_image

        # Mise à jour de l'UI
        tab["btn_rerun"].configure(state="disabled")
        tab["status_label"].configure(text=f"🔁 Relance OCR ×{ocr_scale_value}…")
        log.info(
            f"🔁 [{mode}] Relance OCR — {len(found_paths)} fichier(s), "
            f"scale×{ocr_scale_value}, {workers} worker(s)"
        )

        def run_in_thread() -> None:
            new_results: list[dict] = []

            with ProcessPoolExecutor(max_workers=workers) as pool:
                futures = {
                    pool.submit(ocr_fn, path, config_dict): path
                    for path in found_paths
                }
                for future in as_completed(futures):
                    try:
                        result = future.result()
                        if result is not None:
                            new_results.append(result)
                    except Exception as exc:
                        log.error(f"🔁 Erreur OCR relance : {exc}")

            if new_results:
                # ── Import via module — évite la copie de référence ─
                import matching as _m

                new_results = _m.deduplicate_results(new_results)

                # ── Correction OCR des types — toujours exécutée ────
                # Indépendante du dictionnaire : corrige les erreurs OCR
                # (accents manquants, troncatures) vers les types Dofus
                # canoniques AVANT le matching ET avant l'affichage.
                # Sans cette étape, un type mal lu bloquerait _get_candidates()
                # même si le dictionnaire est disponible.
                corrections = 0
                for r in new_results:
                    raw_type       = r.get("type") or ""
                    corrected_type = _m.correct_ocr_type(raw_type)
                    if corrected_type != raw_type:
                        r["type"] = corrected_type
                        corrections += 1
                if corrections:
                    log.info(f"🏷️  Relance — {corrections} type(s) corrigé(s)")

                # ── Chargement du dictionnaire si absent ────────────
                if not _m._item_list:
                    dict_path = tab["dict_path"].get().strip()
                    if dict_path and Path(dict_path).exists():
                        try:
                            count = _m.load_item_dictionary(dict_path)
                            _m.build_search_index()
                            log.info(f"📚 Dictionnaire chargé pour relance : {count} items")
                        except Exception as exc:
                            log.warning(f"📚 Chargement dictionnaire échoué : {exc}")

                # ── Matching fuzzy ──────────────────────────────────
                if _m._item_list:
                    log.info(f"📚 Matching relance — {len(new_results)} résultat(s)…")
                    for r in new_results:
                        r["id"] = None
                    _m.run_multipass_matching(new_results)
                else:
                    log.warning("📚 Dictionnaire vide — matching ignoré pour la relance")

            self.root.after(0, self._on_rerun_done, mode, new_results)

        threading.Thread(target=run_in_thread, daemon=True, name=f"Rerun-{mode}").start()

    def _on_rerun_done(self, mode: str, new_results: list[dict]) -> None:
        """
        Callback UI appelé après la fin de la relance OCR.

        Remplace last_results par les nouveaux résultats, rafraîchit
        l'affichage et restaure les boutons.

        Args:
            mode:        "ressources" ou "equipements".
            new_results: Résultats produits par la relance OCR.
        """
        tab = self.tabs[mode]
        tab["btn_rerun"].configure(state="normal")
        tab["btn_stop"].configure(state="normal")  # export disponible après relance

        if not new_results:
            tab["status_label"].configure(text="⏸ Relance terminée — aucun résultat")
            log.warning(f"🔁 [{mode}] Relance terminée sans résultat")
            return

        tab["last_results"] = new_results
        tab["sort_col"]     = None
        tab["sort_reverse"] = False

        self._apply_level_filter(mode)
        self._update_tab_title(mode, len(new_results))
        tab["status_label"].configure(
            text=f"⏸ Relance OK — {len(new_results)} résultat(s)"
        )
        log.info(f"🔁 [{mode}] Relance terminée — {len(new_results)} résultat(s)")

    # ══════════════════════════════════════════════════════════════
    #  PIPELINE — DÉMARRAGE / ARRÊT
    # ══════════════════════════════════════════════════════════════

    def _start_pipeline(self, mode: str) -> None:
        """
        Démarre le pipeline de traitement pour le mode donné.

        Le scale OCR validé est injecté dans la config avant démarrage.

        Args:
            mode: "ressources" ou "equipements".
        """
        if self.active_mode:
            messagebox.showwarning("Pipeline actif", "Un pipeline est déjà en cours.")
            return

        source = self.source_dir.get()
        if not Path(source).is_dir():
            messagebox.showerror("Dossier introuvable", f"Le dossier n'existe pas :\n{source}")
            return

        # Valider la config avant démarrage
        self._apply_config_settings()

        self.active_mode = mode
        tab              = self.tabs[mode]

        for t in self.tabs.values():
            t["btn_start"].configure(state="disabled")
        tab["btn_stop"].configure(state="normal")
        tab["btn_rerun"].configure(state="disabled")

        tab["tree"].delete(*tab["tree"].get_children())
        tab["last_results"] = []
        tab["sort_col"]     = None
        tab["sort_reverse"] = False
        self._update_tab_title(mode, 0)

        self.click_capture.update_output_dir(source)
        cfg = get_config_manager().config
        try:
            spinbox_delay = max(0.1, min(5.0, round(float(self._click_delay_var.get()), 1)))
        except (tk.TclError, ValueError):
            spinbox_delay = cfg.capture.click_delay
        self.click_capture.update_config(
            crop=cfg.crop.to_list(),
            click_delay=spinbox_delay,
            debounce=cfg.capture.debounce,
        )
        if self.click_capture.start():
            self._capture_status_label.configure(
                text=f"🟢 clic+{self.click_capture.click_delay}s"
            )
            self._capture_canvas.itemconfigure(self._capture_indicator_id, fill="#0f8")
        else:
            self._capture_status_label.configure(text="⚠ Non disponible")

        # Injecter le scale dans la config du pipeline
        config_dict              = get_config_manager().load_raw()
        config_dict["ocr_scale"] = self.ocr_scale.get()

        pipeline = ContinuousPipeline(
            source_dir=source,
            dict_path=tab["dict_path"].get(),
            max_workers=self.workers.get(),
            poll_interval=self.poll_interval.get(),
            mode=mode,
            on_image_ocr=lambda r, m=mode: self.root.after(0, self._add_result, m, r),
            on_status=lambda t, tb=tab: self.root.after(
                0, tb["status_label"].configure, {"text": t}
            ),
            on_stopped=lambda res, m=mode: self.root.after(
                0, self._on_pipeline_done, m, res
            ),
        )
        tab["pipeline"] = pipeline
        pipeline.start()

    def _stop_pipeline(self, mode: str) -> None:
        """
        Arrête le pipeline ou exporte directement si pipeline inactif.

        Après une relance OCR, le pipeline n'existe plus mais btn_stop
        est activé pour permettre l'export. Dans ce cas on exporte
        directement sans tenter d'arrêter un pipeline inexistant.
        """
        tab = self.tabs[mode]
        pipeline = tab.get("pipeline")

        if pipeline and pipeline.is_running:
            tab["btn_stop"].configure(state="disabled")
            pipeline.stop()
            self._stop_capture()
        else:
            # Pas de pipeline actif (après relance OCR) — export direct
            tab["btn_stop"].configure(state="disabled")
            results = tab["last_results"]
            if results:
                self._export_results(mode, results)
            else:
                from tkinter import messagebox
                messagebox.showinfo("Aucun résultat", "Aucun résultat à exporter.")

    def _stop_capture(self) -> None:
        if self.click_capture.is_active:
            count = self.click_capture.capture_count
            self.click_capture.stop()
            self._capture_status_label.configure(text=f"⏸ {count} captures")
            self._capture_canvas.itemconfigure(self._capture_indicator_id, fill="gray")

    # ══════════════════════════════════════════════════════════════
    #  CALLBACKS PIPELINE — THREAD UI
    # ══════════════════════════════════════════════════════════════

    def _add_result(self, mode: str, result: dict) -> None:
        tab = self.tabs[mode]
        tab["last_results"].append(result)

        try:
            level_min = int(tab["level_min"].get())
            level_max = int(tab["level_max"].get())
        except (tk.TclError, ValueError):
            level_min, level_max = 0, 999

        niveau = result.get("niveau")
        if niveau is None or (level_min <= int(niveau) <= level_max):
            tag = self._compute_row_tag(mode, result)
            tab["tree"].insert(
                "", tk.END,
                values=self._row_values(mode, result),
                tags=(tag,) if tag else (),
            )
            children = tab["tree"].get_children()
            if children:
                tab["tree"].see(children[-1])

        self._update_tab_title(mode, len(tab["last_results"]))

    def _on_pipeline_done(self, mode: str, results: list[dict]) -> None:
        tab = self.tabs[mode]
        self.active_mode = None

        for t in self.tabs.values():
            t["btn_start"].configure(state="normal")
        tab["btn_stop"].configure(state="disabled")
        tab["btn_rerun"].configure(state="normal")
        self._stop_capture()

        tab["last_results"] = results
        self._apply_level_filter(mode)
        self._update_tab_title(mode, len(results))

        stats      = tab["pipeline"].stats if tab["pipeline"] else {}
        duplicates = stats.get("duplicates", 0)
        tab["status_label"].configure(
            text=f"⏸ {len(results)} items | {duplicates} doublon(s)"
        )

        if results:
            self._export_results(mode, results)
            self.notebook.select(0 if mode == "ressources" else 1)

    # ══════════════════════════════════════════════════════════════
    #  HELPERS UI
    # ══════════════════════════════════════════════════════════════

    @staticmethod
    def _row_values(mode: str, result: dict) -> tuple:
        """
        Extrait les valeurs d'affichage d'un résultat pour le Treeview.

        Les valeurs None sont remplacées par "" pour l'affichage.
        """
        def _v(val):
            return "" if val is None else val

        if mode == "ressources":
            return (
                _v(result.get("source")),
                _v(result.get("nom")),
                _v(result.get("niveau")),
                _v(result.get("type")),
                _v(result.get("prix_moyen")),
                _v(result.get("prix_1")),
                _v(result.get("prix_10")),
                _v(result.get("prix_100")),
                _v(result.get("prix_1000")),
                _v(result.get("id")),
            )
        return (
            _v(result.get("source")),
            _v(result.get("nom")),
            _v(result.get("niveau")),
            _v(result.get("type")),
            _v(result.get("prix_moyen")),
            _v(result.get("prix")),
            _v(result.get("id")),
        )

    def _update_tab_title(self, mode: str, count: int) -> None:
        tab_index = 0 if mode == "ressources" else 1
        icon      = "📦" if mode == "ressources" else "⚔"
        label     = "Ressources" if mode == "ressources" else "Équipements"
        self.notebook.tab(tab_index, text=f"{icon} {label} ({count})")

    def _apply_level_filter(self, mode: str) -> None:
        """
        Filtre le tableau selon le niveau minimum et maximum saisis.

        Les items sans niveau (None) sont toujours affichés.
        Met à jour le label de comptage.

        Args:
            mode: "ressources" ou "equipements".
        """
        tab = self.tabs.get(mode)
        if not tab:
            return

        try:
            level_min = int(tab["level_min"].get())
            level_max = int(tab["level_max"].get())
        except (tk.TclError, ValueError):
            return

        if level_min > level_max:
            return

        tree    = tab["tree"]
        results = tab["last_results"]

        tree.delete(*tree.get_children())
        displayed = 0

        for result in results:
            niveau = result.get("niveau")
            if niveau is None or (level_min <= int(niveau) <= level_max):
                tag = self._compute_row_tag(mode, result)
                tree.insert(
                    "", tk.END,
                    values=self._row_values(mode, result),
                    tags=(tag,) if tag else (),
                )
                displayed += 1

        total = len(results)
        if level_min == 0 and level_max == 999:
            tab["filter_count_label"].configure(text=f"{total} items")
        else:
            tab["filter_count_label"].configure(
                text=f"{displayed} / {total} affichés"
            )

    def _export_results(self, mode: str, results: list[dict]) -> None:
        """
        Exporte les résultats en JSON avec fusion si le fichier existe déjà.

        Stratégie de fusion :
            - Items avec id connu → mis à jour (même id → écrasement)
            - Items sans id → mis à jour par source (nom de fichier capture)
            - Items absents de la session → conservés
            - Nouveaux items → ajoutés à la fin

        Args:
            mode:    "ressources" ou "equipements".
            results: Liste des résultats de la session courante.
        """
        import json
        from pathlib import Path

        output_path = self.tabs[mode]["output_path"].get().strip()
        if not output_path:
            from config import DEFAULT_OUTPUT_NAMES
            output_path = DEFAULT_OUTPUT_NAMES.get(mode, f"{mode}_resultats.json")
            self.tabs[mode]["output_path"].set(output_path)

        try:
            merged, updated, added = self._merge_with_existing(output_path, results)

            with open(output_path, "w", encoding="utf-8") as fh:
                json.dump(merged, fh, ensure_ascii=False, indent=2)

            summary = f"{len(merged)} total ({updated} mis à jour, {added} ajouté(s))"
            log.info(f"💾 {summary} → {output_path}")
            save_output_path(mode, str(Path(output_path).resolve()))
            messagebox.showinfo("✅ Export réussi", f"{summary}\n→ {output_path}")

        except Exception as exc:
            log.error(f"Export échoué : {exc}")
            messagebox.showerror("Erreur d'export", str(exc))

    @staticmethod
    def _merge_with_existing(
        output_path: str,
        new_results: list[dict],
    ) -> tuple[list[dict], int, int]:
        """
        Fusionne new_results avec le contenu existant de output_path.

        Args:
            output_path: Chemin du fichier JSON de destination.
            new_results: Résultats de la session courante.

        Returns:
            Tuple (liste_fusionnée, nb_mis_à_jour, nb_ajoutés).
        """
        import json
        from pathlib import Path

        if not Path(output_path).exists():
            return new_results, 0, len(new_results)

        try:
            with open(output_path, encoding="utf-8") as fh:
                existing: list[dict] = json.load(fh)
            if not isinstance(existing, list):
                existing = []
        except Exception:
            existing = []

        index_by_id:     dict[int, int] = {}
        index_by_source: dict[str, int] = {}

        for pos, item in enumerate(existing):
            item_id = item.get("id")
            if item_id is not None:
                index_by_id[item_id] = pos
            source = item.get("source", "")
            if source:
                index_by_source[source] = pos

        merged  = [dict(item) for item in existing]
        updated = 0
        added   = 0

        for new_item in new_results:
            new_id     = new_item.get("id")
            new_source = new_item.get("source", "")

            pos = None
            if new_id is not None:
                pos = index_by_id.get(new_id)
            if pos is None and new_source:
                pos = index_by_source.get(new_source)

            if pos is not None:
                merged[pos] = {**merged[pos], **new_item}
                if new_id is not None:
                    index_by_id[new_id] = pos
                if new_source:
                    index_by_source[new_source] = pos
                updated += 1
            else:
                new_pos = len(merged)
                merged.append(new_item)
                if new_id is not None:
                    index_by_id[new_id] = new_pos
                if new_source:
                    index_by_source[new_source] = new_pos
                added += 1

        return merged, updated, added

    # ══════════════════════════════════════════════════════════════
    #  BOUCLE DE MISE À JOUR (indicateurs animés)
    # ══════════════════════════════════════════════════════════════

    def _update_loop(self) -> None:
        """
        Boucle de rafraîchissement à 1 Hz des indicateurs d'état.

        Met à jour :
            - Statistiques pipeline (nettoyées / OCR / doublons / temps)
            - Animation LED pipeline
            - Animation LED capture
        """
        for mode, tab in self.tabs.items():
            pipeline = tab.get("pipeline")

            if pipeline and pipeline.is_running:
                stats            = pipeline.stats
                minutes, seconds = divmod(int(stats["elapsed"]), 60)
                tab["stats_label"].configure(
                    text=(
                        f"🧹{stats['cleaned']} "
                        f"🔍{stats['ocr']} "
                        f"🔄{stats['duplicates']} "
                        f"⏱{minutes:02d}:{seconds:02d}"
                    )
                )
                tab["blink"] = not tab["blink"]
                tab["indicator"].itemconfigure(
                    tab["indicator_id"],
                    fill="#0f8" if tab["blink"] else "#084",
                )
            else:
                tab["indicator"].itemconfigure(tab["indicator_id"], fill="gray")

        if self.click_capture.is_active:
            current_fill = self._capture_canvas.itemcget(
                self._capture_indicator_id, "fill"
            )
            new_fill = "#0f8" if current_fill == "#084" else "#084"
            self._capture_canvas.itemconfigure(self._capture_indicator_id, fill=new_fill)

        self.root.after(1000, self._update_loop)

    # ══════════════════════════════════════════════════════════════
    #  NETTOYAGE
    # ══════════════════════════════════════════════════════════════

    def cleanup(self) -> None:
        """Arrête proprement la capture avant fermeture de la fenêtre."""
        self.click_capture.stop()
