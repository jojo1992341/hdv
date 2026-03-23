"""
main.py — Point d'entrée de l'outil Dofus HDV
==============================================
Lance l'interface graphique principale.

Usage :
    python main.py
    python -m hdv_tool   (si installé comme package)

Responsabilités de ce module :
    1. Initialisation du logging console
    2. Chargement de la configuration (coords.json)
    3. Création de la fenêtre tkinter principale
    4. Lancement de DofusHDVApp
    5. Gestion propre de la fermeture (WM_DELETE_WINDOW)
    6. Démarrage de la boucle événementielle tkinter
"""

from __future__ import annotations

import logging
import sys
import tkinter as tk

from config import get_config_manager
from gui.app import DofusHDVApp


def _setup_console_logging() -> None:
    """
    Configure un handler console minimal pour les messages avant
    que le widget ScrolledText soit disponible.

    Niveau INFO — format court avec horodatage.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s │ %(levelname)s │ %(message)s",
                          datefmt="%H:%M:%S")
    )
    log = logging.getLogger("DofusHDV")
    log.setLevel(logging.INFO)
    log.addHandler(handler)


def main() -> None:
    """
    Point d'entrée principal.

    Initialise le logging, crée la fenêtre tkinter, instancie
    DofusHDVApp et démarre la boucle événementielle.
    Garantit l'appel à app.cleanup() à la fermeture quelle que
    soit la façon dont l'utilisateur quitte l'application.
    """
    _setup_console_logging()

    log = logging.getLogger("DofusHDV")
    log.info("🎮 Dofus HDV Tool — démarrage")

    root = tk.Tk()
    app  = DofusHDVApp(root)

    def on_close() -> None:
        """Nettoyage propre avant destruction de la fenêtre."""
        log.info("🛑 Fermeture demandée — nettoyage…")
        app.cleanup()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)

    try:
        root.mainloop()
    except KeyboardInterrupt:
        log.info("🛑 Interruption clavier — fermeture")
        on_close()


if __name__ == "__main__":
    main()
