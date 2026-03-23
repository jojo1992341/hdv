/**
 * @file navigation.js
 * @description Système générique de navigation par onglets.
 *
 * Fournit une implémentation unique réutilisable par les deux pages :
 *   - index.html  → instance AppNav  (mode "hidden")
 *   - admin.html  → instance AdminNav (mode "active")
 *
 * Remplace :
 *   - setupNavigation() dans app.js
 *   - setupTabs()       dans admin.js
 *   - Le re-query de .nav-tab-btn dans setupHistorique()
 *
 * Chargement requis AVANT app.js et admin.js :
 *   <script src="navigation.js"></script>
 *
 * @depends Aucune dépendance sur les autres modules du projet.
 */

/* =============================================================================
   FACTORY : createTabNavigation
   =============================================================================
   Crée une instance de navigation par onglets indépendante.

   Deux stratégies de visibilité supportées :
     "hidden"  — l'onglet actif n'a PAS la classe hidden (app.js)
                 les onglets inactifs ont la classe hidden
     "active"  — l'onglet actif a la classe active (admin.js)
                 les onglets inactifs n'ont PAS la classe active

   @param {object} config
   @param {string} config.btnSelector    - Sélecteur CSS des boutons d'onglet.
   @param {string} config.panelSelector  - Sélecteur CSS des panneaux de contenu.
   @param {"hidden"|"active"} config.strategy - Stratégie de visibilité CSS.
   @returns {{
     init:         () => void,
     getActiveTab: () => string|null,
     onTabChange:  (targetId: string, callback: () => void) => void,
   }}
============================================================================= */

function createTabNavigation({ btnSelector, panelSelector, strategy }) {

    /** @type {string|null} ID du panneau actuellement actif */
    let _activeTabId = null;

    /**
     * Map des callbacks enregistrés par ID d'onglet cible.
     * @type {Map<string, Array<() => void>>}
     */
    const _callbacks = new Map();

    /* ── Helpers de stratégie ─────────────────────────────────────────────── */

    function _activatePanel(panel) {
        if (strategy === 'hidden') {
            panel.classList.remove('hidden');
        } else {
            panel.classList.add('active');
        }
    }

    function _deactivatePanel(panel) {
        if (strategy === 'hidden') {
            panel.classList.add('hidden');
        } else {
            panel.classList.remove('active');
        }
    }

    /* ── Logique de changement d'onglet ───────────────────────────────────── */

    /**
     * Active l'onglet correspondant au bouton cliqué.
     * Utilise closest() pour gérer les clics sur les éléments enfants du bouton.
     *
     * @param {Event} event - Événement click.
     */
    function _handleTabClick(event) {
        const btn = event.target.closest(btnSelector);
        if (!btn) return;

        const targetId = btn.getAttribute('data-target');
        if (!targetId) {
            console.warn('[navigation] Bouton sans attribut data-target :', btn);
            return;
        }

        const targetPanel = document.getElementById(targetId);
        if (!targetPanel) {
            console.warn(`[navigation] Panneau introuvable : #${targetId}`);
            return;
        }

        // Désactiver tous les boutons et panneaux
        document.querySelectorAll(btnSelector).forEach(b => b.classList.remove('active'));
        document.querySelectorAll(panelSelector).forEach(p => _deactivatePanel(p));

        // Activer le bouton et le panneau cibles
        btn.classList.add('active');
        _activatePanel(targetPanel);
        _activeTabId = targetId;

        // Déclencher les callbacks enregistrés pour cet onglet
        _fireCallbacks(targetId);
    }

    /**
     * Exécute tous les callbacks enregistrés pour un ID d'onglet donné.
     * @param {string} targetId
     */
    function _fireCallbacks(targetId) {
        const cbs = _callbacks.get(targetId);
        if (!cbs) return;
        cbs.forEach(cb => {
            try { cb(); }
            catch (err) { console.error(`[navigation] Erreur dans callback pour #${targetId} :`, err); }
        });
    }

    /* ── API publique ─────────────────────────────────────────────────────── */

    return {

        /**
         * Initialise la navigation : attache les écouteurs d'événements.
         * Doit être appelée une seule fois au chargement de la page.
         */
        init() {
            // Délégation : un seul listener sur document, plus robuste
            document.addEventListener('click', _handleTabClick);
        },

        /**
         * Retourne l'ID du panneau actuellement actif.
         * @returns {string|null}
         */
        getActiveTab() {
            return _activeTabId;
        },

        /**
         * Enregistre un callback à déclencher lorsqu'un onglet devient actif.
         *
         * Remplace le pattern anti-architectural de setupHistorique() qui
         * re-queryait les boutons de navigation pour accrocher sa propre logique.
         *
         * Exemple d'utilisation dans historique.js :
         *   AppNav.onTabChange('tab-historique', renderHistorique);
         *
         * @param {string}   targetId - ID du panneau cible (valeur de data-target).
         * @param {() => void} callback - Fonction à exécuter lors de l'activation.
         */
        onTabChange(targetId, callback) {
            if (!_callbacks.has(targetId)) {
                _callbacks.set(targetId, []);
            }
            _callbacks.get(targetId).push(callback);
        },

    };
}

/* =============================================================================
   INSTANCES PRÉCONFIGURÉES
   =============================================================================
   Prêtes à l'emploi selon la page. Ne charger que le fichier correspondant,
   ou laisser les deux — les sélecteurs inexistants n'auront aucun effet.
============================================================================= */

/**
 * Navigation principale de l'application (index.html).
 * Stratégie : masquer/afficher via la classe "hidden".
 *
 * Usage dans app.js :
 *   AppNav.init();
 *   AppNav.onTabChange('tab-historique', renderHistorique);
 */
const AppNav = createTabNavigation({
    btnSelector:   '.nav-tab-btn',
    panelSelector: '.app-tab',
    strategy:      'hidden',
});

/**
 * Navigation du backoffice admin (admin.html).
 * Stratégie : visibilité via la classe "active".
 *
 * Usage dans admin.js :
 *   AdminNav.init();
 */
const AdminNav = createTabNavigation({
    btnSelector:   '.tab-btn',
    panelSelector: '.tab-content',
    strategy:      'active',
});
