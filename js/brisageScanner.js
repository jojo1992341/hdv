/**
 * @file brisageScanner.js
 * @description Scanner de rentabilité de brisage — Top 50 des items à briser.
 *
 * @depends constants.js     — EFFECT_MAPPING
 * @depends storage.js       — getStoredPrice, priceKeyEquip, priceKeyRune
 * @depends imageCache.js    — getIcon
 * @depends calculator.js    — selectItem
 * @depends dealsScanner.js  — evaluateTree
 */

'use strict';

const SMASH_MAX_RESULTS = 50;

const SmashState = {
    lastResults: null,
    sortKey: 'profit',
    sortDir: 'desc',
};

const SMASH_COLUMNS = [
    { key: 'rank',   label: '#',                 sortable: false },
    { key: 'nom',    label: 'Équipement',         sortable: true  },
    { key: 'gain',   label: 'Gain garanti (runes)',  sortable: true  },
    { key: 'craft',  label: 'Coût craft',         sortable: true  },
    { key: 'hdv',    label: 'Prix HDV achat',     sortable: true  },
    { key: 'profit', label: 'Bénéfice net',       sortable: true  },
    { key: 'roi',    label: 'ROI',                sortable: true  },
];

function setupBrisageScanner() {
    document.getElementById('btn-smash-scan')
        .addEventListener('click', _runSmashScan);

    document.getElementById('btn-smash-show-hidden')
        ?.addEventListener('click', _showHiddenSmashPanel);
}

function _runSmashScan() {
    const btn = document.getElementById('btn-smash-scan');
    btn.disabled    = true;
    btn.textContent = '⏳ Analyse en cours...';

    setTimeout(() => {
        const coeffRaw = parseFloat(document.getElementById('smash-scan-coeff').value) || 75;
        const coeff    = Math.max(1, Math.min(4000, coeffRaw)) / 100;

        SmashState.lastResults = _computeSmashRankings(coeff);
        SmashState.sortKey     = 'profit';
        SmashState.sortDir     = 'desc';

        _renderSmashResults(SmashState.lastResults, coeffRaw);

        btn.disabled    = false;
        btn.textContent = '💥 Scanner les brisages';
    }, 50);
}

function _computeSmashRankings(coeff) {
    const results = [];

    const levelMinRaw = parseInt(document.getElementById('smash-level-min')?.value, 10);
    const levelMaxRaw = parseInt(document.getElementById('smash-level-max')?.value, 10);
    const levelMin    = Number.isFinite(levelMinRaw) ? levelMinRaw : null;
    const levelMax    = Number.isFinite(levelMaxRaw) ? levelMaxRaw : null;

    const filterNoPaPmPo = document.getElementById('smash-filter-no-papmpo')?.checked ?? false;
    const filterNonDrop  = document.getElementById('smash-filter-nondrop')?.checked  ?? false;

    // IDs d'effets interdits quand filterNoPaPmPo est actif (positifs uniquement)
    const FORBIDDEN_EFFECT_IDS = new Set([111, 128, 117, 182]); // PA, PM, Portée, Invocation

    // Construit l'ensemble des équipements dropables depuis dbMonstres
    const droppableEquipIds = new Set();
    if (filterNonDrop) {
        dbMonstres.forEach(monstre => {
            monstre.drops?.forEach(drop => {
                if (drop.id_itm != null && drop.taux_drop > 0) {
                    droppableEquipIds.add(drop.id_itm);
                }
            });
        });
    }

    dbEquipments.forEach(item => {
        if (!item.stats?.length) return;

        // Filtre par niveau
        if (levelMin !== null && (item.niveau ?? 0) < levelMin) return;
        if (levelMax !== null && (item.niveau ?? 0) > levelMax) return;

        // Filtre : non dropable uniquement
        if (filterNonDrop && droppableEquipIds.has(item.id_itm)) return;

        // Filtre : items cachés manuellement
        if (HiddenItems.isHiddenSmash(item.id_itm)) return;

        // Filtre : sans PA / PM / PO / Invo
        if (filterNoPaPmPo) {
            const hasForbidden = item.stats.some(stat =>
                FORBIDDEN_EFFECT_IDS.has(stat.id_effet)
            );
            if (hasForbidden) return;
        }

        const effects = _buildEffectsForItem(item);
        if (!effects.length) return;

        const pdbs    = _calcItemPdbs(effects, item.niveau);
        const totalPdb = Math.max(0, Object.values(pdbs).reduce((s, v) => s + v, 0));
        if (totalPdb <= 0) return;

        const { expectedBase, runeLines, missingPrices } = _calcItemBaseGain(effects, pdbs, coeff);
        if (expectedBase <= 0) return;

        // Seuls les items craftables avec TOUS les prix de ressources renseignés
        // sont éligibles. Les items sans recette ou avec des prix manquants sont exclus.
        if (!item.ingredients?.length) return;
        if (typeof evaluateTree !== 'function') return;

        let craftCost = null;
        const cr = evaluateTree(item.id_itm, 1, new Set());
        if (cr.missingCount > 0) return; // prix incomplets → item ignoré
        if (cr.cost > 0) craftCost = cr.cost;

        const hdvPrice = getStoredPrice(priceKeyEquip(item.id_itm));

        // Coût d'acquisition optimal : le moins cher entre HDV et craft
        // Un coût n'est utilisable que s'il est > 0
        const candidates = [
            hdvPrice > 0   ? hdvPrice   : null,
            craftCost !== null ? craftCost : null,
        ].filter(v => v !== null);

        const bestAcqCost  = candidates.length ? Math.min(...candidates) : null;
        const acqSource    = bestAcqCost === null      ? null
                           : bestAcqCost === hdvPrice  ? 'hdv'
                           :                             'craft';

        const profit = bestAcqCost !== null
            ? Math.round(expectedBase - bestAcqCost)
            : null;
        const roi    = bestAcqCost !== null && bestAcqCost > 0
            ? Math.round((expectedBase - bestAcqCost) / bestAcqCost * 100)
            : null;

        results.push({
            item,
            expectedBase: Math.round(expectedBase),
            craftCost,
            hdvPrice,
            bestAcqCost,
            acqSource,
            profit,
            roi,
            runeLines,
            missingPrices,
        });
    });

    return results
        .sort((a, b) => {
            if (a.profit !== null && b.profit !== null) return b.profit - a.profit;
            if (a.profit !== null && a.profit > 0)      return -1;
            if (b.profit !== null && b.profit > 0)      return 1;
            return b.expectedBase - a.expectedBase;
        })
        .slice(0, SMASH_MAX_RESULTS);
}

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
            jet:              Math.ceil((actualMin + actualMax) / 2),
            weightUnite:      parseFloat(rw.poids_unite),
            weightRuneNormal: parseFloat(rw.poids_rune_normal) || parseFloat(rw.poids_unite),
            index,
            sign:             mapping.sign,
        });
    });
    return effects;
}

function _calcItemPdbs(effects, level) {
    const pdbs = {};
    effects.forEach(eff => {
        let pdb = (3 * eff.jet * level * eff.weightUnite / 200) + 1;
        if (eff.sign === -1) pdb = (pdb / 10) * -1;
        pdbs[eff.index] = pdb;
    });
    return pdbs;
}

function _calcItemBaseGain(effects, pdbs, coeff) {
    let guaranteedBase = 0;
    let missingPrices  = 0;
    const runeLines    = [];
    effects.forEach(eff => {
        if (eff.sign === -1) return;
        const price          = getStoredPrice(priceKeyRune(eff.name));
        const runesFloat     = (pdbs[eff.index] / eff.weightRuneNormal) * coeff;
        const kamasGuaranteed = Math.floor(runesFloat) * price;
        if (price <= 0) {
            missingPrices++;
        } else {
            guaranteedBase += kamasGuaranteed;
        }
        runeLines.push({
            abbr:       eff.abbr,
            runesFloat: Math.round(runesFloat * 100) / 100,
            price,
            kamas:      Math.round(kamasGuaranteed),
        });
    });
    return { expectedBase: guaranteedBase, runeLines, missingPrices };
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
            case 'nom':
                return dir * a.item.nom.localeCompare(b.item.nom, 'fr');
            case 'gain':
                va = a.expectedBase;              vb = b.expectedBase; break;
            case 'craft':
                va = a.craftCost ?? -Infinity;    vb = b.craftCost ?? -Infinity; break;
            case 'hdv':
                va = a.hdvPrice > 0 ? a.hdvPrice : -Infinity;
                vb = b.hdvPrice > 0 ? b.hdvPrice : -Infinity; break;
            case 'profit':
                va = a.profit ?? -Infinity;       vb = b.profit ?? -Infinity; break;
            case 'roi':
                va = a.roi    ?? -Infinity;       vb = b.roi    ?? -Infinity; break;
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
        icon.textContent = isActive
            ? (SmashState.sortDir === 'desc' ? ' ↓' : ' ↑')
            : ' ↕';
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

        const craftCell = r.craftCost !== null
            ? `<span class="${r.acqSource === 'craft' ? 'smash-acq-best' : ''}">${fmt(r.craftCost)} K${r.acqSource === 'craft' ? ' 🎯' : ''}</span>`
            : '<span class="tx-faint">—</span>';

        const hdvCell = r.hdvPrice > 0
            ? `<span class="${r.acqSource === 'hdv' ? 'smash-acq-best' : ''}">${fmt(r.hdvPrice)} K${r.acqSource === 'hdv' ? ' 🎯' : ''}</span>`
            : '<span class="tx-faint">—</span>';

        const profitCell = r.profit !== null
            ? `<span class="${r.profit >= 0 ? 'smash-profit-pos' : 'smash-profit-neg'}">
                   ${r.profit >= 0 ? '+' : ''}${fmt(r.profit)} K
               </span>`
            : '<span class="tx-faint">—</span>';

        const roiCell = r.roi !== null
            ? `<span class="${r.roi >= 0 ? 'smash-profit-pos' : 'smash-profit-neg'}">
                   ${r.roi >= 0 ? '+' : ''}${r.roi} %
               </span>`
            : '<span class="tx-faint">—</span>';

        const missingBadge = r.missingPrices > 0
            ? `<span class="smash-missing">⚠️ ${r.missingPrices} rune(s) sans prix</span>`
            : '';

        const runeDetail = r.runeLines
            .filter(l => l.price > 0)
            .map(l => `${l.abbr}: ~${l.runesFloat} · ${fmt(l.kamas)} K`)
            .join(' | ');

        return `
        <tr class="smash-row" data-item-id="${r.item.id_itm}"
            title="${runeDetail || 'Aucun détail'}">
            <td class="smash-rank">${medal}</td>
            <td>
                <div class="smash-item-cell">
                    <img src="${getIcon(r.item.icone)}" alt="" class="smash-icon">
                    <div class="smash-item-info">
                        <span class="smash-item-name">${r.item.nom}</span>
                        <span class="smash-item-level">Niv. ${r.item.niveau}</span>
                        ${missingBadge}
                    </div>
                </div>
            </td>
            <td class="smash-mono">${fmt(r.expectedBase)} K</td>
            <td class="smash-mono">${craftCell}</td>
            <td class="smash-mono">${hdvCell}</td>
            <td class="smash-mono">${profitCell}</td>
            <td class="smash-mono">${roiCell}</td>
        </tr>`;
    }).join('');
}

function _attachSmashListeners(container) {
    // Tri colonne
    container.querySelectorAll('.smash-th[data-smash-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.smashSort;
            if (SmashState.sortKey === key) {
                SmashState.sortDir = SmashState.sortDir === 'desc' ? 'asc' : 'desc';
            } else {
                SmashState.sortKey = key;
                SmashState.sortDir = 'desc';
            }
            const tbody = container.querySelector('.smash-table tbody');
            if (tbody && SmashState.lastResults) {
                tbody.innerHTML = _buildSmashTbody(SmashState.lastResults);
                _attachRowClickListeners(container);
            }
            _updateSortIcons();
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

            // 1. Simule un clic sur le bouton nav "Calculateur & Brisage"
            const navBtn = document.querySelector('[data-target="tab-calculator"]');
            if (navBtn) navBtn.click();

            // 2. Charge l'item dans le calculateur
            document.getElementById('search-input').value = item.nom;
            selectItem(item);

            // 3. Scroll vers le header du calculateur
            document.getElementById('main-content')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

function _renderSmashResults(results, coeffPct) {
    const container = document.getElementById('smash-scan-results');

    if (!results.length) {
        container.innerHTML = `
            <div class="smash-empty">
                Aucun équipement avec des runes valorisables trouvé.<br>
                Renseignez des prix de runes dans le calculateur.
            </div>`;
        return;
    }

    const withProfit = results.filter(r => r.profit !== null && r.profit > 0).length;
    const withoutHdv = results.filter(r => r.hdvPrice <= 0).length;

    const headers = SMASH_COLUMNS.map(col => {
        if (!col.sortable) return `<th class="smash-th">${col.label}</th>`;
        const active = col.key === SmashState.sortKey;
        const icon   = active ? (SmashState.sortDir === 'desc' ? ' ↓' : ' ↑') : ' ↕';
        return `<th class="smash-th${active ? ' smash-th-active' : ''}"
                    data-smash-sort="${col.key}">
                    ${col.label}<span class="smash-sort-icon">${icon}</span>
                </th>`;
    }).join('');

    container.innerHTML = `
        <div class="smash-results-header">
            <h4>💥 Top ${results.length} brisages — Coefficient ${coeffPct} %</h4>
            <p class="smash-legend">
                Gain estimé au jet médian · Cliquer une ligne pour l'ouvrir dans le calculateur
                ${withProfit > 0 ? `· <strong>${withProfit}</strong> item(s) rentables` : ''}
                ${withoutHdv > 0 ? `· <span class="tx-faint">${withoutHdv} sans prix HDV</span>` : ''}
                · <em>Cliquer un en-tête pour trier</em>
            </p>
        </div>
        <div class="smash-table-wrap">
            <table class="smash-table">
                <thead><tr>${headers}</tr></thead>
                <tbody>${_buildSmashTbody(results)}</tbody>
            </table>
        </div>`;

    _attachSmashListeners(container);
}

/* =============================================================================
   PANNEAU DES ITEMS CACHÉS (SMASH)
============================================================================= */

/**
 * Affiche un panneau inline listant tous les items cachés du scanner.
 * Permet de les réafficher un par un ou tous d'un coup.
 * @private
 */
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
            // Mise à jour du compteur
            const remaining = container.querySelectorAll('.hidden-item-row').length;
            const h4 = container.querySelector('.hidden-panel-header h4');
            if (h4) h4.textContent = `Items cachés du scanner (${remaining})`;
            if (remaining === 0) {
                container.innerHTML = `<div class="smash-empty">Tous les items sont de nouveau visibles.</div>`;
            }
        });
    });
}
