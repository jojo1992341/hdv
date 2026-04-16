/**
 * @file trading.js
 * @description Onglet Trading — Analyse de rentabilité des ressources HDV.
 *
 * Responsabilités :
 *   - Analyse individuelle d'une ressource (recherche + saisie manuelle)
 *   - Analyse globale de TOUTES les ressources à partir du localStorage
 *   - Scoring sur 100 pts :
 *       · Marge par lots            (0–25 pts)
 *       · Prix moyen vs unitaire    (0–25 pts)
 *       · Rareté / taux de drop     (0–25 pts)
 *       · Demande craft             (0–25 pts)
 *
 * @depends storage.js    — getAllPriceLots, getStoredPriceLot
 * @depends imageCache.js — getIcon
 */

'use strict';

/* =============================================================================
   CONFIGURATION
============================================================================= */

/** Nombre maximum de résultats dans le dropdown de recherche. @type {number} */
const TRADING_MAX_RESULTS = 15;

/** Nombre maximum de résultats dans l'analyse globale. @type {number} */
const TRADING_MAX_BULK = 200;

/* =============================================================================
   ÉTAT DU MODULE
============================================================================= */

const TradingState = {
    /** @type {object|null} Ressource actuellement sélectionnée. */
    selectedResource: null,

    /** @type {Array|null} Derniers résultats bulk calculés (pour re-tri sans recalcul). */
    lastBulkResults: null,

    /** @type {'score'|'margin'} Colonne de tri active du tableau bulk. */
    bulkSortKey: 'score',

    /** @type {'desc'|'asc'} Sens du tri. */
    bulkSortDir: 'desc',

    /** @type {boolean} Si true, n'affiche que les ressources avec boost 🔺. */
    bulkFilterBoost: false,
};

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Initialise l'onglet Trading.
 * Doit être appelée une fois depuis app.js après AppNav.init().
 */
function setupTrading() {
    _setupTradingSearch();

    document.getElementById('btn-trading-analyze')
        .addEventListener('click', _runAnalysis);

    document.getElementById('btn-trading-analyze-all')
        .addEventListener('click', _runBulkAnalysis);
}

/* =============================================================================
   RECHERCHE & SÉLECTION
============================================================================= */

/**
 * Attache les listeners du champ de recherche de ressource.
 * Filtre dbResources en temps réel et peuple le dropdown.
 * @private
 */
function _setupTradingSearch() {
    const input   = document.getElementById('trading-search');
    const results = document.getElementById('trading-search-results');

    input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        results.innerHTML = '';

        if (query.length < 2) {
            results.classList.add('hidden');
            return;
        }

        const matches = dbResources
            .filter(r => r.nom.toLowerCase().includes(query))
            .slice(0, TRADING_MAX_RESULTS);

        if (!matches.length) {
            results.classList.add('hidden');
            return;
        }

        results.classList.remove('hidden');
        matches.forEach(res => {
            const div     = document.createElement('div');
            div.className = 'dropdown-item';
            div.innerHTML = `<img src="${getIcon(res.icone)}" alt=""> <span>${res.nom}</span>`;
            div.addEventListener('click', () => {
                input.value = res.nom;
                results.classList.add('hidden');
                _selectResource(res);
            });
            results.appendChild(div);
        });
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#trading-search-results') && e.target !== input) {
            results.classList.add('hidden');
        }
    });
}

/**
 * Sélectionne une ressource, pré-remplit les prix depuis le localStorage,
 * révèle la zone de saisie et réinitialise les résultats précédents.
 *
 * @param {object} res - Ressource issue de dbResources.
 * @private
 */
function _selectResource(res) {
    TradingState.selectedResource = res;

    document.getElementById('trading-main').classList.remove('hidden');
    document.getElementById('trading-empty').classList.add('hidden');
    document.getElementById('trading-bulk-results').classList.add('hidden');

    // En-tête — nom cliquable pour copie
    document.getElementById('trading-res-icon').src = getIcon(res.icone);

    const nameEl       = document.getElementById('trading-res-name');
    nameEl.textContent = res.nom;
    nameEl.classList.add('copyable-name');
    nameEl.title       = 'Cliquer pour copier le nom';
    nameEl.onclick     = function () { copyToClipboard(res.nom, nameEl); };

    // Demande craft
    const demand = _computeCraftDemand(res.id_res);
    document.getElementById('trading-res-usage').textContent =
        `📦 Utilisée dans ${demand.recipeCount} recette(s) · ${demand.totalQty} unité(s) au total`;

    // Taux de drop
    _renderDropInfo(document.getElementById('trading-res-drop'), res.taux_drop);

    // Pré-remplissage des prix depuis localStorage
    _prefillPricesFromStorage(res.id_res);

    _resetResults();
}

/**
 * Pré-remplit les champs de prix à partir des 4 paliers stockés en localStorage.
 * Si le prix moyen n'est pas stocké, laisse le champ vide.
 *
 * @param {number} resId
 * @private
 */
function _prefillPricesFromStorage(resId) {
    const lots = getAllPriceLots(resId);

    const map = {
        'trading-price-1':    lots.x1,
        'trading-price-10':   lots.x10,
        'trading-price-100':  lots.x100,
        'trading-price-1000': lots.x1000,
    };

    Object.entries(map).forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el) el.value = (val != null && val > 0) ? val : '';
    });

    // Prix moyen : stocké dans localStorage sous clé `avg_{id}`
    const avgRaw = localStorage.getItem(`avg_${resId}`);
    const avgEl  = document.getElementById('trading-avg-price');
    if (avgEl) avgEl.value = avgRaw ? avgRaw : '';
}

/**
 * Affiche les informations de taux de drop dans un élément DOM.
 * @param {HTMLElement} el
 * @param {number|string|null} drop
 * @private
 */
function _renderDropInfo(el, drop) {
    if (drop === 'CRAFT')   { el.textContent = '🔨 Obtention : craft uniquement'; return; }
    if (drop === 'ÉCHANGE') { el.textContent = '🔒 Obtention : échange de jetons'; return; }
    if (drop === 'MÉTIER')  { el.textContent = '⚒️ Obtention : récolte par métier'; return; }
    if (drop === 'SACHET')  { el.textContent = '🎁 Obtention : sachet (10 % de base)'; return; }
    if (drop === 'QUÊTE')   { el.textContent = '📜 Obtention : récompense de quête'; return; }
    if (drop != null)       { el.textContent = `💧 Taux de drop de base : ${parseFloat(drop).toFixed(2)} %`; return; }
    el.textContent = '💧 Taux de drop : non renseigné';
}

/* =============================================================================
   MÉTRIQUES AUTOMATIQUES
============================================================================= */

/**
 * Calcule la demande craft d'une ressource.
 * @param {number} resId
 * @returns {{ recipeCount: number, totalQty: number, maxQtyInSingleRecipe: number }}
 */
function _computeCraftDemand(resId) {
    let recipeCount          = 0;
    let totalQty             = 0;
    let maxQtyInSingleRecipe = 0;

    dbEquipments.forEach(equip => {
        const ingredient = equip.ingredients?.find(ing => ing.id_res === resId);
        if (ingredient) {
            recipeCount++;
            totalQty             += ingredient.quantite;
            maxQtyInSingleRecipe  = Math.max(maxQtyInSingleRecipe, ingredient.quantite);
        }
    });

    return { recipeCount, totalQty, maxQtyInSingleRecipe };
}

/* =============================================================================
   ALGORITHME DE SCORING
   Chaque indicateur retourne { score: number, detail: string }
   score est un entier dans [0, max].
============================================================================= */

/**
 * Trouve la meilleure paire (lot_achat, lot_vente) en comparant les 4 lots
 * entre eux — sans supposer que la vente se fait toujours à l'unité.
 *
 * Stratégie : acheter au lot avec le prix unitaire le plus BAS,
 * revendre au lot avec le prix unitaire le plus HAUT.
 *
 * Exemples couverts :
 *   - Classique : acheter ×1000 (pas cher/u) → revendre ×1 (cher/u)
 *   - Inversé   : acheter ×1 (pas cher/u) → revendre ×100 (cher/u)
 *   - Mixte     : acheter ×10 → revendre ×1000
 *
 * @param {number} p1    Prix ×1    (0 = absent)
 * @param {number} p10   Prix ×10   (0 = absent)
 * @param {number} p100  Prix ×100  (0 = absent)
 * @param {number} p1000 Prix ×1000 (0 = absent)
 * @returns {{
 *   buyLot:     { label: string, size: number, total: number, unitPrice: number },
 *   sellLot:    { label: string, size: number, total: number, unitPrice: number },
 *   costToFill: number,
 *   revenue:    number,
 *   profit:     number,
 *   marginPct:  number,
 *   multiplier: number
 * }|null}
 */
function _findBestTrade(p1, p10, p100, p1000) {
    const lots = [
        { label: '×1',    size: 1,    total: p1    },
        { label: '×10',   size: 10,   total: p10   },
        { label: '×100',  size: 100,  total: p100  },
        { label: '×1000', size: 1000, total: p1000 },
    ]
    .filter(l => l.total > 0)
    .map(l => ({ ...l, unitPrice: l.total / l.size }));

    if (lots.length < 2) return null;

    // Lot d'achat : prix unitaire minimum
    const buyLot  = lots.reduce((a, b) => a.unitPrice <= b.unitPrice ? a : b);
    // Lot de vente : prix unitaire maximum
    const sellLot = lots.reduce((a, b) => a.unitPrice >= b.unitPrice ? a : b);

    // Pas de spread positif
    if (buyLot.label === sellLot.label || sellLot.unitPrice <= buyLot.unitPrice) return null;

    // Coût pour remplir un lot de vente (on achète sellLot.size unités au prix buyLot)
    const costToFill = buyLot.unitPrice * sellLot.size;
    const revenue    = sellLot.total;
    const profit     = revenue - costToFill;
    const marginPct  = (profit / revenue) * 100;
    const multiplier = sellLot.unitPrice / buyLot.unitPrice;

    return { buyLot, sellLot, costToFill, revenue, profit, marginPct, multiplier };
}

/**
 * Score de marge sur les lots (0–25 pts).
 * Utilise _findBestTrade pour couvrir tous les cas (achat ×1 → vente ×100, etc.)
 *
 * @param {number} p1    @param {number} p10
 * @param {number} p100  @param {number} p1000
 * @returns {{ score: number, detail: string }}
 */
function _scoreMargin(p1, p10, p100, p1000) {
    const trade = _findBestTrade(p1, p10, p100, p1000);

    if (!trade) {
        return { score: 0, detail: 'Données insuffisantes ou pas de spread positif entre les lots.' };
    }

    const score = Math.min(25, Math.round(Math.log1p(trade.marginPct) * 5.5));

    return {
        score,
        detail: `Acheter ${trade.buyLot.label} à ${trade.buyLot.unitPrice.toFixed(1)} K/u → `
              + `revendre ${trade.sellLot.label} à ${trade.sellLot.unitPrice.toFixed(1)} K/u = `
              + `${trade.marginPct.toFixed(1)} % de marge brute (×${trade.multiplier.toFixed(2)}).`,
    };
}

/**
 * Score comparant le prix moyen HDV au prix unitaire (0–25 pts).
 * Un prix moyen supérieur au prix actuel signifie que le marché
 * a tendance à payer plus — opportunité d'achat low cost.
 *
 * @param {number} p1  Prix à l'unité actuel.
 * @param {number} avg Prix moyen historique.
 * @returns {{ score: number, detail: string }}
 */
function _scoreAvgPrice(p1, avg) {
    if (!avg || avg <= 0) {
        return { score: 8, detail: 'Prix moyen non renseigné — score neutre appliqué.' };
    }
    if (!p1 || p1 <= 0) {
        return { score: 8, detail: 'Prix unitaire manquant — comparaison impossible.' };
    }

    // ratio = (moyen - actuel) / moyen × 100
    // Si actuel < moyen : opportunité d'achat (score élevé)
    // Si actuel > moyen : prix au-dessus de la moyenne (score faible)
    const ratioPct = (avg - p1) / avg * 100;

    let score, detail;

    if (ratioPct >= 30) {
        score  = 25;
        detail = `Prix actuel ${p1} K très inférieur à la moyenne ${avg} K (−${ratioPct.toFixed(1)} %) — excellente opportunité.`;
    } else if (ratioPct >= 15) {
        score  = 20;
        detail = `Prix actuel sous la moyenne de ${ratioPct.toFixed(1)} % — bonne opportunité d'achat.`;
    } else if (ratioPct >= 5) {
        score  = 14;
        detail = `Prix légèrement sous la moyenne (−${ratioPct.toFixed(1)} %).`;
    } else if (ratioPct >= -5) {
        score  = 10;
        detail = `Prix actuel proche de la moyenne ${avg} K — marché stable.`;
    } else if (ratioPct >= -20) {
        score  = 5;
        detail = `Prix actuel au-dessus de la moyenne de ${Math.abs(ratioPct).toFixed(1)} % — marché sur-évalué.`;
    } else {
        score  = 1;
        detail = `Prix actuel très au-dessus de la moyenne (+${Math.abs(ratioPct).toFixed(1)} %) — attention au retour à la normale.`;
    }

    return { score, detail };
}

/**
 * Score de rareté / disponibilité de la ressource (0–25 pts).
 * Prend en compte les cas spéciaux (CRAFT, ÉCHANGE, MÉTIER, SACHET, QUÊTE).
 *
 * @param {number|string|null} tauxDrop  Valeur issue de recettes_dofus.json.
 * @returns {{ score: number, detail: string, effectiveDrop: number|string|null }}
 */
function _scoreRarity(tauxDrop) {
    if (tauxDrop === 'CRAFT') {
        return { score: 22, detail: 'Obtention par craft — prix soutenu par le coût de fabrication.', effectiveDrop: 'CRAFT' };
    }
    if (tauxDrop === 'ÉCHANGE') {
        return { score: 8, detail: 'Ressource liée (jetons) — offre limitée, demande aussi contrainte.', effectiveDrop: 'ÉCHANGE' };
    }
    if (tauxDrop === 'MÉTIER') {
        return { score: 5, detail: 'Ressource de métier — offre potentiellement abondante, prix difficile à soutenir.', effectiveDrop: 'MÉTIER' };
    }
    if (tauxDrop === 'QUÊTE') {
        return { score: 24, detail: 'Récompense de quête — offre structurellement très faible.', effectiveDrop: 'QUÊTE' };
    }
    if (tauxDrop === 'SACHET') {
        const effective = 10; // Valeur de base sans prospection
        let score;
        if      (effective <= 2)  score = 19;
        else if (effective <= 5)  score = 14;
        else if (effective <= 12) score = 9;
        else if (effective <= 30) score = 4;
        else                      score = 1;
        return { score, detail: `Sachet — drop de base effectif ${effective.toFixed(2)} %.`, effectiveDrop: effective };
    }
    if (tauxDrop == null) {
        return { score: 12, detail: 'Taux de drop non renseigné — score neutre.', effectiveDrop: null };
    }

    const base      = parseFloat(tauxDrop);
    const effective = Math.min(base, 100);

    let score;
    if      (effective === 0)   score = 25;
    else if (effective <= 0.5)  score = 23;
    else if (effective <= 2)    score = 19;
    else if (effective <= 5)    score = 14;
    else if (effective <= 12)   score = 9;
    else if (effective <= 30)   score = 4;
    else                        score = 1;

    return {
        score,
        detail: `Drop effectif (${effective.toFixed(2)} %).`,
        effectiveDrop: effective,
    };
}

/**
 * Score de demande craft (0–25 pts).
 *
 * Boost de +3 pts (plafonné à 25) si au moins une recette requiert
 * cette ressource ≥ 10 fois : signal fort de demande concentrée.
 *
 * @param {number} recipeCount
 * @param {number} totalQty
 * @param {number} maxQtyInSingleRecipe
 * @returns {{ score: number, detail: string }}
 */
function _scoreCraftDemand(recipeCount, totalQty, maxQtyInSingleRecipe = 0) {
    if (recipeCount === 0) {
        return { score: 0, detail: 'Aucune recette ne requiert cette ressource.' };
    }

    const composite = recipeCount + Math.sqrt(totalQty);
    let score;
    if      (composite >= 30) score = 25;
    else if (composite >= 15) score = 20;
    else if (composite >= 7)  score = 14;
    else if (composite >= 3)  score = 8;
    else                      score = 4;

    // Boost : au moins une recette utilise la ressource ≥ 10 fois
    const highQtyBoost = maxQtyInSingleRecipe >= 10 ? 3 : 0;
    score = Math.min(25, score + highQtyBoost);

    const boostNote = highQtyBoost > 0
        ? ` · 🔺 +${highQtyBoost} pts (recette requérant ${maxQtyInSingleRecipe}×)`
        : '';

    return {
        score,
        detail: `${recipeCount} recette(s) — ${totalQty} unité(s) requises au total.${boostNote}`,
    };
}

/* =============================================================================
   ANALYSE INDIVIDUELLE
============================================================================= */

/**
 * Point d'entrée du bouton "Analyser" (ressource sélectionnée).
 */
function _runAnalysis() {
    const res = TradingState.selectedResource;
    if (!res) return;

    const p1    = _readNumber('trading-price-1');
    const p10   = _readNumber('trading-price-10');
    const p100  = _readNumber('trading-price-100');
    const p1000 = _readNumber('trading-price-1000');
    const avg   = _readNumber('trading-avg-price');

    // Persistance du prix moyen saisi manuellement
    if (avg > 0) localStorage.setItem(`avg_${res.id_res}`, avg);

    const demand = _computeCraftDemand(res.id_res);

    const marginResult  = _scoreMargin(p1, p10, p100, p1000);
    const avgResult     = _scoreAvgPrice(p1, avg);
    const rarityResult  = _scoreRarity(res.taux_drop);
    const demandResult  = _scoreCraftDemand(demand.recipeCount, demand.totalQty, demand.maxQtyInSingleRecipe);

    const totalScore = marginResult.score + avgResult.score + rarityResult.score + demandResult.score;

    _renderScore(totalScore);
    _renderVerdict(totalScore);
    _renderIndicators([
        { label: '💹 Marge par lots',      ...marginResult, max: 25 },
        { label: '📈 Prix moyen vs actuel', ...avgResult,    max: 25 },
        { label: '💎 Rareté (drop)',        ...rarityResult, max: 25 },
        { label: '📦 Demande craft',        ...demandResult, max: 25 },
    ]);
    _renderPriceTable(p1, p10, p100, p1000, avg);
    _renderActionPlan(p1, p10, p100, p1000, avg);
}

/* =============================================================================
   ANALYSE GLOBALE (TOUTES LES RESSOURCES)
============================================================================= */

/**
 * Analyse toutes les ressources en lisant leurs prix depuis le localStorage.
 * Affiche un tableau classé par score décroissant.
 * @private
 */
function _runBulkAnalysis() {
    const btn  = document.getElementById('btn-trading-analyze-all');

    btn.disabled    = true;
    btn.textContent = '⏳ Analyse en cours...';

    // Defer pour ne pas bloquer le rendu du bouton
    setTimeout(() => {
        const results = _computeBulkScores();

        // Stocke pour re-tri ultérieur sans recalcul
        TradingState.lastBulkResults = results;
        TradingState.bulkSortKey     = 'score';
        TradingState.bulkSortDir     = 'desc';
        TradingState.bulkFilterBoost = false;

        _renderBulkResults(results);

        btn.disabled    = false;
        btn.textContent = '🔍 Analyser toutes les ressources';
    }, 50);
}

/**
 * Calcule les scores pour toutes les ressources ayant au moins un prix renseigné.
 * @returns {Array<object>}
 */
function _computeBulkScores() {
    const results =[];

    // Filtre de niveau
    const levelMinRaw = parseInt(document.getElementById('trading-level-min')?.value, 10);
    const levelMaxRaw = parseInt(document.getElementById('trading-level-max')?.value, 10);
    const levelMin    = Number.isFinite(levelMinRaw) ? levelMinRaw : null;
    const levelMax    = Number.isFinite(levelMaxRaw) ? levelMaxRaw : null;

    dbResources.forEach(res => {
        const lots = getAllPriceLots(res.id_res);
        const p1   = lots.x1   ?? 0;
        const p10  = lots.x10  ?? 0;
        const p100 = lots.x100 ?? 0;
        const p1000= lots.x1000?? 0;

        // Ignorer les ressources sans aucun prix renseigné
        if (!p1 && !p10 && !p100 && !p1000) return;

        // Filtre par niveau (lu depuis localStorage, stocké lors de l'import)
        if (levelMin !== null || levelMax !== null) {
            const niveauRaw = localStorage.getItem(`niveau_${res.id_res}`);
            const niveau    = niveauRaw !== null ? parseInt(niveauRaw, 10) : null;
            if (niveau === null) return; // niveau inconnu → exclu si filtre actif
            if (levelMin !== null && niveau < levelMin) return;
            if (levelMax !== null && niveau > levelMax) return;
        }

        const avgRaw = parseFloat(localStorage.getItem(`avg_${res.id_res}`)) || 0;
        const demand = _computeCraftDemand(res.id_res);

        const marginResult = _scoreMargin(p1, p10, p100, p1000);
        const avgResult    = _scoreAvgPrice(p1, avgRaw);
        const rarityResult = _scoreRarity(res.taux_drop);
        const demandResult = _scoreCraftDemand(demand.recipeCount, demand.totalQty, demand.maxQtyInSingleRecipe);

        const totalScore = marginResult.score + avgResult.score + rarityResult.score + demandResult.score;

        // Meilleur trade (toutes paires de lots comparées)
        const trade            = _findBestTrade(p1, p10, p100, p1000);
        const marginPct        = trade ? trade.marginPct.toFixed(1)  : null;
        const marginMultiplier = trade ? trade.multiplier.toFixed(2) : null;
        const bestBuyLabel     = trade ? trade.buyLot.label          : '—';
        const bestBuyUnit      = trade ? trade.buyLot.unitPrice      : null;

        results.push({
            res,
            totalScore,
            p1, p10, p100, p1000,
            avg: avgRaw,
            bestBuyLabel,
            bestBuyUnit,
            marginPct,
            marginMultiplier,
            hasBoost: demand.maxQtyInSingleRecipe >= 10,
            scores: { margin: marginResult.score, avg: avgResult.score, rarity: rarityResult.score, demand: demandResult.score },
        });
    });

    return results
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, TRADING_MAX_BULK);
}

/**
 * Construit et retourne le HTML du tbody du tableau bulk
 * en appliquant le tri courant de TradingState.
 *
 * @param {Array<object>} results
 * @returns {string} HTML des lignes.
 * @private
 */
function _buildBulkTbody(results) {
    const fmt = n => n != null ? n.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : '—';

    // Filtre boost si actif
    const filtered = TradingState.bulkFilterBoost
        ? results.filter(r => r.hasBoost)
        : results;

    // Tri selon la clé et le sens actifs
    const sorted = [...filtered].sort((a, b) => {
        let va, vb;
        if (TradingState.bulkSortKey === 'margin') {
            va = a.marginMultiplier != null ? parseFloat(a.marginMultiplier) : -Infinity;
            vb = b.marginMultiplier != null ? parseFloat(b.marginMultiplier) : -Infinity;
        } else {
            va = a.totalScore;
            vb = b.totalScore;
        }
        return TradingState.bulkSortDir === 'desc' ? vb - va : va - vb;
    });

    if (!sorted.length) {
        return `<tr><td colspan="10" class="bulk-empty-filter">
            Aucune ressource avec boost 🔺 dans les résultats actuels.
        </td></tr>`;
    }

    return sorted.map((r, i) => {
        const scoreClass = r.totalScore >= 70 ? 'bulk-score-high'
                         : r.totalScore >= 45 ? 'bulk-score-mid'
                         : 'bulk-score-low';

        const marginCell = r.marginMultiplier != null
            ? (() => {
                const val = parseFloat(r.marginMultiplier);
                const cls = val >= 1.5 ? 'price-cheaper'
                          : val >= 1.1 ? 'margin-mult-ok'
                          : val >= 1.0 ? 'margin-mult-low'
                          :              'margin-mult-neg';
                return `<span class="${cls}">X${r.marginMultiplier}</span>`;
              })()
            : '<span class="tx-faint">—</span>';

        const avgCell = r.avg > 0
            ? `${fmt(r.avg)} K`
            : '<span class="tx-faint">—</span>';

        const rowId   = `bulk-plan-${i}`;
        const planHTML = _buildActionPlanHTML(r.p1, r.p10, r.p100, r.p1000, r.avg);

        return `<tr class="bulk-data-row" data-plan-id="${rowId}" title="Cliquer pour voir le plan d'action">
            <td class="bulk-rank">#${i + 1}</td>
            <td class="bulk-res-cell">
                <img src="${getIcon(r.res.icone)}" alt="" class="bulk-res-icon">
                <span class="bulk-res-name copyable-name"
                      title="Cliquer pour copier le nom"
                      onclick="event.stopPropagation(); copyToClipboard('${r.res.nom.replace(/'/g, "\\'")}', this)">${r.res.nom}</span>
            </td>
            <td class="bulk-score-cell">
                <span class="bulk-score ${scoreClass}">${r.totalScore}</span>${r.hasBoost ? ' <span class="bulk-boost-badge" title="Boost : recette requérant ≥ 10 unités">🔺</span>' : ''}
            </td>
            <td class="bulk-mono">${r.p1 > 0 ? fmt(r.p1) + ' K' : '—'}</td>
            <td class="bulk-mono">${r.p10 > 0 ? fmt(r.p10) + ' K' : '—'}</td>
            <td class="bulk-mono">${r.p100 > 0 ? fmt(r.p100) + ' K' : '—'}</td>
            <td class="bulk-mono">${r.p1000 > 0 ? fmt(r.p1000) + ' K' : '—'}</td>
            <td class="bulk-mono">${avgCell}</td>
            <td class="bulk-mono">${marginCell}</td>
            <td class="bulk-breakdown">
                <span title="Marge">M:${r.scores.margin}</span>
                <span title="Prix moyen">A:${r.scores.avg}</span>
                <span title="Rareté">R:${r.scores.rarity}</span>
                <span title="Demande">D:${r.scores.demand}</span>
                <span class="bulk-plan-toggle" title="Plan d'action">📌</span>
            </td>
        </tr>
        <tr class="bulk-plan-row hidden" id="${rowId}">
            <td colspan="10" class="bulk-plan-cell">${planHTML}</td>
        </tr>`;
    }).join('');
}

/**
 * Met à jour les icônes de tri et l'état visuel du bouton filtre boost.
 * @private
 */
function _updateBulkSortIcons() {
    const iconScore  = document.getElementById('bulk-sort-icon-score');
    const iconMargin = document.getElementById('bulk-sort-icon-margin');
    if (iconScore && iconMargin) {
        const asc  = '↑';
        const desc = '↓';
        const neutral = '↕';
        iconScore.textContent  = TradingState.bulkSortKey === 'score'
            ? (TradingState.bulkSortDir === 'desc' ? desc : asc) : neutral;
        iconMargin.textContent = TradingState.bulkSortKey === 'margin'
            ? (TradingState.bulkSortDir === 'desc' ? desc : asc) : neutral;

        document.querySelectorAll('.bulk-th-sortable').forEach(th => th.classList.remove('bulk-th-active'));
        const activeId = TradingState.bulkSortKey === 'score' ? 'bulk-th-score' : 'bulk-th-margin';
        document.getElementById(activeId)?.classList.add('bulk-th-active');
    }

    // Bouton filtre boost
    const btnBoost = document.getElementById('btn-bulk-filter-boost');
    if (btnBoost) {
        btnBoost.classList.toggle('bulk-filter-boost-active', TradingState.bulkFilterBoost);
        btnBoost.textContent = TradingState.bulkFilterBoost
            ? '🔺 Boostés uniquement'
            : '🔺 Tous';
    }
}

/**
 * Attache les listeners de tri (Score, Marge) et de filtre boost.
 * @param {HTMLElement} container
 * @private
 */
function _setupBulkSortListeners(container) {
    // Tri par colonne
    ['score', 'margin'].forEach(key => {
        const th = container.querySelector(`[data-bulk-sort="${key}"]`);
        if (!th) return;
        th.addEventListener('click', () => {
            if (TradingState.bulkSortKey === key) {
                TradingState.bulkSortDir = TradingState.bulkSortDir === 'desc' ? 'asc' : 'desc';
            } else {
                TradingState.bulkSortKey = key;
                TradingState.bulkSortDir = 'desc';
            }
            const tbody = container.querySelector('.trading-bulk-table tbody');
            if (tbody && TradingState.lastBulkResults) {
                tbody.innerHTML = _buildBulkTbody(TradingState.lastBulkResults);
                _attachBulkRowListeners(container);
            }
            _updateBulkSortIcons();
        });
    });

    // Filtre boost 🔺
    const btnBoost = document.getElementById('btn-bulk-filter-boost');
    if (btnBoost) {
        btnBoost.addEventListener('click', () => {
            TradingState.bulkFilterBoost = !TradingState.bulkFilterBoost;
            const tbody = container.querySelector('.trading-bulk-table tbody');
            if (tbody && TradingState.lastBulkResults) {
                tbody.innerHTML = _buildBulkTbody(TradingState.lastBulkResults);
                _attachBulkRowListeners(container);
            }
            _updateBulkSortIcons();
        });
    }
}

/**
 * Attache les listeners de toggle plan d'action sur les .bulk-data-row.
 * Appelée après chaque re-rendu du tbody.
 * @param {HTMLElement} container
 * @private
 */
function _attachBulkRowListeners(container) {
    container.querySelectorAll('.bulk-data-row').forEach(row => {
        row.addEventListener('click', () => {
            const planId  = row.dataset.planId;
            const planRow = document.getElementById(planId);
            if (!planRow) return;

            const isOpen = !planRow.classList.contains('hidden');

            container.querySelectorAll('.bulk-plan-row').forEach(r => r.classList.add('hidden'));
            container.querySelectorAll('.bulk-data-row').forEach(r => r.classList.remove('bulk-row-active'));

            if (!isOpen) {
                planRow.classList.remove('hidden');
                row.classList.add('bulk-row-active');
            }
        });
    });
}

/**
 * Rend le tableau de résultats de l'analyse globale.
 * @param {Array<object>} results
 * @private
 */
function _renderBulkResults(results) {
    const container = document.getElementById('trading-bulk-results');

    document.getElementById('trading-main').classList.add('hidden');
    document.getElementById('trading-empty').classList.add('hidden');
    container.classList.remove('hidden');

    if (!results.length) {
        container.innerHTML = `
            <div class="trading-bulk-empty">
                <p>Aucune ressource avec des prix enregistrés.<br>
                   Importez un fichier de prix dans l'onglet Admin (📥 Importer des prix JSON).</p>
            </div>`;
        return;
    }

    container.innerHTML = `
        <div class="trading-bulk-header">
            <div class="bulk-header-top">
                <div>
                    <h4>🔍 Analyse globale — ${results.length} ressource(s) avec prix</h4>
                    <p class="trading-bulk-legend">Score sur 100 · M = Marge · A = Prix moyen · R = Rareté · D = Demande craft
                       · <em>Cliquer sur Score ou Marge pour trier</em></p>
                </div>
                <button id="btn-bulk-filter-boost" class="btn-bulk-filter-boost"
                        title="Afficher uniquement les ressources avec boost de demande craft ≥ 10×">
                    🔺 Tous
                </button>
            </div>
        </div>
        <div class="trading-bulk-table-wrap">
            <table class="trading-bulk-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Ressource</th>
                        <th id="bulk-th-score" class="bulk-th-sortable bulk-th-active"
                            data-bulk-sort="score">
                            Score <span id="bulk-sort-icon-score" class="bulk-sort-icon">↓</span>
                        </th>
                        <th>×1</th>
                        <th>×10</th>
                        <th>×100</th>
                        <th>×1000</th>
                        <th>Moy.</th>
                        <th id="bulk-th-margin" class="bulk-th-sortable"
                            data-bulk-sort="margin">
                            Marge <span id="bulk-sort-icon-margin" class="bulk-sort-icon">↕</span>
                        </th>
                        <th>Détail</th>
                    </tr>
                </thead>
                <tbody>${_buildBulkTbody(results)}</tbody>
            </table>
        </div>
        <button class="btn-trading-back" id="btn-trading-back">← Retour à la recherche individuelle</button>`;

    _setupBulkSortListeners(container);
    _attachBulkRowListeners(container);

    document.getElementById('btn-trading-back').addEventListener('click', () => {
        container.classList.add('hidden');
        document.getElementById('trading-empty').classList.remove('hidden');
        document.getElementById('trading-search').value = '';
    });
}

/* =============================================================================
   RENDU (ANALYSE INDIVIDUELLE)
============================================================================= */

/**
 * Met à jour le cercle de score.
 * @param {number} score
 * @private
 */
function _renderScore(score) {
    const circle = document.getElementById('trading-score-circle');
    const value  = document.getElementById('trading-score-value');

    value.textContent = score;
    circle.className  = 'trading-score-circle';

    if      (score >= 85) circle.classList.add('score-excellent');
    else if (score >= 70) circle.classList.add('score-good');
    else if (score >= 50) circle.classList.add('score-medium');
    else if (score >= 30) circle.classList.add('score-risky');
    else                  circle.classList.add('score-bad');
}

/**
 * Affiche le verdict textuel.
 * @param {number} score
 * @private
 */
function _renderVerdict(score) {
    const el = document.getElementById('trading-verdict');

    const verdicts =[
        { min: 85, cls: 'verdict-excellent', text: '🔥 Excellente opportunité — foncez !' },
        { min: 70, cls: 'verdict-good',      text: '✅ Bonne opportunité de trading.' },
        { min: 50, cls: 'verdict-medium',    text: '🟡 Opportunité passable — à surveiller.' },
        { min: 30, cls: 'verdict-risky',     text: '⚠️ Risqué — marché peu favorable.' },
        { min:  0, cls: 'verdict-bad',       text: '❌ Mauvaise idée — ne pas trader cette ressource.' },
    ];

    const verdict  = verdicts.find(v => score >= v.min);
    el.className   = `trading-verdict ${verdict.cls}`;
    el.textContent = verdict.text;
}

/**
 * Génère les barres de progression des indicateurs.
 * @param {Array} indicators
 * @private
 */
function _renderIndicators(indicators) {
    const container = document.getElementById('trading-indicators');

    container.innerHTML = indicators.map(ind => {
        const pct      = Math.round((ind.score / ind.max) * 100);
        const barClass = pct >= 70 ? 'bar-good' : pct >= 40 ? 'bar-medium' : 'bar-bad';

        return `
            <div class="trading-indicator">
                <div class="trading-ind-header">
                    <span class="trading-ind-label">${ind.label}</span>
                    <span class="trading-ind-score">${ind.score} / ${ind.max} pts</span>
                </div>
                <div class="trading-ind-bar-track">
                    <div class="trading-ind-bar ${barClass}" style="width: ${pct}%"></div>
                </div>
                <p class="trading-ind-detail">${ind.detail}</p>
            </div>`;
    }).join('');
}

/**
 * Génère le tableau de comparaison des prix par lot et le résumé.
 *
 * @param {number} p1    Prix ×1
 * @param {number} p10   Prix ×10
 * @param {number} p100  Prix ×100
 * @param {number} p1000 Prix ×1000
 * @param {number} avg   Prix moyen
 * @private
 */
function _renderPriceTable(p1, p10, p100, p1000, avg) {
    const container = document.getElementById('trading-price-table');
    const fmt = n => n != null ? n.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : '—';

    const lots = [
        { label: '×1',    total: p1,    size: 1    },
        { label: '×10',   total: p10,   size: 10   },
        { label: '×100',  total: p100,  size: 100  },
        { label: '×1000', total: p1000, size: 1000 },
    ].map(l => ({ ...l, unitPrice: l.total > 0 ? l.total / l.size : null }));

    const trade = _findBestTrade(p1, p10, p100, p1000);

    const marginPct = trade
        ? trade.marginPct.toFixed(1) + ' %'
        : '—';

    container.innerHTML = `
        <h5 class="trading-price-table-title">📋 Tableau des prix</h5>
        <table class="trading-table">
            <thead><tr><th>Lot</th><th>Prix total (K)</th><th>Prix / unité (K)</th></tr></thead>
            <tbody>
                ${lots.map(l => {
                    const isBuy  = trade && l.label === trade.buyLot.label;
                    const isSell = trade && l.label === trade.sellLot.label;
                    const cls    = isBuy ? 'price-cheaper' : isSell ? 'price-sell-ref' : '';
                    const badge  = isBuy ? ' 🎯' : isSell ? ' 💰' : '';
                    return `<tr>
                        <td>${l.label}${badge}</td>
                        <td>${l.total > 0 ? fmt(l.total) : '—'}</td>
                        <td class="${cls}">${l.unitPrice != null ? fmt(l.unitPrice) : '—'}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>

        <div class="trading-summary">
            ${avg > 0 ? `
                <div class="trading-summary-item">
                    <span class="trading-summary-label">Prix moyen</span>
                    <span class="trading-summary-value">${fmt(avg)} K</span>
                </div>` : ''}
            ${trade ? `
                <div class="trading-summary-item">
                    <span class="trading-summary-label">Achat ${trade.buyLot.label} / vente ${trade.sellLot.label}</span>
                    <span class="trading-summary-value price-cheaper">×${trade.multiplier.toFixed(2)}</span>
                </div>` : ''}
            <div class="trading-summary-item">
                <span class="trading-summary-label">Marge brute estimée</span>
                <span class="trading-summary-value ${trade ? 'price-cheaper' : ''}">${marginPct}</span>
            </div>
        </div>`;
}

/* =============================================================================
   PLAN D'ACTION
============================================================================= */

/**
 * Calcule et retourne le HTML du plan d'action pour une ressource donnée.
 * Utilisée aussi bien par la vue individuelle que par le tableau bulk.
 *
 * @param {number} p1    Prix ×1
 * @param {number} p10   Prix ×10
 * @param {number} p100  Prix ×100
 * @param {number} p1000 Prix ×1000
 * @param {number} avg   Prix moyen
 * @returns {string} HTML prêt à injecter.
 * @private
 */
function _buildActionPlanHTML(p1, p10, p100, p1000, avg) {
    const fmt   = n => n != null ? n.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : '—';
    const trade = _findBestTrade(p1, p10, p100, p1000);

    if (!trade) {
        return `<div class="action-plan action-plan-empty">
                    <p>📌 Pas assez de lots renseignés pour déterminer un plan d'action.</p>
                </div>`;
    }

    const { buyLot, sellLot, profit, marginPct, multiplier } = trade;

    // Profit net avec taxe HDV 2% sur la vente
    const TAX        = 0.02;
    const revenueNet = sellLot.total * (1 - TAX);
    const costBuy    = buyLot.unitPrice * sellLot.size;
    const profitNet  = revenueNet - costBuy;

    // Conseil contextuel selon la marge
    let conseil, conseilClass;
    if (marginPct >= 30) {
        conseil      = `🔥 Excellente marge. Achetez ${buyLot.label} et revendez ${sellLot.label} — foncez !`;
        conseilClass = 'plan-conseil-excellent';
    } else if (marginPct >= 15) {
        conseil      = `✅ Bonne opportunité. Testez avec un lot ${buyLot.label} avant d'engager plus.`;
        conseilClass = 'plan-conseil-good';
    } else if (marginPct >= 5) {
        conseil      = `🟡 Marge faible. Limitez à 1–2 opérations et surveillez l'évolution des prix.`;
        conseilClass = 'plan-conseil-medium';
    } else if (profit > 0) {
        conseil      = `⚠️ Marge trop faible (< 5 %). La taxe HDV risque d'absorber le bénéfice — éviter.`;
        conseilClass = 'plan-conseil-risky';
    } else {
        conseil      = `❌ Pas de spread positif — aucune opportunité de trading détectée.`;
        conseilClass = 'plan-conseil-bad';
    }

    // Comparaison avec le prix moyen (basée sur le lot de vente)
    let avgLine = '';
    if (avg > 0 && sellLot.unitPrice > 0) {
        const diffPct = ((avg - sellLot.unitPrice) / avg * 100).toFixed(1);
        const sign    = parseFloat(diffPct) >= 0 ? '−' : '+';
        const cls     = parseFloat(diffPct) >= 0 ? 'price-cheaper' : 'price-sell-ref';
        avgLine = `
            <div class="plan-row">
                <span class="plan-label">📊 Prix moyen HDV</span>
                <span class="plan-value">${fmt(avg)} K/u
                    <span class="${cls}" style="font-size:0.85em">(vente actuelle ${sign}${Math.abs(diffPct)} %)</span>
                </span>
            </div>`;
    }

    return `
        <div class="action-plan">
            <h5 class="action-plan-title">📌 Plan d'action recommandé</h5>

            <div class="plan-row">
                <span class="plan-label">🛒 Acheter</span>
                <span class="plan-value plan-highlight">${buyLot.label}
                    <span class="plan-sub">— ${fmt(buyLot.unitPrice)} K/u · lot total ${fmt(buyLot.total)} K</span>
                </span>
            </div>

            <div class="plan-row">
                <span class="plan-label">💰 Revendre</span>
                <span class="plan-value plan-highlight">${sellLot.label}
                    <span class="plan-sub">— ${fmt(sellLot.unitPrice)} K/u · lot total ${fmt(sellLot.total)} K</span>
                </span>
            </div>

            <div class="plan-row">
                <span class="plan-label">📈 Marge brute</span>
                <span class="plan-value ${marginPct > 0 ? 'price-cheaper' : 'price-sell-ref'}">
                    ${marginPct.toFixed(1)} % · ×${multiplier.toFixed(2)}
                    <span class="plan-sub">(${fmt(sellLot.unitPrice - buyLot.unitPrice)} K/u)</span>
                </span>
            </div>

            <div class="plan-row">
                <span class="plan-label">💵 Profit net (taxe 2 %)</span>
                <span class="plan-value ${profitNet > 0 ? 'price-cheaper' : 'price-sell-ref'}">
                    ${fmt(profitNet)} K
                    <span class="plan-sub">par lot de ${sellLot.size} unités</span>
                </span>
            </div>

            ${avgLine}

            <div class="plan-conseil ${conseilClass}">${conseil}</div>
        </div>`;
}

/**
 * Injecte le plan d'action dans le conteneur de la vue individuelle.
 * @param {number} p1 @param {number} p10 @param {number} p100
 * @param {number} p1000 @param {number} avg
 * @private
 */
function _renderActionPlan(p1, p10, p100, p1000, avg) {
    const container = document.getElementById('trading-action-plan');
    if (!container) return;
    container.innerHTML = _buildActionPlanHTML(p1, p10, p100, p1000, avg);
}

/* =============================================================================
   HELPERS
============================================================================= */

/**
 * Lit et valide un champ numérique.
 * @param {string} id
 * @returns {number}
 * @private
 */
function _readNumber(id) {
    const el  = document.getElementById(id);
    if (!el) return 0;
    const val = parseFloat(el.value);
    return Number.isFinite(val) && val > 0 ? val : 0;
}

/**
 * Réinitialise la zone de résultats individuels.
 * @private
 */
function _resetResults() {
    const scoreEl   = document.getElementById('trading-score-value');
    const circleEl  = document.getElementById('trading-score-circle');
    const verdictEl = document.getElementById('trading-verdict');

    scoreEl.textContent   = '—';
    circleEl.className    = 'trading-score-circle';
    verdictEl.textContent = 'Renseignez les données puis cliquez sur Analyser.';
    verdictEl.className   = 'trading-verdict';

    document.getElementById('trading-indicators').innerHTML  = '';
    document.getElementById('trading-price-table').innerHTML = '';
    document.getElementById('trading-action-plan').innerHTML = '';
}