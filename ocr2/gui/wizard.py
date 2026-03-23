"""
gui/wizard.py — Assistant de configuration des coordonnées OCR
==============================================================
Responsabilité unique : guider l'utilisateur pas à pas dans la
définition des zones de lecture OCR sur une image de référence.

Le wizard parcourt 12 étapes (vs 13 précédemment) :
    crop, nom, niveau, type, prix_moyen,
    lot×1..×1000 (4 étapes), prix équip×1..×2,
    timing de capture.

Suppression vs version précédente :
    L'étape "Région capture" (capture_region) a été supprimée.
    La région de capture est désormais dérivée automatiquement du crop :
        left=crop.x1, top=crop.y1, width=crop.width, height=crop.height
    Il suffit donc de bien calibrer le crop sur la popup Dofus.
"""

from __future__ import annotations

import logging
from tkinter import filedialog, messagebox
from typing import Callable, Optional
import tkinter as tk
from tkinter import ttk

from PIL import Image

from config import (
    AppConfig, CropConfig, CaptureConfig,
    ZoneRect, LotRect, PopupRects,
    save_coords, get_config_manager,
    DEFAULT_COORDS, COORDS_FILE,
)
from gui.widgets import ZoomableCanvas

log = logging.getLogger("DofusHDV")


# ══════════════════════════════════════════════════════════════════
#  DÉFINITION DES ÉTAPES DU WIZARD (12 étapes)
# ══════════════════════════════════════════════════════════════════

WIZARD_STEPS: list[dict] = [
    {
        "key": "crop", "title": "Zone crop", "color": "#f44",
        "desc": (
            "Zone de recadrage ET position de la popup sur l'écran.\n"
            "x1,y1 = coin supérieur gauche absolu | x2,y2 = coin inférieur droit absolu.\n"
            "Cette zone est aussi utilisée comme région de capture mss."
        ),
        "fields": [("x1", 0), ("y1", 0), ("x2", 420), ("y2", 420)],
    },
    {
        "key": "nom", "title": "Zone nom", "color": "#4f4",
        "desc": "Zone de lecture du nom de l'objet.",
        "fields": [("x1", 83), ("y1", 70), ("x2", 380), ("y2", 91)],
    },
    {
        "key": "niveau", "title": "Zone niveau", "color": "#44f",
        "desc": "Zone de lecture du niveau.",
        "fields": [("x1", 83), ("y1", 94), ("x2", 143), ("y2", 108)],
    },
    {
        "key": "type", "title": "Zone type", "color": "#f4f",
        "desc": "Zone de lecture du type d'objet.",
        "fields": [("x1", 145), ("y1", 94), ("x2", 380), ("y2", 108)],
    },
    {
        "key": "prix_moyen", "title": "Zone prix moyen", "color": "#fa0",
        "desc": "Zone de lecture du prix moyen.",
        "fields": [("x1", 169), ("y1", 115), ("x2", 244), ("y2", 128)],
    },
    {
        "key": "lot_1", "title": "Lot x1", "color": "#0cc", "dual": True,
        "desc": "Zones quantite et prix pour le lot x1.",
        "fields": [
            ("lot_x1", 60), ("lot_y1", 250), ("lot_x2", 165), ("lot_y2", 272),
            ("prix_x1", 180), ("prix_y1", 250), ("prix_x2", 290), ("prix_y2", 272),
        ],
    },
    {
        "key": "lot_2", "title": "Lot x10", "color": "#0ac", "dual": True,
        "desc": "Zones quantite et prix pour le lot x10.",
        "fields": [
            ("lot_x1", 60), ("lot_y1", 282), ("lot_x2", 165), ("lot_y2", 312),
            ("prix_x1", 180), ("prix_y1", 282), ("prix_x2", 290), ("prix_y2", 312),
        ],
    },
    {
        "key": "lot_3", "title": "Lot x100", "color": "#08c", "dual": True,
        "desc": "Zones quantite et prix pour le lot x100.",
        "fields": [
            ("lot_x1", 60), ("lot_y1", 322), ("lot_x2", 165), ("lot_y2", 352),
            ("prix_x1", 180), ("prix_y1", 322), ("prix_x2", 290), ("prix_y2", 352),
        ],
    },
    {
        "key": "lot_4", "title": "Lot x1000", "color": "#06c", "dual": True,
        "desc": "Zones quantite et prix pour le lot x1000.",
        "fields": [
            ("lot_x1", 60), ("lot_y1", 362), ("lot_x2", 165), ("lot_y2", 383),
            ("prix_x1", 180), ("prix_y1", 362), ("prix_x2", 290), ("prix_y2", 383),
        ],
    },
    {
        "key": "equip_prix_1", "title": "Prix equip 1", "color": "#ca0",
        "desc": "Zone de prix principal pour les equipements.",
        "fields": [("x1", 131), ("y1", 236), ("x2", 283), ("y2", 263)],
    },
    {
        "key": "equip_prix_2", "title": "Prix equip 2 (repli)", "color": "#c80",
        "desc": "Zone de prix de repli pour les equipements.",
        "fields": [("x1", 131), ("y1", 263), ("x2", 283), ("y2", 288)],
    },
    {
        "key": "capture_timing", "title": "Timing capture", "color": "#0f8",
        "desc": "Delai apres clic (ms) avant la capture.",
        "fields": [("click_delay_ms", 500), ("debounce_ms", 300)],
    },
]


# ══════════════════════════════════════════════════════════════════
#  ASSISTANT DE CONFIGURATION
# ══════════════════════════════════════════════════════════════════

class CoordinatesWizard:
    """
    Fenetre modale guidant la configuration des zones OCR.
    12 etapes — la region de capture est derivee automatiquement du crop.
    """

    STEPS = WIZARD_STEPS

    def __init__(
        self,
        parent:        tk.Widget,
        existing_data: Optional[dict]                             = None,
        on_done:       Optional[Callable[[Optional[dict]], None]] = None,
    ) -> None:
        self._parent  = parent
        self._on_done = on_done

        self._current_step_index: int  = 0
        self._current_field_index: int = 0
        self._step_values: dict[str, dict[str, int]] = {}
        self._field_vars:  dict[str, tk.IntVar]      = {}

        self._prefill_values(existing_data or DEFAULT_COORDS)

        self._window = tk.Toplevel(parent)
        self._window.title("Configuration des coordonnees")
        self._window.geometry("1100x750")
        self._window.transient(parent)
        self._window.grab_set()
        self._window.protocol("WM_DELETE_WINDOW", self._cancel_and_reset)

        self._build_ui()
        self._show_step(0)

    # ── Prefill ────────────────────────────────────────────────────

    def _prefill_values(self, config_data: dict) -> None:
        """Initialise _step_values depuis un dict de configuration brut."""
        crop = config_data.get("crop", DEFAULT_COORDS["crop"])
        self._step_values["crop"] = {
            "x1": crop[0], "y1": crop[1], "x2": crop[2], "y2": crop[3],
        }

        popup = config_data.get("popup_rects", DEFAULT_COORDS["popup_rects"])
        for key in ("nom", "niveau", "type", "prix_moyen"):
            rect = popup.get(key, DEFAULT_COORDS["popup_rects"][key])
            self._step_values[key] = {
                "x1": rect[0], "y1": rect[1], "x2": rect[2], "y2": rect[3],
            }

        lots = popup.get("lots", DEFAULT_COORDS["popup_rects"]["lots"])
        for i, lot_row in enumerate(lots):
            default_lot = DEFAULT_COORDS["popup_rects"]["lots"][i]
            lot_rect    = lot_row.get("lot",  default_lot["lot"])
            prix_rect   = lot_row.get("prix", default_lot["prix"])
            self._step_values[f"lot_{i + 1}"] = {
                "lot_x1":  lot_rect[0],  "lot_y1":  lot_rect[1],
                "lot_x2":  lot_rect[2],  "lot_y2":  lot_rect[3],
                "prix_x1": prix_rect[0], "prix_y1": prix_rect[1],
                "prix_x2": prix_rect[2], "prix_y2": prix_rect[3],
            }

        equip_rects = config_data.get(
            "equip_price_rects", DEFAULT_COORDS["equip_price_rects"]
        )
        for i, rect in enumerate(equip_rects):
            self._step_values[f"equip_prix_{i + 1}"] = {
                "x1": rect[0], "y1": rect[1], "x2": rect[2], "y2": rect[3],
            }

        capture = config_data.get("capture", DEFAULT_COORDS["capture"])
        self._step_values["capture_timing"] = {
            "click_delay_ms": int(capture.get("click_delay", 0.5) * 1000),
            "debounce_ms":    int(capture.get("debounce",    0.3) * 1000),
        }

    # ── Construction de l'interface ────────────────────────────────

    def _build_ui(self) -> None:
        main_frame = ttk.Frame(self._window, padding=10)
        main_frame.pack(fill=tk.BOTH, expand=True)

        header = ttk.Frame(main_frame)
        header.pack(fill=tk.X, pady=(0, 8))

        self._step_title_label = ttk.Label(header, font=("Segoe UI", 13, "bold"))
        self._step_title_label.pack(anchor="w")

        self._step_number_label = ttk.Label(header, font=("Segoe UI", 9), foreground="gray")
        self._step_number_label.pack(anchor="w")

        self._step_desc_label = ttk.Label(header, wraplength=1060)
        self._step_desc_label.pack(anchor="w", pady=(4, 0))

        body = ttk.PanedWindow(main_frame, orient=tk.HORIZONTAL)
        body.pack(fill=tk.BOTH, expand=True)

        left_panel = ttk.Frame(body, width=280)
        body.add(left_panel, weight=0)

        coords_frame = ttk.LabelFrame(left_panel, text="Coordonnees", padding=8)
        coords_frame.pack(fill=tk.BOTH, expand=True, padx=(0, 4))

        self._fields_container = ttk.Frame(coords_frame)
        self._fields_container.pack(fill=tk.BOTH, expand=True)

        self._field_hint_label = ttk.Label(
            coords_frame, font=("Segoe UI", 8, "italic"),
            foreground="#0a0", wraplength=250,
        )
        self._field_hint_label.pack(anchor="w", pady=(8, 0))

        ttk.Button(
            coords_frame, text="Charger image", command=self._load_reference_image
        ).pack(fill=tk.X, pady=(8, 0))

        right_panel = ttk.Frame(body)
        body.add(right_panel, weight=1)

        self._zoom_canvas = ZoomableCanvas(
            right_panel, on_pixel_click=self._on_pixel_click
        )
        self._zoom_canvas.pack(fill=tk.BOTH, expand=True)

        nav_bar = ttk.Frame(main_frame)
        nav_bar.pack(fill=tk.X, pady=(8, 0))

        ttk.Button(nav_bar, text="Annuler", command=self._cancel_and_reset).pack(side=tk.LEFT)
        ttk.Button(nav_bar, text="Reinit.", command=self._reset_current_step).pack(
            side=tk.LEFT, padx=(10, 0)
        )

        self._next_button = ttk.Button(nav_bar, text="Suivant", command=self._go_next)
        self._next_button.pack(side=tk.RIGHT)

        self._prev_button = ttk.Button(nav_bar, text="Precedent", command=self._go_prev)
        self._prev_button.pack(side=tk.RIGHT, padx=(0, 10))

        self._progress_bar = ttk.Progressbar(main_frame, maximum=len(WIZARD_STEPS))
        self._progress_bar.pack(fill=tk.X, pady=(8, 0))

    # ── Affichage d'une etape ──────────────────────────────────────

    def _show_step(self, step_index: int) -> None:
        self._current_step_index  = step_index
        step  = WIZARD_STEPS[step_index]
        total = len(WIZARD_STEPS)

        self._step_title_label.configure(text=f"  {step['title']}")
        self._step_number_label.configure(text=f"{step_index + 1}/{total}")
        self._step_desc_label.configure(text=step["desc"])
        self._progress_bar["value"] = step_index + 1

        self._prev_button.configure(
            state="normal" if step_index > 0 else "disabled"
        )
        self._next_button.configure(
            text="Sauver" if step_index == total - 1 else "Suivant"
        )

        for widget in self._fields_container.winfo_children():
            widget.destroy()

        self._field_vars          = {}
        self._current_field_index = 0
        saved_values = self._step_values.get(step["key"], {})

        for field_index, (field_name, default_value) in enumerate(step["fields"]):
            row = ttk.Frame(self._fields_container)
            row.pack(fill=tk.X, pady=2)

            ttk.Label(row, text=f"{field_name}:", width=14, anchor="e").pack(side=tk.LEFT)

            var = tk.IntVar(value=saved_values.get(field_name, default_value))
            spinbox = ttk.Spinbox(
                row, from_=0, to=9999, textvariable=var, width=7,
                command=self._update_overlays,
            )
            spinbox.pack(side=tk.LEFT, padx=(4, 0))
            spinbox.bind("<KeyRelease>", lambda e: self._update_overlays())

            ttk.Button(
                row, text="cible", width=5,
                command=lambda idx=field_index: self._select_field(idx),
            ).pack(side=tk.LEFT, padx=(2, 0))

            self._field_vars[field_name] = var

        self._update_field_hint()
        self._update_overlays()

    # ── Gestion des champs et du clic image ───────────────────────

    def _select_field(self, field_index: int) -> None:
        self._current_field_index = field_index
        self._update_field_hint()

    def _update_field_hint(self) -> None:
        step   = WIZARD_STEPS[self._current_step_index]
        fields = step["fields"]
        if self._current_field_index < len(fields):
            field_name = fields[self._current_field_index][0]
            self._field_hint_label.configure(text=f"Champ actif: {field_name}")
            self._zoom_canvas.set_hint(field_name)
        else:
            self._field_hint_label.configure(text="Tous les champs remplis")
            self._zoom_canvas.set_hint("")

    def _on_pixel_click(self, pixel_x: int, pixel_y: int) -> None:
        step   = WIZARD_STEPS[self._current_step_index]
        fields = step["fields"]

        if self._current_field_index >= len(fields):
            self._current_field_index = 0

        field_name = fields[self._current_field_index][0]
        is_x_coord = "x" in field_name or field_name in ("left", "width")
        value      = pixel_x if is_x_coord else pixel_y

        self._field_vars[field_name].set(value)

        self._current_field_index = (
            (self._current_field_index + 1) % len(fields)
        )
        self._update_field_hint()
        self._update_overlays()

    def _update_overlays(self) -> None:
        overlays = []
        step     = WIZARD_STEPS[self._current_step_index]
        color    = step.get("color", "#f00")

        try:
            if step.get("dual"):
                overlays.append({
                    "rect": (
                        self._field_vars["lot_x1"].get(),
                        self._field_vars["lot_y1"].get(),
                        self._field_vars["lot_x2"].get(),
                        self._field_vars["lot_y2"].get(),
                    ),
                    "color": color, "label": "lot", "width": 2,
                })
                overlays.append({
                    "rect": (
                        self._field_vars["prix_x1"].get(),
                        self._field_vars["prix_y1"].get(),
                        self._field_vars["prix_x2"].get(),
                        self._field_vars["prix_y2"].get(),
                    ),
                    "color": "#f80", "label": "prix", "width": 2,
                })

            elif step["key"] != "capture_timing":
                overlays.append({
                    "rect": (
                        self._field_vars["x1"].get(),
                        self._field_vars["y1"].get(),
                        self._field_vars["x2"].get(),
                        self._field_vars["y2"].get(),
                    ),
                    "color": color, "label": step["key"], "width": 2,
                })

        except (KeyError, tk.TclError):
            pass

        self._zoom_canvas.set_overlays(overlays)

    # ── Sauvegarde de l'etape courante ────────────────────────────

    def _save_current_step(self) -> None:
        step = WIZARD_STEPS[self._current_step_index]
        self._step_values[step["key"]] = {
            name: var.get()
            for name, var in self._field_vars.items()
        }

    # ── Navigation ────────────────────────────────────────────────

    def _go_next(self) -> None:
        self._save_current_step()
        if self._current_step_index < len(WIZARD_STEPS) - 1:
            self._show_step(self._current_step_index + 1)
        else:
            self._save_and_close()

    def _go_prev(self) -> None:
        self._save_current_step()
        if self._current_step_index > 0:
            self._show_step(self._current_step_index - 1)

    def _reset_current_step(self) -> None:
        step = WIZARD_STEPS[self._current_step_index]
        for field_name, default_value in step["fields"]:
            if field_name in self._field_vars:
                self._field_vars[field_name].set(default_value)
        self._current_field_index = 0
        self._update_field_hint()
        self._update_overlays()

    def _load_reference_image(self) -> None:
        file_path = filedialog.askopenfilename(
            filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp")]
        )
        if file_path:
            try:
                self._zoom_canvas.set_image(Image.open(file_path).convert("RGB"))
                self._update_overlays()
            except Exception as exc:
                messagebox.showerror("Erreur chargement image", str(exc))

    # ── Finalisation ──────────────────────────────────────────────

    def _save_and_close(self) -> None:
        self._save_current_step()
        config_data = self._build_coords_data()

        crop = config_data["crop"]
        if crop[2] <= crop[0] or crop[3] <= crop[1]:
            messagebox.showerror(
                "Crop invalide",
                "La zone crop est invalide (x2 <= x1 ou y2 <= y1).\n"
                "Corrigez l'etape 'Zone crop'."
            )
            return

        save_coords(config_data)
        messagebox.showinfo("Sauvegarde", f"Configuration sauvegardee dans {COORDS_FILE}")
        self._window.destroy()

        if self._on_done:
            self._on_done(config_data)

    def _cancel_and_reset(self) -> None:
        if messagebox.askyesno("Annuler", "Revenir aux coordonnees par defaut ?"):
            from config import _apply_coords
            _apply_coords(DEFAULT_COORDS)
            self._window.destroy()
            if self._on_done:
                self._on_done(None)

    # ── Construction du dict resultat ─────────────────────────────

    def _build_coords_data(self) -> dict:
        """
        Construit le dict de configuration final depuis _step_values.

        Note : la region de capture n'est plus stockee — elle est derivee
        automatiquement du crop dans CropConfig.to_mss_region().
        """
        values = self._step_values
        crop   = values["crop"]

        lots = []
        for i in range(1, 5):
            lot_vals = values.get(f"lot_{i}", {})
            lots.append({
                "lot": [
                    lot_vals.get("lot_x1", 0), lot_vals.get("lot_y1", 0),
                    lot_vals.get("lot_x2", 0), lot_vals.get("lot_y2", 0),
                ],
                "prix": [
                    lot_vals.get("prix_x1", 0), lot_vals.get("prix_y1", 0),
                    lot_vals.get("prix_x2", 0), lot_vals.get("prix_y2", 0),
                ],
            })

        equip_rects = []
        for i in range(1, 3):
            ev = values.get(f"equip_prix_{i}", {})
            equip_rects.append([
                ev.get("x1", 0), ev.get("y1", 0),
                ev.get("x2", 0), ev.get("y2", 0),
            ])

        capture_timing = values.get("capture_timing", {})

        return {
            "crop": [crop["x1"], crop["y1"], crop["x2"], crop["y2"]],
            "popup_rects": {
                "nom":        [values["nom"]["x1"],        values["nom"]["y1"],
                               values["nom"]["x2"],        values["nom"]["y2"]],
                "niveau":     [values["niveau"]["x1"],     values["niveau"]["y1"],
                               values["niveau"]["x2"],     values["niveau"]["y2"]],
                "type":       [values["type"]["x1"],       values["type"]["y1"],
                               values["type"]["x2"],       values["type"]["y2"]],
                "prix_moyen": [values["prix_moyen"]["x1"], values["prix_moyen"]["y1"],
                               values["prix_moyen"]["x2"], values["prix_moyen"]["y2"]],
                "lots": lots,
            },
            "equip_price_rects": equip_rects,
            "capture": {
                "color_tolerance_pct": get_config_manager().config.capture.color_tolerance_pct,
                "click_delay": capture_timing.get("click_delay_ms", 500) / 1000.0,
                "debounce":    capture_timing.get("debounce_ms",    300) / 1000.0,
            },
        }
