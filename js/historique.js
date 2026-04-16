/**
 * @file historique.js
 * @description Onglet 7 — Historique des scans de rentabilité.
 *
 * Responsabilités :
 *   - Lecture et affichage de l'historique des snapshots de scan
 *   - Visualisation des top 5 deals par scan sous forme de barres relatives
 *   - Effacement de l'historique sur confirmation
 *   - Rafraîchissement automatique à l'activation de l'onglet
 *
 * @depends storage.js    — formatDate
 * @depends navigation.js — AppNav (onTabChange)
 */

/** Clé localStorage de l'historique des scans. @type {string} */
const HISTORY_STORAGE_KEY = 'scan_history';

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Initialise les listeners de l'onglet Historique.
 *
 * Utilise AppNav.onTabChange() pour déclencher le rendu à l'activation
 * de l'onglet — remplace le re-query `.nav-tab-btn` anti-pattern et
 * le setTimeout(renderHistorique, 50) de la version originale.
 *
 * Doit être appelée une fois au chargement de la page.
 */
function setupHistorique() {
    document.getElementById('btn-clear-history').addEventListener('click', _clearHistory);
    AppNav.onTabChange('tab-historique', renderHistorique);
}

/**
 * Efface l'intégralité de l'historique des scans après confirmation,
 * puis rafraîchit l'affichage.
 * @private
 */
function _clearHistory() {
    if (!confirm("Effacer tout l'historique des scans ?")) return;
    localStorage.removeItem(HISTORY_STORAGE_KEY);
    renderHistorique();
}

/* =============================================================================
   RENDU
============================================================================= */

/**
 * Lit l'historique et construit l'affichage de l'ensemble des snapshots.
 * Les snapshots sont affichés du plus récent au plus ancien (ordre inversé).
 */
function renderHistorique() {
    const container = document.getElementById('historique-container');
    const history   = _loadHistory();

    if (history.length === 0) {
        container.innerHTML = `
            <div class="histo-empty">
                Aucun historique. Lancez d'abord une analyse de marché.
            </div>`;
        return;
    }

    container.innerHTML = history.map(_renderSnapshotCard).join('');
}

/**
 * Charge et inverse l'historique depuis le localStorage.
 * Retourne un tableau vide si l'historique est absent ou invalide.
 *
 * @returns {Array<{ts: number, category: string, top5: Array}>}
 */
function _loadHistory() {
    try {
        return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]').reverse();
    } catch {
        console.warn('[historique] Historique corrompu — réinitialisation.');
        localStorage.removeItem(HISTORY_STORAGE_KEY);
        return [];
    }
}

/**
 * Génère le HTML d'une carte de snapshot d'historique.
 *
 * @param {{ ts: number, category: string, top5: Array }} snap
 * @returns {string}
 * @private
 */
function _renderSnapshotCard(snap) {
    const date    = formatDate(snap.ts);
    const top5    = snap.top5 ?? [];
    const barsHtml = top5.length > 0
        ? _renderProfitBars(top5)
        : '<span class="histo-empty-deals">Aucun deal enregistré</span>';

    const dealLabel = `${top5.length} deal${top5.length > 1 ? 's' : ''}`;

    return `
        <div class="histo-card">
            <div class="histo-card-header">
                <div class="histo-card-date">${date}</div>
                <div class="histo-card-cat">${snap.category}</div>
                <div class="histo-card-count">${dealLabel}</div>
            </div>
            <div class="histo-card-body">${barsHtml}</div>
        </div>`;
}

/**
 * Génère le HTML des barres de profit relatives pour un snapshot.
 * La largeur de chaque barre est proportionnelle au meilleur profitPct du groupe.
 *
 * Protection : si top5 est vide, `Math.max()` sans arguments retourne `-Infinity` —
 * le minimum forcé à 1 garantit une division valide.
 *
 * @param {Array<{nom: string, profitPct: number}>} top5
 * @returns {string}
 * @private
 */
function _renderProfitBars(top5) {
    const maxPct = Math.max(1, ...top5.map(d => d.profitPct));

    return top5.map(d => {
        const widthPct = Math.round((d.profitPct / maxPct) * 100);
        return `
            <div class="histo-bar-row">
                <span class="histo-bar-name">${d.nom}</span>
                <div class="histo-bar-track">
                    <div class="histo-bar-fill" style="width:${widthPct}%"></div>
                </div>
                <span class="histo-bar-value success-text">+${d.profitPct}%</span>
            </div>`;
    }).join('');
}
