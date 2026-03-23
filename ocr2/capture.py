"""
capture.py — Capture d'écran automatique post-clic souris
==========================================================
Responsabilité unique : écouter les clics gauche de la souris,
déclencher une capture d'écran après un délai configurable,
recadrer selon la zone configurée et sauvegarder le fichier
dans le répertoire de sortie.

Suppression vs version précédente :
    Le remplacement des couleurs dorées Dofus (_replace_colors,
    _build_color_masks, _TARGET_COLORS, _REPLACE_COLOR) a été supprimé.
    L'inversion des couleurs est désormais faite directement dans
    ocr_engine.ocr_zone() (cv2.bitwise_not) au moment de l'OCR,
    sur la zone cible uniquement — pas sur l'image entière.

Dépendances optionnelles :
    mss    — capture d'écran (pip install mss)
    pynput — écoute souris   (pip install pynput)
    Si absentes, ClickCapture est instanciable mais inactive.
"""

from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from typing import Callable, Optional

from PIL import Image

from config import CaptureConfig, CropConfig

log = logging.getLogger("DofusHDV")

# ── Détection des dépendances optionnelles ────────────────────────
try:
    import mss as mss_lib
    MSS_AVAILABLE = True
except ImportError:
    MSS_AVAILABLE = False

try:
    from pynput import mouse as pynput_mouse
    PYNPUT_AVAILABLE = True
except ImportError:
    PYNPUT_AVAILABLE = False


# ══════════════════════════════════════════════════════════════════
#  CLASSE PRINCIPALE
# ══════════════════════════════════════════════════════════════════

class ClickCapture:
    """
    Capture d'écran déclenchée automatiquement après chaque clic gauche.

    Flux de fonctionnement :
        1. start()  → démarre l'écoute pynput (thread daemon)
        2. clic gauche détecté → timer `click_delay` lancé
        3. timer expiré → _do_capture() exécuté dans un thread
        4. capture mss → sauvegarde PNG brute (pas de traitement couleur)
        5. on_capture(filepath) appelé si fourni
        6. stop() → annule le timer en cours, arrête le listener

    Thread-safety :
        _capture_lock  sérialise les captures simultanées.
        _timer_lock    protège _pending_timer contre les races.
    """

    def __init__(
        self,
        output_dir:  str,
        config:      Optional[CaptureConfig] = None,
        on_capture:  Optional[Callable[[str], None]] = None,
    ) -> None:
        self.output_dir = output_dir
        self.on_capture = on_capture

        cfg = config or CaptureConfig()
        self._crop          = CropConfig()   # mis à jour via update_config
        self._click_delay   = cfg.click_delay
        self._debounce      = cfg.debounce
        self._tolerance_pct = cfg.color_tolerance_pct

        self._active        = False
        self._stopping      = False
        self._capture_count = 0
        self._listener      = None
        self._pending_timer: Optional[threading.Timer] = None

        self._capture_lock = threading.Lock()
        self._timer_lock   = threading.Lock()

    # ── Propriétés publiques ───────────────────────────────────────

    @property
    def is_active(self) -> bool:
        return self._active

    @property
    def capture_count(self) -> int:
        return self._capture_count

    @property
    def click_delay(self) -> float:
        return self._click_delay

    @property
    def is_available(self) -> bool:
        return MSS_AVAILABLE and PYNPUT_AVAILABLE

    # ── Configuration dynamique ────────────────────────────────────

    def update_output_dir(self, directory: str) -> None:
        self.output_dir = directory

    def update_config(
        self,
        crop:          Optional[dict]  = None,
        tolerance_pct: Optional[int]   = None,
        click_delay:   Optional[float] = None,
        debounce:      Optional[float] = None,
    ) -> None:
        """
        Met à jour les paramètres de capture à chaud.

        Args:
            crop:          Dictionnaire {'x1','y1','x2','y2'} ou liste [x1,y1,x2,y2].
            tolerance_pct: Conservé pour compatibilité — non utilisé.
            click_delay:   Nouveau délai post-clic en secondes.
            debounce:      Nouveau délai anti-rebond en secondes.
        """
        if crop is not None:
            if isinstance(crop, (list, tuple)):
                self._crop = CropConfig.from_list(list(crop))
            elif isinstance(crop, dict):
                self._crop = CropConfig(
                    x1=crop.get("x1", 0), y1=crop.get("y1", 0),
                    x2=crop.get("x2", 420), y2=crop.get("y2", 420),
                )

        if tolerance_pct is not None:
            self._tolerance_pct = tolerance_pct

        if click_delay is not None:
            self._click_delay = click_delay

        if debounce is not None:
            self._debounce = debounce

    # ── Cycle de vie ───────────────────────────────────────────────

    def start(self) -> bool:
        if not self.is_available:
            log.warning("📸 mss ou pynput non installé — capture indisponible")
            return False

        if self._active:
            return True

        if self._stopping:
            log.warning("📸 Arrêt en cours — impossible de redémarrer")
            return False

        try:
            self._capture_count = 0
            self._listener      = pynput_mouse.Listener(on_click=self._on_mouse_click)
            self._listener.daemon = True
            self._listener.start()
            self._active   = True
            self._stopping = False

            log.info(
                f"📸 Capture ON — clic+{self._click_delay}s | "
                f"{self._crop.width}×{self._crop.height} "
                f"@ ({self._crop.x1},{self._crop.y1})"
            )
            return True

        except Exception as exc:
            log.error(f"📸 Démarrage échoué : {exc}")
            return False

    def stop(self) -> None:
        if not self._active or self._stopping:
            return

        self._stopping = True
        self._active   = False

        with self._timer_lock:
            if self._pending_timer:
                self._pending_timer.cancel()
                self._pending_timer = None

        listener       = self._listener
        self._listener = None

        def _shutdown() -> None:
            try:
                if listener:
                    listener.stop()
                    listener.join(timeout=1.0)
            except Exception:
                pass
            finally:
                self._stopping = False

        threading.Thread(target=_shutdown, daemon=True).start()
        log.info(f"📸 Capture OFF ({self._capture_count} captures)")

    def manual_capture(self) -> None:
        if not MSS_AVAILABLE:
            log.warning("📸 mss non installé — capture manuelle impossible")
            return
        threading.Thread(target=self._do_capture, daemon=True).start()

    # ── Gestion des événements souris ─────────────────────────────

    def _on_mouse_click(
        self,
        x: int,
        y: int,
        button: object,
        pressed: bool,
    ) -> None:
        if not pressed or not self._active:
            return

        if button != pynput_mouse.Button.left:
            return

        with self._timer_lock:
            if self._pending_timer:
                self._pending_timer.cancel()

            self._pending_timer = threading.Timer(
                self._click_delay,
                self._do_capture,
            )
            self._pending_timer.daemon = True
            self._pending_timer.start()

    # ── Capture effective ──────────────────────────────────────────

    def _do_capture(self) -> None:
        """
        Réalise la capture d'écran brute et sauvegarde en PNG.

        Aucun traitement couleur — l'image est sauvegardée telle quelle.
        L'inversion des couleurs est appliquée dans ocr_engine.ocr_zone()
        au moment de l'OCR, zone par zone.
        """
        with self._timer_lock:
            self._pending_timer = None

        if not self._active:
            return

        with self._capture_lock:
            try:
                os.makedirs(self.output_dir, exist_ok=True)

                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
                filepath  = os.path.join(
                    self.output_dir, f"capture_{timestamp}.png"
                )

                # Région dérivée du crop (coordonnées absolues écran)
                with mss_lib.mss() as screen_capture:
                    raw_capture = screen_capture.grab(self._crop.to_mss_region())
                    pil_image   = Image.frombytes(
                        "RGB", raw_capture.size, raw_capture.rgb
                    )

                # Sauvegarde brute — pas de remplacement de couleurs
                pil_image.save(filepath)

                self._capture_count += 1
                log.info(
                    f"📸 [{self._capture_count}] {os.path.basename(filepath)}"
                )

                if self.on_capture:
                    self.on_capture(filepath)

            except Exception as exc:
                log.error(f"📸 Capture échouée : {exc}")
