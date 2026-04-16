/**
 * @file dashboard.js
 * @description Onglet 3 — Tableau de bord des prix renseignés.
 *
 * Responsabilités :
 *   - Affichage paginé des prix de ressources, équipements et runes
 *   - Filtrage par statut (tous / renseignés / manquants)
 *   - Barre de progression de complétude des prix
 *   - Pagination avec sélecteur de taille de page
 *
 * @depends storage.js    — getStoredPrice, getStoredTimestamp, formatDate,
 *                          ageInfo, priceKeyRes, priceKeyEquip, priceKeyRune
 * @depends imageCache.js — getIcon
 * @depends navigation.js — AppNav (onTabChange)
 */

/* =============================================================================
   CONFIGURATION
============================================================================= */

/** Options disponibles pour le nombre de lignes par page. @type {number[]} */
const PAGE_SIZES = [25, 50, 100, 250];

/** Taille de page initiale. @type {number} */
const DEFAULT_PAGE_SIZE = 50;

/* =============================================================================
   ÉTAT DE PAGINATION (PRIVÉ)
   Encapsulé — aucun autre module ne doit y accéder directement.
============================================================================= */

/**
 * @typedef {{ page: number, pageSize: number }} SectionState
 */

/** @type {{ res: SectionState, equip: SectionState, runes: SectionState }} */
const _dashState = {
    res:   { page: 1, pageSize: DEFAULT_PAGE_SIZE },
    equip: { page: 1, pageSize: DEFAULT_PAGE_SIZE },
    runes: { page: 1, pageSize: DEFAULT_PAGE_SIZE },
};

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Initialise les listeners de l'onglet Tableau de bord.
 * Utilise AppNav.onTabChange() pour déclencher le rendu à l'activation
 * de l'onglet — élimine le re-query anti-pattern de la version originale.
 *
 * Doit être appelée une fois au chargement de la page.
 */
function setupDashboard() {
    document.getElementById('btn-refresh-dashboard').addEventListener('click', renderDashboard);
    document.getElementById('dash-filter-type').addEventListener('change', renderDashboard);

    // Rendu automatique à l'activation de l'onglet
    AppNav.onTabChange('tab-dashboard', renderDashboard);
}

/* =============================================================================
   POINT D'ENTRÉE PRINCIPAL
============================================================================= */

/**
 * Réinitialise la pagination à la page 1 et reconstruit l'ensemble du dashboard.
 * Appelée lors d'un refresh manuel ou d'un changement de filtre.
 */
function renderDashboard() {
    _dashState.res.page   = 1;
    _dashState.equip.page = 1;
    _dashState.runes.page = 1;
    _renderDashboardAll();
}

/* =============================================================================
   RENDU COMPLET
============================================================================= */

/**
 * Reconstruit l'intégralité du tableau de bord :
 * datasets filtrés, barre de stats, compteurs, tableaux paginés.
 * @private
 */
function _renderDashboardAll() {
    const filter     = document.getElementById('dash-filter-type').value;
    const craftables = dbEquipments.filter(e => e.ingredients?.length > 0);

    // Construction des datasets filtrés
    const { rows: resRows,   setCount: resSet   } = _buildDataset(
        dbResources, r => priceKeyRes(r.id_res),
        (r, price, ts) => ({ res: r, price, ts }),
        filter
    );
    const { rows: equipRows, setCount: equipSet } = _buildDataset(
        craftables, e => priceKeyEquip(e.id_itm),
        (e, price, ts) => ({ eq: e, price, ts }),
        filter
    );
    const { rows: runesRows, setCount: runesSet } = _buildDataset(
        dbRunesWeights, rw => priceKeyRune(rw.nom),
        (rw, price, ts) => ({ rw, price, ts }),
        filter
    );

    _renderStatsBar({ resSet, equipSet, runesSet, craftablesCount: craftables.length });
    _renderCounters({ resSet, equipSet, runesSet, craftablesCount: craftables.length });

    _renderDashPage('res',   resRows,   _renderResRow);
    _renderDashPage('equip', equipRows, _renderEquipRow);
    _renderDashPage('runes', runesRows, _renderRuneRow);
}

/**
 * Construit un dataset filtré à partir d'une collection, d'une fonction de clé
 * et d'une fonction de mapping vers la forme de ligne souhaitée.
 *
 * Factorise le triple pattern dupliqué de la version originale.
 *
 * @template T, R
 * @param {T[]}              collection   - Source de données (ressources, équipements, runes).
 * @param {(item: T) => string} keyFn     - Fonction retournant la clé localStorage.
 * @param {(item: T, price: number, ts: number) => R} rowFn - Constructeur de ligne.
 * @param {"all"|"set"|"missing"} filter  - Filtre de visibilité.
 * @returns {{ rows: R[], setCount: number }}
 */
function _buildDataset(collection, keyFn, rowFn, filter) {
    const rows = [];
    let setCount = 0;

    collection.forEach(item => {
        const key   = keyFn(item);
        const price = getStoredPrice(key);
        const ts    = getStoredTimestamp(key);

        if (filter === 'set'     && price === 0) return;
        if (filter === 'missing' && price > 0)   return;
        if (price > 0) setCount++;

        rows.push(rowFn(item, price, ts));
    });

    return { rows, setCount };
}

/* =============================================================================
   BARRE DE STATS ET COMPTEURS
============================================================================= */

/**
 * @private
 * @param {{ resSet, equipSet, runesSet, craftablesCount }} counts
 */
function _renderStatsBar({ resSet, equipSet, runesSet, craftablesCount }) {
    const pct = (n, total) => total > 0 ? Math.round((n / total) * 100) : 0;

    document.getElementById('dash-stats-bar').innerHTML = `
        ${_statCard('Ressources renseignées', resSet,   dbResources.length,    pct(resSet,   dbResources.length))}
        ${_statCard('Équipements HDV',         equipSet, craftablesCount,       pct(equipSet, craftablesCount))}
        ${_statCard('Runes',                   runesSet, dbRunesWeights.length, pct(runesSet, dbRunesWeights.length))}
    `;
}

/**
 * Génère le HTML d'une carte de statistique avec barre de progression.
 * @private
 */
function _statCard(label, count, total, pctVal) {
    return `
        <div class="dash-stat-card">
            <span class="dash-stat-label">${label}</span>
            <span class="dash-stat-value kamas-text">${count} / ${total}</span>
            <div class="dash-progress">
                <div class="dash-progress-fill" style="width:${pctVal}%"></div>
            </div>
        </div>`;
}

/**
 * Met à jour les compteurs texte de l'en-tête de chaque section.
 * @private
 */
function _renderCounters({ resSet, equipSet, runesSet, craftablesCount }) {
    document.getElementById('dash-count-res').textContent   = `${resSet} / ${dbResources.length}`;
    document.getElementById('dash-count-equip').textContent = `${equipSet} / ${craftablesCount}`;
    document.getElementById('dash-count-runes').textContent = `${runesSet} / ${dbRunesWeights.length}`;
}

/* =============================================================================
   RENDERERS DE LIGNES (un par section)
============================================================================= */

/**
 * Génère le HTML d'une ligne du tableau Ressources.
 * @param {{ res: object, price: number, ts: number }} row
 * @returns {string}
 */
function _renderResRow({ res, price, ts }) {
    const age = ageInfo(ts);
    return `<tr>
        <td>${_iconCell(res.icone)}</td>
        <td>${res.nom}</td>
        <td class="${price > 0 ? 'kamas-text' : 'danger-text'}">${price > 0 ? `${price} K` : '—'}</td>
        <td class="dash-ts">${formatDate(ts)}</td>
        <td><span class="age-badge ${age.cls}">${age.text}</span></td>
    </tr>`;
}

/**
 * Génère le HTML d'une ligne du tableau Équipements.
 * @param {{ eq: object, price: number, ts: number }} row
 * @returns {string}
 */
function _renderEquipRow({ eq, price, ts }) {
    const age = ageInfo(ts);
    return `<tr>
        <td>${_iconCell(eq.icone)}</td>
        <td>${eq.nom}</td>
        <td class="dash-level">Nv ${eq.niveau}</td>
        <td class="${price > 0 ? 'kamas-text' : 'danger-text'}">${price > 0 ? `${price} K` : '—'}</td>
        <td class="dash-ts">${formatDate(ts)}</td>
        <td><span class="age-badge ${age.cls}">${age.text}</span></td>
    </tr>`;
}

/**
 * Génère le HTML d'une ligne du tableau Runes.
 * @param {{ rw: object, price: number, ts: number }} row
 * @returns {string}
 */
function _renderRuneRow({ rw, price, ts }) {
    const age      = ageInfo(ts);
    const runeName = dbRuneNames[rw.nom] || rw.nom;
    const runeRes  = dbResources.find(r => r.nom === `Rune ${runeName}`);
    const iconHtml = runeRes ? _iconCell(runeRes.icone) : '';

    return `<tr>
        <td>${iconHtml}</td>
        <td>${runeName}</td>
        <td class="${price > 0 ? 'kamas-text' : 'danger-text'}">${price > 0 ? `${price} K` : '—'}</td>
        <td class="dash-ts">${formatDate(ts)}</td>
        <td><span class="age-badge ${age.cls}">${age.text}</span></td>
    </tr>`;
}

/**
 * Génère une cellule icône standardisée (24×24px).
 * Évite la duplication du style inline dans les 3 renderers.
 *
 * @param {string} iconUrl
 * @returns {string}
 * @private
 */
function _iconCell(iconUrl) {
    return `<img src="${getIcon(iconUrl)}" class="dash-icon" alt="">`;
}

/* =============================================================================
   RENDU D'UNE SECTION PAGINÉE
============================================================================= */

/**
 * Rend une section paginée du dashboard (tableau + pagination).
 *
 * @param {"res"|"equip"|"runes"} section   - Identifiant de la section.
 * @param {Array}                  rows      - Données de la section (filtrées).
 * @param {(row: any) => string}   renderer  - Fonction de rendu HTML d'une ligne.
 * @private
 */
function _renderDashPage(section, rows, renderer) {
    const state = _dashState[section];
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));

    // Garde la page courante dans les bornes valides
    state.page = Math.min(state.page, pages);

    _renderTableRows(section, rows, state, renderer);
    _renderPagination(section, state, total, pages);
}

/**
 * Rend les lignes du tableau pour la page courante.
 * @private
 */
function _renderTableRows(section, rows, state, renderer) {
    const start    = (state.page - 1) * state.pageSize;
    const pageRows = rows.slice(start, start + state.pageSize);
    const tbody    = document.querySelector(`#dash-table-${section} tbody`);
    tbody.innerHTML = pageRows.map(renderer).join('');
}

/**
 * Rend les contrôles de pagination d'une section.
 * Ne génère rien si le contenu tient sur une seule page.
 * @private
 */
function _renderPagination(section, state, total, pages) {
    const pagEl = document.getElementById(`dash-pag-${section}`);

    if (pages <= 1) {
        pagEl.innerHTML = '';
        return;
    }

    const sizeOptions = PAGE_SIZES
        .map(n => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n}</option>`)
        .join('');

    pagEl.innerHTML = `
        <button class="dash-pag-btn" data-sec="${section}" data-action="prev"
                ${state.page <= 1 ? 'disabled' : ''}>Précédent</button>
        <span class="dash-pag-info">
            Page <strong>${state.page}</strong> / ${pages}
            <span class="dash-pag-total">(${total} entrées)</span>
        </span>
        <div class="dash-pag-size-wrap">
            Afficher
            <select class="dash-pag-size" data-sec="${section}">${sizeOptions}</select>
            lignes
        </div>
        <button class="dash-pag-btn" data-sec="${section}" data-action="next"
                ${state.page >= pages ? 'disabled' : ''}>Suivant</button>`;

    _attachPaginationListeners(pagEl, section);
}

/**
 * Attache les listeners de navigation (boutons Précédent/Suivant)
 * et de changement de taille de page sur une barre de pagination.
 * @private
 */
function _attachPaginationListeners(pagEl, section) {
    pagEl.querySelectorAll('.dash-pag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sec = btn.dataset.sec;
            if (btn.dataset.action === 'prev') _dashState[sec].page--;
            else                               _dashState[sec].page++;

            _renderDashboardAll();

            // Scroll doux vers la section mise à jour
            document.getElementById(`dash-table-${sec}`)
                ?.closest('.dash-section')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    pagEl.querySelectorAll('.dash-pag-size').forEach(sel => {
        sel.addEventListener('change', () => {
            const sec              = sel.dataset.sec;
            _dashState[sec].pageSize = parseInt(sel.value, 10);
            _dashState[sec].page     = 1;
            _renderDashboardAll();
        });
    });
}
