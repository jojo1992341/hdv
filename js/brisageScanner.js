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
 *   Quand une rune est ciblée (SmashState.filterRune), elle est forcée
 *   comme rune de focus pour TOUS les calculs (seuil, gain, threshold…).
 *   Sans sélection, le focus optimal est calculé automatiquement.
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
    sortKey:     'threshold',
    sortDir:     'asc',
    filterRune:  '',   // Rune ciblée — vide = focus auto
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

    const runeSelect = document.getElementById('smash-filter-rune');
    runeSelect?.addEventListener('change', e => {
        SmashState.filterRune = e.target.value;
        // Feedback visuel : accent vert quand une rune est forcée
        runeSelect.classList.toggle('has-selection', !!e.target.value);
    });

    _populateRuneFilter();
}

/* =============================================================================
   FILTRE PAR RUNE — PEUPLEMENT DU SELECT
============================================================================= */

function _populateRuneFilter() {
    const select = document.getElementById('smash-filter-rune');
    if (!select || !dbRunesWeights?.length) return;

    const fmt = n => n.toLocaleString('fr-FR', { maximumFractionDigits: 0 });

    const runes = dbRunesWeights.map(rw => {
        const price       = getStoredPrice(priceKeyRune(rw.nom));
        const poids       = parseFloat(rw.poids_rune_normal) || 1;
        const rentabilite = price > 0 ? Math.round(price / poids) : 0;
        return { nom: rw.nom, abbr: dbRuneNames[rw.nom] || rw.nom, price, poids, rentabilite };
    }).sort((a, b) => b.rentabilite - a.rentabilite || a.abbr.localeCompare(b.abbr, 'fr'));

    const current      = select.value;
    const withPrice    = runes.filter(r => r.price > 0);
    const withoutPrice = runes.filter(r => r.price <= 0);

    select.innerHTML = '<option value="">Toutes les runes — focus auto</option>';

    if (withPrice.length) {
        const grp = document.createElement('optgroup');
        grp.label = '💰 Avec prix — triées par K/poids';
        withPrice.forEach(r => {
            const opt       = document.createElement('option');
            opt.value       = r.nom;
            opt.textContent = `${r.abbr}  ·  ${fmt(r.rentabilite)} K/poids  ·  ${fmt(r.price)} K`;
            grp.appendChild(opt);
        });
        select.appendChild(grp);
    }

    if (withoutPrice.length) {
        const grp = document.createElement('optgroup');
        grp.label = '— Sans prix renseigné';
        withoutPrice.sort((a, b) => a.abbr.localeCompare(b.abbr, 'fr')).forEach(r => {
            const opt       = document.createElement('option');
            opt.value       = r.nom;
            opt.textContent = r.abbr;
            grp.appendChild(opt);
        });
        select.appendChild(grp);
    }

    if (current && [...select.options].some(o => o.value === current)) {
        select.value = current;
    }
}

/* =============================================================================
   SCAN PRINCIPAL
============================================================================= */

function _runSmashScan() {
    const btn = document.getElementById('btn-smash-scan');
    btn.disabled    = true;
    btn.textContent = '⏳ Analyse en cours...';

    setTimeout(() => {
        _populateRuneFilter();

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
        if (typeof addToCart === 'function') { addToCart(r.item.id_itm); addedCount++; }
    });

    const btn = document.getElementById('btn-smash-cart-all');
    const originalText = btn.textContent;
    btn.textContent = `✅ ${addedCount} ajoutés`;
    btn.disabled    = true;
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
}

/* =============================================================================
   CALCUL PRINCIPAL
============================================================================= */

function _computeSmashRankings(coeff, coeffPct) {
    const results = [];

    const levelMinRaw = parseInt(document.getElementById('smash-level-min')?.value, 10);
    const levelMaxRaw = parseInt(document.getElementById('smash-level-max')?.value, 10);
    const levelMin    = Number.isFinite(levelMinRaw) ? levelMinRaw : null;
    const levelMax    = Number.isFinite(levelMaxRaw) ? levelMaxRaw : null;

    const filterNoPaPmPo = document.getElementById('smash-filter-no-papmpo')?.checked ?? false;
    const filterNonDrop  = document.getElementById('smash-filter-nondrop')?.checked  ?? false;
    const forcedRune     = SmashState.filterRune;

    const FORBIDDEN_EFFECT_IDS = new Set([111, 128, 117, 182]);

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

        // Filtre : l'item doit posséder la rune ciblée en effet positif
        if (forcedRune) {
            const hasRune = item.stats.some(stat => {
                const m = EFFECT_MAPPING[stat.id_effet];
                return m && m.name === forcedRune && m.sign === 1;
            });
            if (!hasRune) return;
        }

        const effects = _buildEffectsForItem(item);
        if (!effects.length) return;

        const pdbs     = calcPdbs(effects, item.niveau);
        const totalPdb = Math.max(0, Object.values(pdbs).reduce((s, v) => s + v, 0));
        if (totalPdb <= 0) return;

        // ── Gain calculé avec focus forcé ou auto ────────────────────────
        const gainData = _calcItemGain(effects, pdbs, totalPdb, coeff, forcedRune);
        if (gainData.effectiveExpected <= 0) return;

        if (!item.ingredients?.length || typeof evaluateTree !== 'function') return;
        const cr = evaluateTree(item.id_itm, 1, new Set());
        if (cr.missingCount > 0) return;
        const craftCost = cr.cost > 0 ? cr.cost : null;

        const hdvPrice = getStoredPrice(priceKeyEquip(item.id_itm));

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

        // Bénéfice et ROI basés sur le gain effectif (focus forcé ou auto)
        const profit = Math.round(gainData.effectiveExpected - bestAcqCost);
        const roi    = bestAcqCost > 0
            ? Math.round((gainData.effectiveExpected - bestAcqCost) / bestAcqCost * 100)
            : null;

        // Seuil basé sur le gain effectif (focus forcé ou auto)
        let thresholdVal         = null;
        let smashesFromThreshold = null;

        if (bestAcqCost > 0 && gainData.effectiveExpected > 0) {
            const gainAt100 = gainData.effectiveExpected / coeff;
            thresholdVal    = Math.ceil((bestAcqCost / gainAt100) * 100);
            thresholdVal    = Math.max(1, Math.min(4000, thresholdVal));

            if (thresholdVal <= coeffPct && typeof getSmashCountFromCoeff === 'function') {
                smashesFromThreshold = Math.max(0, Math.floor(
                    getSmashCountFromCoeff(thresholdVal) - getSmashCountFromCoeff(coeffPct)
                ));
            }
        }

        if (thresholdVal === null || thresholdVal > coeffPct) return;

        results.push({
            item,
            effectiveExpected:   Math.round(gainData.effectiveExpected),
            effectiveGuaranteed: Math.round(gainData.effectiveGuaranteed),
            baseExpected:        Math.round(gainData.baseExpected),
            craftCost,
            hdvPrice,
            bestAcqCost,
            acqSource,
            profit,
            roi,
            thresholdVal,
            smashesFromThreshold,
            runeLines:     gainData.runeLines,
            missingPrices: gainData.missingPrices,
            bestFocus:     gainData.bestFocus,
            isFocusForced: !!forcedRune,
        });
    });

    return results
        .sort((a, b) => (a.thresholdVal ?? 9999) - (b.thresholdVal ?? 9999))
        .slice(0, SMASH_MAX_RESULTS);
}

/* =============================================================================
   CALCUL DU GAIN — FOCUS FORCÉ OU AUTO
============================================================================= */

/**
 * Calcule le gain de brisage avec focus forcé ou auto.
 *
 * Mode FORCÉ (forcedRuneName !== '') :
 *   Applique la formule focus sur la rune ciblée.
 *   effectiveExpected / effectiveGuaranteed = gain avec ce focus.
 *   Ces valeurs pilotent seuil, bénéfice et ROI.
 *
 * Mode AUTO (forcedRuneName === '') :
 *   Comportement original — calcBestFocusStrategy choisit la meilleure rune.
 *
 * @param {Array}  effects        — Effets de l'item.
 * @param {Object} pdbs           — PDB par index.
 * @param {number} totalPdb       — Somme des PDB positifs.
 * @param {number} coeff          — Coefficient de brisage (0–1).
 * @param {string} forcedRuneName — Nom de la rune imposée, ou ''.
 */
function _calcItemGain(effects, pdbs, totalPdb, coeff, forcedRuneName) {
    // ── Gain de base (sans focus) ─────────────────────────────────────────
    let baseExpected   = 0;
    let baseGuaranteed = 0;
    const runeLines    = [];
    let missingPrices  = 0;

    effects.forEach(eff => {
        if (eff.sign === -1) return;
        const price      = getStoredPrice(priceKeyRune(eff.name));
        const runesFloat = (pdbs[eff.index] / eff.weightRuneNormal) * coeff;
        const kamas      = Math.floor(runesFloat) * price;
        if (price <= 0) missingPrices++;

        baseExpected   += runesFloat * price;
        baseGuaranteed += kamas;

        runeLines.push({
            abbr:        eff.abbr,
            name:        eff.name,
            index:       eff.index,
            runesFloat:  Math.round(runesFloat * 100) / 100,
            price,
            kamas:       Math.round(kamas),
            rentabilite: Math.round((price / (eff.weightRuneNormal || 1)) * 100) / 100,
        });
    });

    // ── Mode : focus forcé ────────────────────────────────────────────────
    if (forcedRuneName) {
        const forcedEff = effects.find(e => e.name === forcedRuneName && e.sign === 1);

        if (forcedEff) {
            const price = getStoredPrice(priceKeyRune(forcedRuneName));

            // Formule identique à calcBestFocusStrategy / calculateur
            const focusRunesFloat = (
                (pdbs[forcedEff.index] + 0.5 * (totalPdb - pdbs[forcedEff.index]))
                / forcedEff.weightRuneNormal
            ) * coeff;

            const forcedFocusResult = {
                abbr:        forcedEff.abbr,
                name:        forcedRuneName,
                runesFloat:  Math.round(focusRunesFloat * 100) / 100,
                expected:    focusRunesFloat * price,
                guaranteed:  Math.floor(focusRunesFloat) * price,
                isForced:    true,
            };

            return {
                baseExpected,
                effectiveExpected:   forcedFocusResult.expected,
                effectiveGuaranteed: forcedFocusResult.guaranteed,
                bestFocus:           forcedFocusResult,
                runeLines,
                missingPrices,
            };
        }

        // Rune forcée absente sur cet item → gain de base (ne devrait pas arriver
        // car le filtre l'exclut en amont, mais sécurité)
        return {
            baseExpected,
            effectiveExpected:   baseExpected,
            effectiveGuaranteed: baseGuaranteed,
            bestFocus:           null,
            runeLines,
            missingPrices,
        };
    }

    // ── Mode : focus auto (comportement original) ─────────────────────────
    const { bestFocus } = calcBestFocusStrategy(effects, pdbs, totalPdb, coeff);

    return {
        baseExpected,
        effectiveExpected:   bestFocus ? bestFocus.expected   : baseExpected,
        effectiveGuaranteed: bestFocus ? bestFocus.guaranteed : baseGuaranteed,
        bestFocus,
        runeLines,
        missingPrices,
    };
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
            case 'gain':      va = a.effectiveGuaranteed;        vb = b.effectiveGuaranteed; break;
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
   RENTABILITÉ DES RUNES — PANNEAU
============================================================================= */

function _buildRuneRentabilitePanel() {
    const fmt = n => n.toLocaleString('fr-FR', { maximumFractionDigits: 0 });

    const runes = (dbRunesWeights || [])
        .map(rw => {
            const price       = getStoredPrice(priceKeyRune(rw.nom));
            const poids       = parseFloat(rw.poids_rune_normal) || 1;
            const rentabilite = price > 0 ? Math.round(price / poids) : 0;
            return { abbr: dbRuneNames[rw.nom] || rw.nom, nom: rw.nom, price, poids, rentabilite };
        })
        .filter(r => r.price > 0)
        .sort((a, b) => b.rentabilite - a.rentabilite);

    if (!runes.length) {
        return `<p class="smash-rent-no-prices">
            💡 Renseignez les prix de vos runes dans le calculateur pour voir leur rentabilité ici.
        </p>`;
    }

    const activeRune  = SmashState.filterRune;
    const maxRent     = runes[0].rentabilite || 1;
    const filterBadge = activeRune
        ? `<span class="smash-rent-filter-badge">🎯 Focus forcé : ${dbRuneNames[activeRune] || activeRune}</span>`
        : '';

    const rows = runes.map((r, i) => {
        const isActive = r.nom === activeRune;
        const barPct   = Math.round((r.rentabilite / maxRent) * 100);
        const medal    = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
        return `
        <div class="smash-rent-row${isActive ? ' smash-rent-active' : ''}"
             title="${r.abbr} · poids_rune = ${r.poids} · ${fmt(r.price)} K · ${fmt(r.rentabilite)} K/poids">
            <span class="smash-rent-rank">${medal}</span>
            <span class="smash-rent-abbr">${r.abbr}${isActive ? ' 🎯' : ''}</span>
            <div class="smash-rent-bar-wrap">
                <div class="smash-rent-bar-track">
                    <div class="smash-rent-bar" style="width:${barPct}%"></div>
                </div>
            </div>
            <span class="smash-rent-price">${fmt(r.price)} K</span>
            <span class="smash-rent-ratio">${fmt(r.rentabilite)}<span class="smash-rent-unit"> K/p</span></span>
        </div>`;
    }).join('');

    return `
        <details class="smash-rent-panel"${activeRune ? ' open' : ''}>
            <summary class="smash-rent-summary">
                <span class="smash-rent-summary-title">💎 Rentabilité des runes — ${runes.length} avec prix</span>
                ${filterBadge}
                <span class="smash-rent-summary-hint">K/poids = kamas par unité de poids investie</span>
            </summary>
            <div class="smash-rent-grid">${rows}</div>
        </details>`;
}

/* =============================================================================
   RENDU — TABLEAU
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

        // Gain : garanti + attendu (focus forcé ou auto)
        const gainCell = `
            <span class="smash-gain-effective">${fmt(r.effectiveGuaranteed)} K</span>
            <span class="smash-gain-sub" title="Gain attendu (probabiliste)">≈${fmt(r.effectiveExpected)} K</span>`;

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

        // Colonne "Rune à focus" avec badge FORCÉ si applicable
        let focusCell;
        if (r.bestFocus) {
            const forcedTag = r.isFocusForced
                ? `<span class="smash-focus-forced-tag">FORCÉ</span>`
                : '';
            focusCell = `
                <span class="smash-focus-rune${r.isFocusForced ? ' smash-focus-forced' : ''}">
                    🎯 ${r.bestFocus.abbr} ${forcedTag}
                    <span class="smash-focus-detail">(${fmt(r.effectiveGuaranteed)} K garantis)</span>
                </span>`;
        } else {
            focusCell = '<span class="smash-no-focus">Aucun focus</span>';
        }

        // Tooltip enrichi avec K/poids par rune
        const runeDetail = r.runeLines
            .filter(l => l.price > 0)
            .sort((a, b) => b.rentabilite - a.rentabilite)
            .map(l => {
                const tag = r.isFocusForced && l.name === SmashState.filterRune ? ' ← FOCUS FORCÉ' : '';
                return `${l.abbr}: ~${l.runesFloat} rune(s) · ${fmt(l.kamas)} K · ${fmt(l.rentabilite)} K/poids${tag}`;
            })
            .join('\n');

        // Badge meilleure rune par K/poids
        const topRentRune = r.runeLines
            .filter(l => l.price > 0)
            .sort((a, b) => b.rentabilite - a.rentabilite)[0];
        const rentBadge = topRentRune
            ? `<span class="smash-best-rent-badge">💎 ${topRentRune.abbr} · ${fmt(topRentRune.rentabilite)} K/p</span>`
            : '';

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
                        ${rentBadge}
                    </div>
                </div>
            </td>
            <td class="smash-mono">${threshCell}</td>
            <td class="smash-mono">${smashCell}</td>
            <td class="smash-mono smash-gain-cell">${gainCell}</td>
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

    container.querySelectorAll('.smash-btn-cart').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.itemId, 10);
            if (typeof addToCart === 'function') addToCart(id);
            btn.textContent = '✅';
            setTimeout(() => { btn.textContent = '🛒'; }, 1200);
        });
    });

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
            // Transmet la rune cible sélectionnée dans le scanner au calculateur
            if (typeof setForcedFocusRune === 'function') {
                setForcedFocusRune(SmashState.filterRune || null);
            }
            const navBtn = document.querySelector('[data-target="tab-calculator"]');
            if (navBtn) navBtn.click();
            document.getElementById('search-input').value = item.nom;
            selectItem(item);
            document.getElementById('main-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

function _renderSmashResults(results, coeffPct) {
    const container  = document.getElementById('smash-scan-results');
    const forcedRune = SmashState.filterRune;
    const focusLabel = forcedRune
        ? ` — Focus forcé : <strong>${dbRuneNames[forcedRune] || forcedRune}</strong>`
        : '';

    if (!results.length) {
        container.innerHTML = `
            <div class="smash-empty">
                Aucun équipement rentable trouvé au coefficient actuel (${coeffPct} %)${forcedRune ? ` avec la rune ${dbRuneNames[forcedRune] || forcedRune}` : ''}.<br>
                Vérifiez vos prix de runes ou augmentez le coefficient dans le calculateur.
            </div>
            ${_buildRuneRentabilitePanel()}`;
        return;
    }

    const withProfit = results.filter(r => r.profit !== null && r.profit > 0).length;
    const threshMin  = Math.min(...results.map(r => r.thresholdVal ?? 9999));
    const threshMax  = Math.max(...results.map(r => r.thresholdVal ?? 0));

    // Bannière focus forcé
    const forceBanner = forcedRune ? `
        <div class="smash-force-banner">
            🎯 Focus forcé sur <strong>${dbRuneNames[forcedRune] || forcedRune}</strong> —
            seuil, gain, bénéfice et ROI sont calculés avec ce focus.
            <span class="smash-force-banner-sub">
                Seuls les items ayant cet effet sont affichés.
            </span>
        </div>` : '';

    const headers = SMASH_COLUMNS.map(col => {
        if (!col.sortable) return `<th class="smash-th">${col.label}</th>`;
        const isActive = col.key === SmashState.sortKey;
        const icon     = isActive ? (SmashState.sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
        const label    = (col.key === 'gain' && forcedRune)
            ? `Gain focus (${dbRuneNames[forcedRune] || forcedRune})`
            : col.label;
        return `<th class="smash-th${isActive ? ' smash-th-active' : ''}" data-smash-sort="${col.key}">
                    ${label}<span class="smash-sort-icon">${icon}</span>
                </th>`;
    }).join('');

    container.innerHTML = `
        <div class="smash-results-header">
            <h4>💥 ${results.length} brisage(s) rentables — Coefficient ${coeffPct} %${focusLabel}</h4>
            <p class="smash-legend">
                Classé par seuil de rentabilité croissant (plus bas = plus rentable) ·
                Seuils de ${threshMin} % à ${threshMax} %
                ${withProfit > 0 ? `· <strong>${withProfit}</strong> avec bénéfice net` : ''}
                · <em>Cliquer une ligne pour ouvrir dans le calculateur</em>
            </p>
            ${forceBanner}
            ${_buildRuneRentabilitePanel()}
        </div>
        <div class="smash-table-wrap">
            <table class="smash-table">
                <thead><tr>${headers}</tr></thead>
                <tbody>${_buildSmashTbody(results)}</tbody>
            </table>
        </div>`;

    _attachSmashListeners(container);

    const cartAllBtn = document.getElementById('btn-smash-cart-all');
    if (cartAllBtn) { cartAllBtn.disabled = false; cartAllBtn.textContent = '🛒 Tout au panier'; }
}

/* =============================================================================
   PANNEAU DES ITEMS CACHÉS
============================================================================= */

function _showHiddenSmashPanel() {
    const container = document.getElementById('smash-scan-results');
    const hiddenIds = HiddenItems.allHiddenSmash();

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

/* =============================================================================
   UTILITAIRES
============================================================================= */

function _escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _escapeAttr(str) {
    return str
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}
