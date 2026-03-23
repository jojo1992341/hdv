"""
gui/widgets.py — Widgets tkinter réutilisables
===============================================
Responsabilité unique : fournir deux widgets indépendants
utilisables dans n'importe quelle fenêtre tkinter.

    TextHandler      — Handler logging qui redirige les messages
                       vers un widget ScrolledText.

    ZoomableCanvas   — Canvas tkinter avec zoom molette, pan clic-droit,
                       affichage d'image PIL et overlays rectangulaires.
                       Utilisé dans CoordinatesWizard pour la prévisualisation.

Renommages vs hdv-v10.py (méthodes ZoomableCanvas) :
    _zo    → zoom_out          _zi_fn → zoom_in
    _zf    → zoom_fit          _z1    → zoom_reset
    _zc    → _zoom_to_level_centered
    _zcur  → _zoom_to_level_at_cursor
    _cen   → _center_image
    _mw    → _on_mouse_wheel   _mwd   → _on_mouse_wheel_linux
    _ps    → _on_pan_start     _pm    → _on_pan_move
    _mm    → _on_mouse_move    _lc    → _on_left_click
    _render→ _render           (inchangé — déjà lisible)
    _c2p   → _canvas_to_pixel
    _zi    → _zoom_index       (attribut — renommé pour éviter le conflit
                                avec la méthode zoom_in dans l'original)
"""

from __future__ import annotations

import logging
import tkinter as tk
from tkinter import ttk
from typing import Callable, Optional

from PIL import Image, ImageDraw, ImageTk


# ══════════════════════════════════════════════════════════════════
#  TEXT HANDLER — LOGGING → SCROLLEDTEXT
# ══════════════════════════════════════════════════════════════════

class TextHandler(logging.Handler):
    """
    Handler logging qui redirige les entrées de log vers un widget
    tkinter ScrolledText.

    Les messages sont ajoutés dans le thread principal via widget.after()
    pour respecter la thread-safety tkinter.

    Usage :
        handler = TextHandler(scrolled_text_widget)
        handler.setFormatter(logging.Formatter("%(asctime)s │ %(message)s"))
        logging.getLogger("DofusHDV").addHandler(handler)
    """

    __slots__ = ("widget",)

    def __init__(self, widget: tk.Text) -> None:
        super().__init__()
        self.widget = widget

    def emit(self, record: logging.LogRecord) -> None:
        """Formate le message et le planifie dans le thread UI."""
        message = self.format(record) + "\n"
        self.widget.after(0, self._append_to_widget, message)

    def _append_to_widget(self, message: str) -> None:
        """Insère le message dans le widget et fait défiler vers la fin."""
        self.widget.configure(state="normal")
        self.widget.insert(tk.END, message)
        self.widget.see(tk.END)
        self.widget.configure(state="disabled")


# ══════════════════════════════════════════════════════════════════
#  ZOOMABLE CANVAS
# ══════════════════════════════════════════════════════════════════

class ZoomableCanvas(tk.Frame):
    """
    Canvas tkinter avec zoom, pan et overlays rectangulaires.

    Fonctionnalités :
        - Zoom molette (ou boutons +/−) avec niveaux discrets
        - Pan clic-droit (ou clic-milieu)
        - Affichage d'image PIL redimensionnée à la volée
        - Overlays rectangulaires colorés avec libellé (zones OCR)
        - Coordonnées pixel affichées en temps réel sous le curseur
        - Callback on_pixel_click(px, py) sur clic gauche

    Niveaux de zoom disponibles (ZoomableCanvas.ZOOM_LEVELS) :
        25%, 50%, 75%, 100%, 150%, 200%, 300%, 400%, 600%, 800%

    Usage :
        canvas = ZoomableCanvas(parent, on_pixel_click=my_callback)
        canvas.set_image(pil_image)
        canvas.set_overlays([{"rect": (10,10,100,50), "color": "#f00", "label": "nom"}])
    """

    # Niveaux de zoom disponibles (facteurs multiplicatifs)
    ZOOM_LEVELS: list[float] = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0]

    # Index du zoom par défaut (1.0 = 100%)
    DEFAULT_ZOOM_INDEX: int = 3

    def __init__(
        self,
        parent:          tk.Widget,
        on_pixel_click:  Optional[Callable[[int, int], None]] = None,
        **kwargs,
    ) -> None:
        super().__init__(parent, **kwargs)

        # État image et zoom
        self._image:      Optional[Image.Image]    = None
        self._zoom_index: int                      = self.DEFAULT_ZOOM_INDEX
        self._offset_x:   float                    = 0.0
        self._offset_y:   float                    = 0.0

        # État pan (clic-droit / clic-milieu)
        self._pan_start_x:  int   = 0
        self._pan_start_y:  int   = 0
        self._pan_origin_x: float = 0.0
        self._pan_origin_y: float = 0.0

        # Photo tkinter (référence gardée pour éviter le garbage collection)
        self._photo_image: Optional[ImageTk.PhotoImage] = None

        # Overlays : liste de dicts {"rect", "color", "label", "width"}
        self._overlays: list[dict] = []

        # Callback clic gauche
        self.on_pixel_click = on_pixel_click

        # ── Barre d'outils ─────────────────────────────────────────
        toolbar = ttk.Frame(self)
        toolbar.pack(fill=tk.X, pady=(0, 2))

        ttk.Button(toolbar, text="−", width=3, command=self.zoom_out).pack(side=tk.LEFT)

        self._zoom_label = ttk.Label(
            toolbar, text="100%", width=8, anchor="center",
            font=("Consolas", 9, "bold"),
        )
        self._zoom_label.pack(side=tk.LEFT, padx=2)

        ttk.Button(toolbar, text="+", width=3, command=self.zoom_in).pack(side=tk.LEFT)
        ttk.Button(toolbar, text="⊡", width=4, command=self.zoom_fit).pack(side=tk.LEFT, padx=(8, 0))
        ttk.Button(toolbar, text="1:1", width=4, command=self.zoom_reset).pack(side=tk.LEFT, padx=2)

        self._coords_label = ttk.Label(
            toolbar, text="x:— y:—",
            font=("Consolas", 9), foreground="#888",
        )
        self._coords_label.pack(side=tk.RIGHT, padx=(10, 0))

        self._hint_label = ttk.Label(
            toolbar, text="",
            font=("Segoe UI", 8), foreground="#0a0",
        )
        self._hint_label.pack(side=tk.RIGHT, padx=(10, 0))

        # ── Canvas principal ───────────────────────────────────────
        self.canvas = tk.Canvas(
            self,
            bg="#1a1a2e",
            highlightthickness=1,
            highlightbackground="#444",
            cursor="crosshair",
        )
        self.canvas.pack(fill=tk.BOTH, expand=True)

        # ── Bindings ───────────────────────────────────────────────
        self.canvas.bind("<MouseWheel>",   self._on_mouse_wheel)
        self.canvas.bind("<Button-4>",     lambda e: self._on_mouse_wheel_linux(+1, e))
        self.canvas.bind("<Button-5>",     lambda e: self._on_mouse_wheel_linux(-1, e))
        self.canvas.bind("<ButtonPress-3>", self._on_pan_start)
        self.canvas.bind("<B3-Motion>",    self._on_pan_move)
        self.canvas.bind("<ButtonPress-2>", self._on_pan_start)
        self.canvas.bind("<B2-Motion>",    self._on_pan_move)
        self.canvas.bind("<Motion>",       self._on_mouse_move)
        self.canvas.bind("<ButtonPress-1>", self._on_left_click)
        self.canvas.bind("<Configure>",    lambda e: self._render())

    # ── Propriété zoom ─────────────────────────────────────────────

    @property
    def zoom_factor(self) -> float:
        """Facteur de zoom courant (ex: 1.5 pour 150%)."""
        return self.ZOOM_LEVELS[self._zoom_index]

    # ── API publique ───────────────────────────────────────────────

    def set_image(self, image: Image.Image) -> None:
        """
        Charge une nouvelle image et ajuste le zoom pour l'afficher entièrement.

        Args:
            image: Image PIL (tout mode — convertie en RGB).
        """
        self._image = image.convert("RGB")
        self.zoom_fit()

    def set_overlays(self, overlays: list[dict]) -> None:
        """
        Définit les overlays rectangulaires à dessiner sur l'image.

        Chaque overlay est un dict avec les clés :
            rect  : tuple (x1, y1, x2, y2) en coordonnées image
            color : couleur CSS (ex: "#f00")
            label : texte affiché en haut-gauche du rectangle
            width : épaisseur du contour en pixels (défaut : 2)

        Args:
            overlays: Liste de dicts d'overlay.
        """
        self._overlays = overlays
        self._render()

    def set_hint(self, text: str) -> None:
        """
        Affiche un texte d'indication dans la barre d'outils.
        Utilisé par CoordinatesWizard pour indiquer le champ en cours.

        Args:
            text: Texte à afficher (vide pour effacer).
        """
        self._hint_label.configure(text=text)

    # ── Contrôles de zoom ──────────────────────────────────────────

    def zoom_in(self) -> None:
        """Augmente le zoom d'un niveau (centré sur le centre du canvas)."""
        if self._zoom_index < len(self.ZOOM_LEVELS) - 1:
            self._zoom_to_level_centered(self._zoom_index + 1)

    def zoom_out(self) -> None:
        """Réduit le zoom d'un niveau (centré sur le centre du canvas)."""
        if self._zoom_index > 0:
            self._zoom_to_level_centered(self._zoom_index - 1)

    def zoom_reset(self) -> None:
        """Remet le zoom à 100% (1:1) et centre l'image."""
        self._zoom_index = self.DEFAULT_ZOOM_INDEX
        self._center_image()
        self._render()

    def zoom_fit(self) -> None:
        """
        Ajuste le zoom pour que l'image tienne dans le canvas.
        Choisit le niveau de zoom le plus élevé qui ne dépasse pas
        les dimensions du canvas.
        """
        if not self._image:
            self._render()
            return

        canvas_w = self.canvas.winfo_width()  or 400
        canvas_h = self.canvas.winfo_height() or 400
        img_w, img_h = self._image.size

        if not img_w or not img_h:
            return

        fit_factor      = min(canvas_w / img_w, canvas_h / img_h, 1.0)
        best_zoom_index = 0

        for i, level in enumerate(self.ZOOM_LEVELS):
            if level <= fit_factor:
                best_zoom_index = i

        self._zoom_index = best_zoom_index
        self._center_image()
        self._render()

    # ── Gestion interne du zoom ────────────────────────────────────

    def _zoom_to_level_centered(self, new_index: int) -> None:
        """
        Change le zoom en conservant le point central du canvas.

        Args:
            new_index: Nouvel index dans ZOOM_LEVELS.
        """
        canvas_w = self.canvas.winfo_width()  or 400
        canvas_h = self.canvas.winfo_height() or 400
        center_x, center_y = canvas_w / 2, canvas_h / 2

        pixel_x, pixel_y  = self._canvas_to_pixel(center_x, center_y)
        self._zoom_index   = new_index
        new_zoom           = self.zoom_factor
        self._offset_x     = center_x - pixel_x * new_zoom
        self._offset_y     = center_y - pixel_y * new_zoom
        self._render()

    def _zoom_to_level_at_cursor(self, new_index: int, cursor_x: float, cursor_y: float) -> None:
        """
        Change le zoom en conservant le point sous le curseur.

        Args:
            new_index: Nouvel index dans ZOOM_LEVELS.
            cursor_x:  Position X du curseur dans le canvas.
            cursor_y:  Position Y du curseur dans le canvas.
        """
        pixel_x, pixel_y = self._canvas_to_pixel(cursor_x, cursor_y)
        self._zoom_index  = new_index
        new_zoom          = self.zoom_factor
        self._offset_x    = cursor_x - pixel_x * new_zoom
        self._offset_y    = cursor_y - pixel_y * new_zoom
        self._render()

    def _center_image(self) -> None:
        """Centre l'image dans le canvas selon le zoom courant."""
        if not self._image:
            return
        canvas_w = self.canvas.winfo_width()  or 400
        canvas_h = self.canvas.winfo_height() or 400
        img_w, img_h = self._image.size
        zoom = self.zoom_factor
        self._offset_x = (canvas_w - img_w * zoom) / 2
        self._offset_y = (canvas_h - img_h * zoom) / 2

    def _canvas_to_pixel(self, canvas_x: float, canvas_y: float) -> tuple[int, int]:
        """
        Convertit des coordonnées canvas en coordonnées pixel image.

        Args:
            canvas_x: Coordonnée X dans le canvas (pixels écran).
            canvas_y: Coordonnée Y dans le canvas (pixels écran).

        Returns:
            Tuple (pixel_x, pixel_y) dans l'image originale.
        """
        zoom = self.zoom_factor
        return (
            int((canvas_x - self._offset_x) / zoom),
            int((canvas_y - self._offset_y) / zoom),
        )

    # ── Événements souris ─────────────────────────────────────────

    def _on_mouse_wheel(self, event: tk.Event) -> None:
        """Zoom à la molette (Windows/macOS)."""
        if not self._image:
            return
        if event.delta > 0 and self._zoom_index < len(self.ZOOM_LEVELS) - 1:
            self._zoom_to_level_at_cursor(self._zoom_index + 1, event.x, event.y)
        elif event.delta < 0 and self._zoom_index > 0:
            self._zoom_to_level_at_cursor(self._zoom_index - 1, event.x, event.y)

    def _on_mouse_wheel_linux(self, direction: int, event: tk.Event) -> None:
        """Zoom à la molette (Linux — Button-4 / Button-5)."""
        if direction > 0 and self._zoom_index < len(self.ZOOM_LEVELS) - 1:
            self._zoom_to_level_at_cursor(self._zoom_index + 1, event.x, event.y)
        elif direction < 0 and self._zoom_index > 0:
            self._zoom_to_level_at_cursor(self._zoom_index - 1, event.x, event.y)

    def _on_pan_start(self, event: tk.Event) -> None:
        """Mémorise le point de départ du pan."""
        self._pan_start_x  = event.x
        self._pan_start_y  = event.y
        self._pan_origin_x = self._offset_x
        self._pan_origin_y = self._offset_y

    def _on_pan_move(self, event: tk.Event) -> None:
        """Déplace l'image selon le mouvement de la souris (pan)."""
        self._offset_x = self._pan_origin_x + event.x - self._pan_start_x
        self._offset_y = self._pan_origin_y + event.y - self._pan_start_y
        self._render()

    def _on_mouse_move(self, event: tk.Event) -> None:
        """Met à jour l'affichage des coordonnées pixel sous le curseur."""
        if not self._image:
            self._coords_label.configure(text="x:— y:—")
            return

        pixel_x, pixel_y = self._canvas_to_pixel(event.x, event.y)
        img_w, img_h     = self._image.size

        if 0 <= pixel_x < img_w and 0 <= pixel_y < img_h:
            r, g, b = self._image.getpixel((pixel_x, pixel_y))
            self._coords_label.configure(
                text=f"x:{pixel_x} y:{pixel_y} RGB({r},{g},{b})"
            )
        else:
            self._coords_label.configure(text=f"x:{pixel_x} y:{pixel_y}")

    def _on_left_click(self, event: tk.Event) -> None:
        """Transmet les coordonnées pixel au callback on_pixel_click."""
        if self._image and self.on_pixel_click:
            pixel_x, pixel_y = self._canvas_to_pixel(event.x, event.y)
            img_w, img_h     = self._image.size
            if 0 <= pixel_x < img_w and 0 <= pixel_y < img_h:
                self.on_pixel_click(pixel_x, pixel_y)

    # ── Rendu ─────────────────────────────────────────────────────

    def _render(self) -> None:
        """
        Redessine le canvas : image redimensionnée + overlays.

        Appelé après chaque changement de zoom, pan, overlay ou
        redimensionnement du canvas (binding Configure).
        """
        self.canvas.delete("all")
        zoom = self.zoom_factor
        self._zoom_label.configure(text=f"{int(zoom * 100)}%")

        if not self._image:
            canvas_w = self.canvas.winfo_width()  or 400
            canvas_h = self.canvas.winfo_height() or 400
            self.canvas.create_text(
                canvas_w // 2, canvas_h // 2,
                text="📁 Charger image",
                fill="#668",
                font=("Segoe UI", 11),
            )
            return

        img_w, img_h    = self._image.size
        display_w       = max(int(img_w * zoom), 1)
        display_h       = max(int(img_h * zoom), 1)

        # Redimensionnement : NEAREST pour les grands zooms (netteté pixel),
        # BILINEAR sinon (douceur)
        resample        = Image.NEAREST if zoom >= 2.0 else Image.BILINEAR
        display_image   = self._image.resize((display_w, display_h), resample)

        # Dessin des overlays sur l'image redimensionnée
        if self._overlays:
            draw = ImageDraw.Draw(display_image)
            for overlay in self._overlays:
                rect = overlay.get("rect")
                if not rect:
                    continue
                x1, y1, x2, y2 = rect
                color           = overlay.get("color", "#f00")
                thickness       = max(1, overlay.get("width", 2))
                draw.rectangle(
                    [int(x1 * zoom), int(y1 * zoom),
                     int(x2 * zoom), int(y2 * zoom)],
                    outline=color,
                    width=thickness,
                )
                label = overlay.get("label", "")
                if label:
                    draw.text(
                        (int(x1 * zoom) + 2, max(int(y1 * zoom) - 14, 0)),
                        label,
                        fill=color,
                    )

        self._photo_image = ImageTk.PhotoImage(display_image)
        self.canvas.create_image(
            int(self._offset_x),
            int(self._offset_y),
            image=self._photo_image,
            anchor="nw",
        )
