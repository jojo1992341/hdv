/**
 * @file brisageScanner.js
 * @description Scanner de rentabilité de brisage.
 *
 * Logique de classement :
 *   Le scanner utilise le coefficient actuel (#item-coeff) du calculateur.
 *   Pour chaque équipement, il calcule le SEUIL DE RENTABILITÉ (en %) :
 *   le coefficient minimum à partir duquel briser devient rentable.
 *   Plus ce seuil est BAS, plus l'item est haut dans le classement.
 *
 * @depends constants.js          — EFFECT_MAPPING
 * @depends storage.js            — getStoredPrice, priceKeyEquip, priceKeyRune
 * @depends imageCache.js         — getIcon
 * @depends calculator.js         — selectItem, getSmashCountFromCoeff
 * @depends dealsScanner.js       — evaluateTree
 * @depends hiddenItems.js        — HiddenItems
 * @depends focusStrategy.js      — calcPdbs, calcBestFocusStrategy
 */

'use strict';

const SMASH_MAX_RESULTS = 50;

const SmashState = {
    lastResults: null,
    sortKey: 'threshold',
    sortDir: 'asc',
};

const SMASH_COLUMNS = [
    { key: 'rank',      label: '#',                   sortable: false },
    { key: 'nom',       label: 'Équipement',          sortable: true  },
    { key: 'threshold', label: 'Seuil rentab. (%)',   sortable: true  },
    { key: 'smashes',   label: 'Brisages max',        sortable: true  },
    { key: 'gain',      label: 'Gain garanti',        sortable: true  },
    { key: 'focus',     label: 'Rune à focus',        sortable: false },
    { key: 'craft',     label: 'Coût craft',          sortable: true  },
    { key: 'hdv',       label: 'Prix HDV',            sortable: true  },
    { key: 'profit',    label: 'Bénéfice net',        sortable: true  },
    { key: 'roi',       label: 'ROI',                 sortable: true  },
    { key: 'actions',   label: '',                    sortable: false },
];

/* =============================================================================
   INITIALISATION
============================================================================= */

function setupBrisageScanner() {
    document.getElementById('btn-smash-scan')
        ?.addEventListener('click', _runSmashScan);

    document.getElementById('btn-smash-show-hidden')
        ?.addEventListener('click', _showHiddenSmashPanel);

    document.getElementById('btn-smash-cart-all')
        ?.addEventListener('click', _cartAllSmashResults);
}

/* =============================================================================
   SCAN PRINCIPAL
============================================================================= */

function _runSmashScan() {
    const btn = document.getElementById('btn-smash-scan');
    btn.disabled    = true;
    btn.textContent = '⏳ Analyse en cours...';

    setTimeout(() => {
        // Coeff = valeur actuelle du calculateur
        const coeffPct = parseFloat(document.getElementById('item-coeff')?.value) || 75;
        const coeff    = Math.max(1, Math.min(4000, coeffPct)) / 100;

        SmashState.lastResults = _computeSmashRankings(coeff, coeffPct);
        SmashState.sortKey     = 'threshold';
        SmashState.sortDir     = 'asc';

        _renderSmashResults(SmashState.lastResults, coeffPct);

        btn.disabled    = false;
        btn.textContent = '💥 Scanner les brisages';
    }, 50);
}

/* =============================================================================
   ACTION: TOUT AJOUTER AU PANIER
============================================================================= */

function _cartAllSmashResults() {
    if (!SmashState.lastResults || SmashState.lastResults.length === 0) {
        alert('Aucun résultat à ajouter au panier. Lancez d\'abord un scan.');
        return;
    }

    let addedCount = 0;
    SmashState.lastResults.forEach(r => {
        if (typeof addToCart === 'function') {
            addToCart(r.item.id_itm);
            addedCount++;
        }
    });

    // Feedback visuel sur le bouton
    const btn = document.getElementById('btn-smash-cart-all');
    const originalText = btn.textContent;
    btn.textContent = `✅ ${addedCount} ajoutés`;
    btn.disabled = true;
    setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
    }, 1500);
}

/* =============================================================================
   CALCUL
============================================================================= */

function _computeSmashRankings(coeff, coeffPct) {
    const results = [];

    const levelMinRaw = parseInt(document.getElementById('smash-level-min')?.value, 10);
    const levelMaxRaw = parseInt(document.getElementById('smash-level-max')?.value, 10);
    const levelMin    = Number.isFinite(levelMinRaw) ? levelMinRaw : null;
    const levelMax    = Number.isFinite(levelMaxRaw) ? levelMaxRaw : null;

    const filterNoPaPmPo = document.getElementById('smash-filter-no-papmpo')?.checked ?? false;
    const filterNonDrop  = document.getElementById('smash-filter-nondrop')?.checked  ?? false;

    const FORBIDDEN_EFFECT_IDS = new Set([111, 128, 117, 182]);

    // Ensemble des équipements dropables
    const droppableEquipIds = new Set();
    if (filterNonDrop) {
        dbMonstres.forEach(monstre => {
            monstre.drops?.forEach(drop => {
                if (drop.id_itm != null && drop.taux_drop > 0) droppableEquipIds.add(drop.id_itm);
            });
        });
    }

    dbEquipments.forEach(item => {
        if (!item.stats?.length) return;

        if (levelMin !== null && (item.niveau ?? 0) < levelMin) return;
        if (levelMax !== null && (item.niveau ?? 0) > levelMax) return;
        if (filterNonDrop && droppableEquipIds.has(item.id_itm)) return;
        if (HiddenItems.isHiddenSmash(item.id_itm)) return;

        if (filterNoPaPmPo) {
            if (item.stats.some(stat => FORBIDDEN_EFFECT_IDS.has(stat.id_effet))) return;
        }

        const effects = _buildEffectsForItem(item);
        if (!effects.length) return;

        const pdbs    = calcPdbs(effects, item.niveau);
        const totalPdb = Math.max(0, Object.values(pdbs).reduce((s, v) => s + v, 0));
        if (totalPdb <= 0) return;

        const { expectedBase, runeLines, missingPrices, bestFocus } = _calcItemBaseGain(effects, pdbs, totalPdb, coeff);
        if (expectedBase <= 0) return;

        if (!item.ingredients?.length || typeof evaluateTree !== 'function') return;
        const cr = evaluateTree(item.id_itm, 1, new Set());
        if (cr.missingCount > 0) return;
        const craftCost = cr.cost > 0 ? cr.cost : null;

        const hdvPrice = getStoredPrice(priceKeyEquip(item.id_itm));

        // ── Filtre source prix ────────────────────────────────────────────
        const priceSrc = document.querySelector('input[name="smash-price-src"]:checked')?.value ?? 'both';
        let bestAcqCost = null;
        let acqSource   = null;

        if (priceSrc === 'hdv') {
            if (hdvPrice <= 0) return;
            bestAcqCost = hdvPrice; acqSource = 'hdv';
        } else if (priceSrc === 'craft') {
            if (craftCost === null) return;
            bestAcqCost = craftCost; acqSource = 'craft';
        } else {
            const candidates = [
                hdvPrice > 0       ? hdvPrice  : null,
                craftCost !== null ? craftCost : null,
            ].filter(v => v !== null);
            if (!candidates.length) return;
            bestAcqCost = Math.min(...candidates);
            acqSource   = bestAcqCost === hdvPrice ? 'hdv' : 'craft';
        }

        const profit = Math.round(expectedBase - bestAcqCost);
        const roi    = bestAcqCost > 0
            ? Math.round((expectedBase - bestAcqCost) / bestAcqCost * 100)
            : null;

        // ── Calcul du SEUIL DE RENTABILITÉ ────────────────────────────────
        // thresholdVal = coefficient minimum (en %) pour que le brisage soit rentable
        // Formule : coût_achat / (gain_runes / coeff_actuel) * 100
        // Utilise le gain de la meilleure stratégie (base ou focus), comme la carte dashboard
        let thresholdVal = null;
        let smashesFromThreshold = null;

        // Le gain estimé est celui de la meilleure stratégie (comme dans le calculateur)
        const bestStrategyExpected = bestFocus ? bestFocus.expected : expectedBase;

        if (bestAcqCost > 0 && bestStrategyExpected > 0) {
            // gain_au_coeff_100 = expectedBest / coeff (ramené à coeff=1.0)
            const gainAt100 = bestStrategyExpected / coeff;
            thresholdVal    = Math.ceil((bestAcqCost / gainAt100) * 100);
            thresholdVal    = Math.max(1, Math.min(4000, thresholdVal));

            if (thresholdVal <= coeffPct && typeof getSmashCountFromCoeff === 'function') {
                smashesFromThreshold = Math.max(0, Math.floor(
                    getSmashCountFromCoeff(thresholdVal) - getSmashCountFromCoeff(coeffPct)
                ));
            }
        }

        // On n'inclut que les items dont le seuil est calculable et ≤ coeff actuel
        // (i.e. déjà rentables au coeff actuel)
        if (thresholdVal === null || thresholdVal > coeffPct) return;

        results.push({
            item,
            expectedBase: Math.round(expectedBase),
            craftCost,
            hdvPrice,
            bestAcqCost,
            acqSource,
            profit,
            roi,
            thresholdVal,
            smashesFromThreshold,
            runeLines,
            missingPrices,
            bestFocus,
        });
    });

    // Tri par seuil ascendant (seuil le plus bas = le plus rentable)
    return results
        .sort((a, b) => (a.thresholdVal ?? 9999) - (b.thresholdVal ?? 9999))
        .slice(0, SMASH_MAX_RESULTS);
}

/* =============================================================================
   HELPERS DE CALCUL
============================================================================= */

function _buildEffectsForItem(item) {
    const effects = [];
    item.stats.forEach((stat, index) => {
        const mapping = EFFECT_MAPPING[stat.id_effet];
        if (!mapping) return;
        const absMin    = Math.abs(stat.min || 0);
        const absMax    = Math.abs(stat.max || absMin);
        const actualMin = Math.min(absMin, absMax);
        const actualMax = Math.max(absMin, absMax);
        if (actualMax === 0) return;
        const rw = dbRunesWeights.find(r => r.nom === mapping.name);
        if (!rw) return;
        effects.push({
            name:             mapping.name,
            abbr:             dbRuneNames[mapping.name] || mapping.name,
            jet:              Math.floor((actualMin + actualMax) / 2),
            weightUnite:      parseFloat(rw.poids_unite),
            weightRuneNormal: parseFloat(rw.poids_rune_normal) || parseFloat(rw.poids_unite),
            index,
            sign:             mapping.sign,
        });
    });
    return effects;
}

function _calcItemBaseGain(effects, pdbs, totalPdb, coeff) {
    const { baseKamas, bestFocus } = calcBestFocusStrategy(effects, pdbs, totalPdb, coeff);

    // Reconstruire runeLines pour l'affichage
    const runeLines = [];
    let missingPrices = 0;

    effects.forEach(eff => {
        if (eff.sign === -1) return;
        const price = getStoredPrice(priceKeyRune(eff.name));
        const runesFloat = (pdbs[eff.index] / eff.weightRuneNormal) * coeff;
        const kamasGuaranteed = Math.floor(runesFloat) * price;
        if (price <= 0) { missingPrices++; }
        runeLines.push({
            abbr:       eff.abbr,
            runesFloat: Math.round(runesFloat * 100) / 100,
            price,
            kamas:      Math.round(kamasGuaranteed),
        });
    });

    return { 
        expectedBase: baseKamas.expected,
        guaranteedBase: baseKamas.guaranteed,
        runeLines, 
        missingPrices, 
        bestFocus 
    };
}

/* =============================================================================
   TRI
============================================================================= */

function _sortResults(results) {
    const { sortKey, sortDir } = SmashState;
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...results].sort((a, b) => {
        let va, vb;
        switch (sortKey) {
            case 'nom':       return dir * a.item.nom.localeCompare(b.item.nom, 'fr');
            case 'threshold': va = a.thresholdVal ?? 9999;       vb = b.thresholdVal ?? 9999; break;
            case 'smashes':   va = a.smashesFromThreshold ?? -1;  vb = b.smashesFromThreshold ?? -1; break;
            case 'gain':      va = a.expectedBase;               vb = b.expectedBase; break;
            case 'craft':     va = a.craftCost ?? -Infinity;     vb = b.craftCost ?? -Infinity; break;
            case 'hdv':       va = a.hdvPrice > 0 ? a.hdvPrice : -Infinity;
                              vb = b.hdvPrice > 0 ? b.hdvPrice : -Infinity; break;
            case 'profit':    va = a.profit ?? -Infinity;        vb = b.profit ?? -Infinity; break;
            case 'roi':       va = a.roi    ?? -Infinity;        vb = b.roi    ?? -Infinity; break;
            default: return 0;
        }
        return dir * (va - vb);
    });
}

function _updateSortIcons() {
    document.querySelectorAll('.smash-th[data-smash-sort]').forEach(th => {
        const key  = th.dataset.smashSort;
        const icon = th.querySelector('.smash-sort-icon');
        if (!icon) return;
        const isActive = key === SmashState.sortKey;
        icon.textContent = isActive ? (SmashState.sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
        th.classList.toggle('smash-th-active', isActive);
    });
}

/* =============================================================================
   RENDU
============================================================================= */

function _buildSmashTbody(results) {
    const fmt    = n => n.toLocaleString('fr-FR');
    const sorted = _sortResults(results);

    return sorted.map((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;

        const threshCell = r.thresholdVal !== null
            ? `<span class="smash-threshold">${r.thresholdVal} %</span>`
            : '<span class="tx-faint">—</span>';

        const smashCell = r.smashesFromThreshold !== null
            ? `${r.smashesFromThreshold} bris.`
            : '<span class="tx-faint">—</span>';

        const craftCell = r.craftCost !== null
            ? `<span class="${r.acqSource === 'craft' ? 'smash-acq-best' : ''}">${fmt(r.craftCost)} K${r.acqSource === 'craft' ? ' 🎯' : ''}</span>`
            : '<span class="tx-faint">—</span>';

        const hdvCell = r.hdvPrice > 0
            ? `<span class="${r.acqSource === 'hdv' ? 'smash-acq-best' : ''}">${fmt(r.hdvPrice)} K${r.acqSource === 'hdv' ? ' 🎯' : ''}</span>`
            : '<span class="tx-faint">—</span>';

        const profitCell = r.profit !== null
            ? `<span class="${r.profit >= 0 ? 'smash-profit-pos' : 'smash-profit-neg'}">${r.profit >= 0 ? '+' : ''}${fmt(r.profit)} K</span>`
            : '<span class="tx-faint">—</span>';

        const roiCell = r.roi !== null
            ? `<span class="${r.roi >= 0 ? 'smash-profit-pos' : 'smash-profit-neg'}">${r.roi >= 0 ? '+' : ''}${r.roi} %</span>`
            : '<span class="tx-faint">—</span>';

        const missingBadge = r.missingPrices > 0
            ? `<span class="smash-missing">⚠️ ${r.missingPrices} rune(s) sans prix</span>` : '';

        // Utiliser la meilleure stratégie de focus (même logique que le calculateur)
        const focusCell = r.bestFocus
            ? `<span class="smash-focus-rune">🎯 ${r.bestFocus.abbr} <span class="smash-focus-detail">(${r.bestFocus.guaranteed.toLocaleString('fr-FR')} K garantis)</span></span>`
            : '<span class="smash-no-focus">Aucun focus</span>';

        const runeDetail = r.runeLines
            .filter(l => l.price > 0)
            .map(l => `${l.abbr}: ~${l.runesFloat} · ${fmt(l.kamas)} K`)
            .join(' | ');

        return `
        <tr class="smash-row" data-item-id="${r.item.id_itm}"
            title="${_escapeAttr(runeDetail || 'Aucun détail')}">
            <td class="smash-rank">${medal}</td>
            <td>
                <div class="smash-item-cell">
                    <img src="${getIcon(r.item.icone)}" alt="" class="smash-icon">
                    <div class="smash-item-info">
                        <span class="smash-item-name">${_escapeHtml(r.item.nom)}</span>
                        <span class="smash-item-level">Niv. ${r.item.niveau}</span>
                        ${missingBadge}
                    </div>
                </div>
            </td>
            <td class="smash-mono">${threshCell}</td>
            <td class="smash-mono">${smashCell}</td>
            <td class="smash-mono">${fmt(r.expectedBase)} K</td>
            <td class="smash-mono">${focusCell}</td>
            <td class="smash-mono">${craftCell}</td>
            <td class="smash-mono">${hdvCell}</td>
            <td class="smash-mono">${profitCell}</td>
            <td class="smash-mono">${roiCell}</td>
            <td class="smash-actions-cell">
                <button class="smash-btn-cart" data-item-id="${r.item.id_itm}" title="Ajouter au panier">🛒</button>
                <button class="smash-btn-hide" data-item-id="${r.item.id_itm}" title="Cacher du scanner">🙈</button>
            </td>
        </tr>`;
    }).join('');
}

function _attachSmashListeners(container) {
    container.querySelectorAll('.smash-th[data-smash-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.smashSort;
            if (SmashState.sortKey === key) {
                SmashState.sortDir = SmashState.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                SmashState.sortKey = key;
                // Seuil/brisages : asc par défaut (plus bas = meilleur)
                // Autres : desc par défaut (plus haut = meilleur)
                SmashState.sortDir = (key === 'threshold' || key === 'smashes') ? 'asc' : 'desc';
            }
            const tbody = container.querySelector('.smash-table tbody');
            if (tbody && SmashState.lastResults) {
                tbody.innerHTML = _buildSmashTbody(SmashState.lastResults);
                _attachRowClickListeners(container);
            }
            _updateSortIcons();
        });
    });
    // Boutons Panier
    container.querySelectorAll('.smash-btn-cart').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.itemId, 10);
            if (typeof addToCart === 'function') addToCart(id);
            btn.textContent = '✅';
            setTimeout(() => { btn.textContent = '🛒'; }, 1200);
        });
    });

    // Boutons Cacher
    container.querySelectorAll('.smash-btn-hide').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id  = parseInt(btn.dataset.itemId, 10);
            HiddenItems.hideSmash(id);
            const row = btn.closest('tr');
            if (row) { row.style.transition = 'opacity 0.25s'; row.style.opacity = '0'; setTimeout(() => row.remove(), 260); }
        });
    });

    _attachRowClickListeners(container);
}

function _attachRowClickListeners(container) {
    container.querySelectorAll('.smash-row').forEach(row => {
        row.addEventListener('click', () => {
            const itemId = parseInt(row.dataset.itemId, 10);
            const item   = dbEquipments.find(e => e.id_itm === itemId);
            if (!item) return;
            const navBtn = document.querySelector('[data-target="tab-calculator"]');
            if (navBtn) navBtn.click();
            document.getElementById('search-input').value = item.nom;
            selectItem(item);
            document.getElementById('main-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

function _renderSmashResults(results, coeffPct) {
    const container = document.getElementById('smash-scan-results');

    if (!results.length) {
        container.innerHTML = `
            <div class="smash-empty">
                Aucun équipement rentable trouvé au coefficient actuel (${coeffPct} %).<br>
                Vérifiez vos prix de runes ou augmentez le coefficient dans le calculateur.
            </div>`;
        return;
    }

    const withProfit = results.filter(r => r.profit !== null && r.profit > 0).length;
    const threshMin  = Math.min(...results.map(r => r.thresholdVal ?? 9999));
    const threshMax  = Math.max(...results.map(r => r.thresholdVal ?? 0));

    const headers = SMASH_COLUMNS.map(col => {
        if (!col.sortable) return `<th class="smash-th">${col.label}</th>`;
        const isActive = col.key === SmashState.sortKey;
        const icon     = isActive
            ? (SmashState.sortDir === 'asc' ? ' ↑' : ' ↓')
            : ' ↕';
        return `<th class="smash-th${isActive ? ' smash-th-active' : ''}"
                    data-smash-sort="${col.key}">
                    ${col.label}<span class="smash-sort-icon">${icon}</span>
                </th>`;
    }).join('');

    container.innerHTML = `
        <div class="smash-results-header">
            <h4>💥 ${results.length} brisage(s) rentables — Coefficient ${coeffPct} %</h4>
            <p class="smash-legend">
                Classé par seuil de rentabilité croissant (plus bas = plus rentable) ·
                Seuils de ${threshMin} % à ${threshMax} %
                ${withProfit > 0 ? `· <strong>${withProfit}</strong> avec bénéfice net` : ''}
                · <em>Cliquer une ligne pour ouvrir dans le calculateur</em>
            </p>
        </div>
        <div class="smash-table-wrap">
            <table class="smash-table">
                <thead><tr>${headers}</tr></thead>
                <tbody>${_buildSmashTbody(results)}</tbody>
            </table>
        </div>`;

    _attachSmashListeners(container);

    // Réinitialiser le bouton "Tout au panier"
    const cartAllBtn = document.getElementById('btn-smash-cart-all');
    if (cartAllBtn) {
        cartAllBtn.disabled = false;
        cartAllBtn.textContent = '🛒 Tout au panier';
    }
}

/* =============================================================================
   PANNEAU DES ITEMS CACHÉS
============================================================================= */

function _showHiddenSmashPanel() {
    const container  = document.getElementById('smash-scan-results');
    const hiddenIds  = HiddenItems.allHiddenSmash();

    if (hiddenIds.size === 0) {
        container.innerHTML = `<div class="smash-empty">Aucun item caché pour l'instant.</div>`;
        return;
    }

    const rows = [...hiddenIds].map(id => {
        const item = dbEquipments.find(e => e.id_itm === id);
        const nom  = item?.nom ?? `ID ${id}`;
        const niv  = item?.niveau ?? '?';
        const icon = item ? `<img src="${getIcon(item.icone)}" class="smash-icon" alt="">` : '';
        return `
        <div class="hidden-item-row" data-item-id="${id}">
            ${icon}
            <span class="hidden-item-name">${nom} <span class="smash-item-level">Niv. ${niv}</span></span>
            <button class="btn-unhide-smash" data-item-id="${id}">👁 Réafficher</button>
        </div>`;
    }).join('');

    container.innerHTML = `
        <div class="hidden-panel">
            <div class="hidden-panel-header">
                <h4>Items cachés du scanner (${hiddenIds.size})</h4>
                <button id="btn-unhide-all-smash" class="btn-unhide-all">Tout réafficher</button>
            </div>
            <div class="hidden-panel-list">${rows}</div>
        </div>`;

    container.querySelector('#btn-unhide-all-smash').addEventListener('click', () => {
        HiddenItems.clearAllSmash();
        container.innerHTML = `<div class="smash-empty">Tous les items sont de nouveau visibles.</div>`;
    });

    container.querySelectorAll('.btn-unhide-smash').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.itemId, 10);
            HiddenItems.showSmash(id);
            btn.closest('.hidden-item-row').remove();
            const remaining = container.querySelectorAll('.hidden-item-row').length;
            const h4 = container.querySelector('.hidden-panel-header h4');
            if (h4) h4.textContent = `Items cachés du scanner (${remaining})`;
            if (remaining === 0) {
                container.innerHTML = `<div class="smash-empty">Tous les items sont de nouveau visibles.</div>`;
            }
        });
    });
}

/**
 * Échappe les caractères HTML dangereux dans une chaîne.
 * @param {string} str
 * @returns {string}
 * @private
 */
function _escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Échappe les caractères dangereux pour un attribut HTML.
 * @param {string} str
 * @returns {string}
 * @private
 */
function _escapeAttr(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}
