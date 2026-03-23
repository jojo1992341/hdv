/**
 * @file dealsScanner.js
 * @description Onglet 2 — Moteur d'analyse de marché (Bons Plans).
 *
 * Responsabilités :
 *   - Filtrage par catégorie d'équipements
 *   - Évaluation récursive du coût de craft optimal (achat vs craft)
 *   - Scan du marché : identification des deals rentables
 *   - Rendu des cartes de deals avec inputs de prix en ligne
 *   - Recalcul dynamique au changement de prix HDV ou de ressource
 *   - Réinitialisation des prix d'une catégorie
 *   - Sauvegarde du snapshot historique après chaque scan
 *
 * @depends storage.js    — getStoredPrice, setStoredPrice, priceKeyRes, priceKeyEquip
 * @depends imageCache.js — getIcon, copyToClipboard
 */

/* =============================================================================
   CONFIGURATION
============================================================================= */

/** Nombre maximum de deals affichés après un scan. @type {number} */
const MAX_DEALS = 50;

/**
 * Délai en ms avant l'exécution du scan, pour laisser le temps à l'UI
 * d'afficher le message "Analyse en cours..." avant de bloquer le thread.
 * @type {number}
 */
const SCAN_DELAY_MS = 50;

/** Nombre maximum de snapshots conservés dans l'historique. @type {number} */
const MAX_HISTORY_SNAPSHOTS = 100;

/* =============================================================================
   ÉTAT DU MODULE
============================================================================= */

const DealsScannerState = {
    /** @type {string} Catégorie d'équipements sélectionnée ("" = toutes) */
    currentCategory: '',
};

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Initialise les listeners de l'onglet Bons Plans.
 * Doit être appelée une fois au chargement de la page.
 */
function setupDealsScanner() {
    document.getElementById('btn-refresh-deals').addEventListener('click', scanMarket);
    document.getElementById('btn-reset-prices').addEventListener('click', resetCategoryPrices);
    document.getElementById('btn-deals-show-hidden')?.addEventListener('click', _showHiddenDealsPanel);

    // Mise à jour info + sidebar à chaque changement de filtre
    const onFilterChange = () => {
        _updateResLevelInfo();
        _renderHighLevelResSidebar();
        _renderLowLevelResSidebar();
    };
    document.getElementById('deals-level-min')?.addEventListener('input', onFilterChange);
    document.getElementById('deals-level-max')?.addEventListener('input', onFilterChange);
}

function populateDealsCategoryFilter() {
    const select     = document.getElementById('filter-category-deals');
    const categories = [...new Set(dbEquipments.map(e => e.categorie || 'Inconnu'))]
        .filter(Boolean)
        .sort();

    select.innerHTML = '<option value="">Toutes les catégories</option>';
    categories.forEach(cat => {
        const opt       = document.createElement('option');
        opt.value       = cat;
        opt.textContent = cat;
        select.appendChild(opt);
    });

    select.addEventListener('change', (e) => {
        DealsScannerState.currentCategory = e.target.value;
        _updateResLevelInfo();
        _renderHighLevelResSidebar();
        _renderLowLevelResSidebar();
    });
}

/**
 * Calcule et affiche le niveau de ressource minimum et maximum
 * nécessaires pour crafter les équipements correspondant aux filtres actifs
 * (catégorie + tranche de niveau).
 *
 * Le niveau de chaque ressource est lu depuis localStorage (clé niveau_{id}),
 * stocké lors de l'import du fichier de prix.
 * @private
 */
function _updateResLevelInfo() {
    const el = document.getElementById('deals-res-level-info');
    if (!el) return;

    const category    = DealsScannerState.currentCategory;
    const levelMinRaw = parseInt(document.getElementById('deals-level-min')?.value, 10);
    const levelMaxRaw = parseInt(document.getElementById('deals-level-max')?.value, 10);
    const levelMin    = Number.isFinite(levelMinRaw) ? levelMinRaw : null;
    const levelMax    = Number.isFinite(levelMaxRaw) ? levelMaxRaw : null;

    // Aucun filtre actif → on masque l'info
    if (!category && levelMin === null && levelMax === null) {
        el.classList.add('hidden');
        return;
    }

    // Filtre les équipements selon catégorie et niveau
    const filtered = dbEquipments.filter(item => {
        if (!item.ingredients?.length) return false;
        if (category && (item.categorie || 'Inconnu') !== category) return false;
        if (levelMin !== null && (item.niveau ?? 0) < levelMin) return false;
        if (levelMax !== null && (item.niveau ?? 0) > levelMax) return false;
        return true;
    });

    if (!filtered.length) {
        el.classList.add('hidden');
        return;
    }

    // Collecte tous les IDs de ressources (ingrédients directs)
    const resIds = new Set();
    filtered.forEach(item => {
        item.ingredients.forEach(ing => resIds.add(ing.id_res));
    });

    // Lit le niveau de chaque ressource depuis localStorage
    let minNiveau = Infinity;
    let maxNiveau = -Infinity;

    resIds.forEach(id => {
        const raw    = localStorage.getItem(`niveau_${id}`);
        const niveau = raw !== null ? parseInt(raw, 10) : NaN;
        if (!Number.isFinite(niveau)) return;
        if (niveau < minNiveau) minNiveau = niveau;
        if (niveau > maxNiveau) maxNiveau = niveau;
    });

    if (minNiveau === Infinity) {
        // Aucun niveau connu → masqué
        el.classList.add('hidden');
        return;
    }

    el.classList.remove('hidden');
    el.innerHTML = `
        <span class="deals-res-level-item">
            📦 Niveau ressource le plus bas : <strong>${minNiveau}</strong>
        </span>
        <span class="deals-res-level-sep">·</span>
        <span class="deals-res-level-item">
            📦 Niveau ressource le plus haut : <strong>${maxNiveau}</strong>
        </span>`;
}

/* =============================================================================
   SIDEBAR — RESSOURCES AU-DESSUS DU NIVEAU MAX
============================================================================= */

function _renderHighLevelResSidebar() {
    _renderResSidebar({
        sidebarId:   'deals-res-sidebar-high',
        listId:      'deals-res-sidebar-list-high',
        subId:       'deals-res-sidebar-high-sub',
        compareFn:   (niveau, levelMax, _levelMin) =>
                         levelMax !== null && Number.isFinite(niveau) && niveau > levelMax,
        badgeLabel:  (levelMax) => `> Niv. ${levelMax}`,
        requiresMax: true,
        requiresMin: false,
    });
}

/* =============================================================================
   SIDEBAR — RESSOURCES EN DESSOUS DU NIVEAU MIN
============================================================================= */

function _renderLowLevelResSidebar() {
    _renderResSidebar({
        sidebarId:   'deals-res-sidebar-low',
        listId:      'deals-res-sidebar-list-low',
        subId:       'deals-res-sidebar-low-sub',
        compareFn:   (niveau, _levelMax, levelMin) =>
                         levelMin !== null && Number.isFinite(niveau) && niveau < levelMin,
        badgeLabel:  (levelMax, levelMin) => `< Niv. ${levelMin}`,
        requiresMax: false,
        requiresMin: true,
    });
}

/* =============================================================================
   SIDEBAR — LOGIQUE COMMUNE
============================================================================= */

/**
 * Moteur générique des deux sidebars de ressources.
 * @param {{ sidebarId, listId, subId, compareFn, badgeLabel, requiresMax, requiresMin }} opts
 * @private
 */
function _renderResSidebar({ sidebarId, listId, subId, compareFn, badgeLabel, requiresMax, requiresMin }) {
    const sidebar = document.getElementById(sidebarId);
    const listEl  = document.getElementById(listId);
    if (!sidebar || !listEl) return;

    const category    = DealsScannerState.currentCategory;
    const levelMaxRaw = parseInt(document.getElementById('deals-level-max')?.value, 10);
    const levelMinRaw = parseInt(document.getElementById('deals-level-min')?.value, 10);
    const levelMax    = Number.isFinite(levelMaxRaw) ? levelMaxRaw : null;
    const levelMin    = Number.isFinite(levelMinRaw) ? levelMinRaw : null;

    // La sidebar n'est visible que si le filtre requis est actif
    if ((requiresMax && levelMax === null) || (requiresMin && levelMin === null)) {
        sidebar.classList.add('hidden');
        return;
    }

    // Filtre les équipements de la tranche active
    const filteredEquips = dbEquipments.filter(item => {
        if (!item.ingredients?.length) return false;
        if (category && (item.categorie || 'Inconnu') !== category) return false;
        if (levelMin !== null && (item.niveau ?? 0) < levelMin) return false;
        if (levelMax !== null && (item.niveau ?? 0) > levelMax) return false;
        return true;
    });

    if (!filteredEquips.length) {
        sidebar.classList.add('hidden');
        return;
    }

    // Collecte les ressources correspondant au critère
    const resMap = new Map();
    filteredEquips.forEach(item => {
        item.ingredients.forEach(ing => {
            const raw    = localStorage.getItem(`niveau_${ing.id_res}`);
            const niveau = raw !== null ? parseInt(raw, 10) : NaN;
            if (!compareFn(niveau, levelMax, levelMin)) return;

            if (!resMap.has(ing.id_res)) {
                const res = dbResources.find(r => r.id_res === ing.id_res);
                resMap.set(ing.id_res, {
                    id:     ing.id_res,
                    nom:    res?.nom   ?? `Ressource #${ing.id_res}`,
                    icone:  res?.icone ?? '',
                    niveau,
                    usedBy: [],
                });
            }
            const entry = resMap.get(ing.id_res);
            if (!entry.usedBy.includes(item.nom)) entry.usedBy.push(item.nom);
        });
    });

    if (resMap.size === 0) {
        sidebar.classList.add('hidden');
        return;
    }

    // Trie : haut niveau → bas pour high, bas → haut pour low
    const sorted = [...resMap.values()].sort((a, b) =>
        requiresMax ? b.niveau - a.niveau : a.niveau - b.niveau
    );

    listEl.innerHTML = sorted.map(entry => {
        const price   = getStoredPrice(priceKeyRes(entry.id));
        const icon    = entry.icone
            ? `<img src="${getIcon(entry.icone)}" class="deals-res-sb-icon" alt="">`
            : '';
        const tooltip = entry.usedBy.slice(0, 4).join(', ') +
                        (entry.usedBy.length > 4 ? '…' : '');

        return `
        <div class="deals-res-sb-row" data-res-id="${entry.id}"
             title="Utilisée dans : ${tooltip}">
            ${icon}
            <div class="deals-res-sb-info">
                <span class="deals-res-sb-name">${entry.nom}</span>
                <span class="deals-res-sb-level">Niv. ${entry.niveau}</span>
            </div>
            <div class="deals-res-sb-price-wrap">
                <input type="number"
                       class="deals-res-sb-price-input"
                       data-res-id="${entry.id}"
                       value="${price > 0 ? price : ''}"
                       min="0"
                       placeholder="Prix ×1">
                <span class="deals-res-sb-unit">K</span>
            </div>
        </div>`;
    }).join('');

    // Listeners prix
    listEl.querySelectorAll('.deals-res-sb-price-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const id  = parseInt(e.target.dataset.resId, 10);
            const val = e.target.value.trim();
            if (val !== '') {
                setStoredPrice(priceKeyRes(id), parseInt(val, 10));
            } else {
                localStorage.removeItem(priceKeyRes(id));
                localStorage.removeItem(priceKeyRes(id) + '_ts');
            }
        });
    });

    // Listeners copie du nom
    listEl.querySelectorAll('.deals-res-sb-name').forEach(el => {
        el.addEventListener('click', () => copyToClipboard(el.textContent.trim(), el));
    });

    sidebar.classList.remove('hidden');

    // Sous-titre dynamique
    const sub = document.getElementById(subId);
    if (sub) {
        sub.textContent = `${resMap.size} ressource${resMap.size > 1 ? 's' : ''} `
                        + badgeLabel(levelMax, levelMin);
    }
}

/* =============================================================================
   RÉINITIALISATION DES PRIX
============================================================================= */

/**
 * Supprime les prix HDV des équipements de la catégorie active,
 * après confirmation de l'utilisateur.
 */
function resetCategoryPrices() {
    const category = DealsScannerState.currentCategory;
    const label    = category || 'toutes les catégories';

    const craftableItems = dbEquipments.filter(e =>
        e.ingredients?.length > 0 &&
        (!category || (e.categorie || 'Inconnu') === category)
    );

    if (craftableItems.length === 0) {
        alert('Aucun équipement craftable trouvé pour cette sélection.');
        return;
    }

    const storedCount = craftableItems.filter(e =>
        localStorage.getItem(priceKeyEquip(e.id_itm)) !== null
    ).length;

    if (storedCount === 0) {
        alert(`Aucun prix HDV enregistré à supprimer pour ${label}.`);
        return;
    }

    const confirmed = confirm(
        `Supprimer ${storedCount} prix HDV d'équipements pour « ${label} » ?`
    );
    if (!confirmed) return;

    craftableItems.forEach(e => localStorage.removeItem(priceKeyEquip(e.id_itm)));
    _showResetFeedback(storedCount);
}

/**
 * Collecte récursivement tous les IDs de ressources utilisées dans la
 * recette d'un item (y compris les sous-recettes imbriquées).
 *
 * @param {number} itemId  - ID de l'item racine.
 * @param {Set}    visited - Set muté en place pour éviter les boucles.
 */
function _collectAllResIds(itemId, visited = new Set()) {
    if (visited.has(itemId)) return;
    visited.add(itemId);

    const equip = dbEquipments.find(e => e.id_itm === itemId);
    equip?.ingredients?.forEach(ing => _collectAllResIds(ing.id_res, visited));
}

/**
 * Affiche un feedback visuel temporaire sur le bouton de réinitialisation.
 * @param {number} count - Nombre de prix supprimés.
 */
function _showResetFeedback(count) {
    const btn          = document.getElementById('btn-reset-prices');
    const originalText = btn.textContent;
    btn.textContent    = `✅ ${count} prix supprimés`;
    btn.disabled       = true;
    setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled    = false;
    }, 2200);
}

/* =============================================================================
   ÉVALUATION RÉCURSIVE DU COÛT (ARBRE DE CRAFT)
============================================================================= */

/**
 * Évalue récursivement le coût optimal d'acquisition d'un item en quantité
 * donnée et génère le HTML de l'arbre de craft correspondant.
 *
 * Stratégie de décision à chaque nœud :
 *   - Si l'item n'est pas craftable → coût = prix d'achat (ou 0 si manquant)
 *   - Si craftable + prix d'achat connu :
 *       → acheter si prix_achat ≤ coût_craft OU si des prix enfants manquent
 *       → crafter sinon
 *   - Si craftable + pas de prix d'achat → crafter récursivement
 *
 * Note : les prix d'ingrédients (y compris craftables) sont toujours stockés
 * sous la clé 'res_{id}'. La clé 'equip_{id}' est réservée au prix de revente
 * HDV de l'item final (géré par scanMarket).
 *
 * @param {number} itemId   - ID de l'item à évaluer.
 * @param {number} quantity - Quantité requise.
 * @param {Set}    visited  - IDs déjà traités (anti-boucle).
 * @param {number} [depth]  - Profondeur d'imbrication (0 = racine).
 * @returns {{ cost: number, missingCount: number, treeHTML: string }}
 */
function evaluateTree(itemId, quantity, visited, depth = 0) {
    if (visited.has(itemId)) return { cost: 0, missingCount: 0, treeHTML: '' };
    visited.add(itemId);

    const equip      = dbEquipments.find(e => e.id_itm === itemId);
    const res        = dbResources.find(r => r.id_res === itemId) ?? equip;
    const name       = res?.nom ?? 'Inconnu';
    const iconUrl    = res?.icone ?? '';
    const buyPrice   = getStoredPrice(priceKeyRes(itemId));
    const isCraftable = !!(equip?.ingredients?.length);

    if (!isCraftable) {
        return _evaluateLeafNode(itemId, quantity, buyPrice, name, iconUrl, depth);
    }

    return _evaluateCraftNode(equip, itemId, quantity, buyPrice, visited, name, iconUrl, depth);
}

/**
 * Évalue un nœud feuille (ressource non craftable).
 * @private
 */
function _evaluateLeafNode(itemId, quantity, buyPrice, name, iconUrl, depth) {
    const isMissing = buyPrice === 0;
    const cost      = buyPrice * quantity;

    const costHtml = isMissing
        ? `<input type="number" class="deal-price-input"
               data-res-id="${itemId}" data-quantity="${quantity}"
               value="" min="0" placeholder="Prix/u (K)">`
        : `${cost} K`;

    const treeHTML = `
        <div class="deal-node nested ${isMissing ? 'missing-price-alert' : ''}"
             style="--depth: ${depth};" data-node-res-id="${itemId}">
            <img src="${getIcon(iconUrl)}">
            <span class="deal-node-name">
                ${quantity}x
                <span class="deal-node-name-text copyable-name"
                      title="Cliquer pour copier">${name}</span>
            </span>
            <span class="deal-node-cost">${costHtml}</span>
        </div>`;

    return { cost, missingCount: isMissing ? 1 : 0, treeHTML };
}

/**
 * Évalue un nœud craftable en comparant achat et craft récursif.
 * @private
 */
function _evaluateCraftNode(equip, itemId, quantity, buyPrice, visited, name, iconUrl, depth) {
    let craftCost        = 0;
    let childMissingCount = 0;
    let childrenHTML     = '';

    equip.ingredients.forEach(ing => {
        const child       = evaluateTree(ing.id_res, ing.quantite * quantity, new Set(visited), depth + 1);
        craftCost        += child.cost;
        childMissingCount += child.missingCount;
        childrenHTML     += child.treeHTML;
    });

    // Nœud racine (depth === 0) : on retourne uniquement les enfants, pas le nœud lui-même
    if (depth === 0) {
        return { cost: craftCost, missingCount: childMissingCount, treeHTML: childrenHTML };
    }

    const { bestCost, finalMissingCount, chosenAction, showChildren } =
        _decideBuyOrCraft(buyPrice, quantity, craftCost, childMissingCount);

    const badgeClass = chosenAction === 'CRAFT' ? 'badge-craft' : 'badge-buy';
    const treeHTML   = `
        <div class="deal-node nested" style="--depth: ${depth};">
            <img src="${getIcon(iconUrl)}">
            <span class="deal-node-name">
                ${quantity}x
                <span class="deal-node-name-text copyable-name"
                      title="Cliquer pour copier">${name}</span>
                <span class="cost-badge ${badgeClass}">${chosenAction}</span>
            </span>
            <span class="deal-node-cost">${bestCost} K</span>
        </div>
        ${showChildren ? childrenHTML : ''}`;

    return { cost: bestCost, missingCount: finalMissingCount, treeHTML };
}

/**
 * Décide si un nœud craftable doit être acheté ou crafté.
 *
 * @param {number} buyPrice          - Prix d'achat du nœud.
 * @param {number} quantity          - Quantité requise.
 * @param {number} craftCost         - Coût total du craft récursif.
 * @param {number} childMissingCount - Nombre de prix enfants manquants.
 * @returns {{ bestCost, finalMissingCount, chosenAction, showChildren }}
 * @private
 */
function _decideBuyOrCraft(buyPrice, quantity, craftCost, childMissingCount) {
    if (buyPrice > 0) {
        const shouldBuy = childMissingCount > 0 || (buyPrice * quantity) <= craftCost;
        if (shouldBuy) {
            return { bestCost: buyPrice * quantity, finalMissingCount: 0, chosenAction: 'ACHAT', showChildren: false };
        }
        return { bestCost: craftCost, finalMissingCount: 0, chosenAction: 'CRAFT', showChildren: true };
    }
    return { bestCost: craftCost, finalMissingCount: childMissingCount, chosenAction: 'CRAFT', showChildren: true };
}

/* =============================================================================
   RECALCUL D'UNE CARTE DE DEAL
============================================================================= */

/**
 * Recalcule et met à jour l'affichage d'une carte de deal existante
 * après modification d'un prix (HDV ou ressource).
 *
 * @param {HTMLElement} cardEl - Élément DOM de la carte `.deal-card`.
 */
function recalcDealCard(cardEl) {
    const itemId = parseInt(cardEl.dataset.itemId, 10);
    if (!dbEquipments.find(e => e.id_itm === itemId)) return;

    const hdvInput  = cardEl.querySelector('.deal-hdv-input');
    const hdvPrice  = hdvInput ? (parseInt(hdvInput.value, 10) || 0) : getStoredPrice(priceKeyEquip(itemId));
    const analysis  = evaluateTree(itemId, 1, new Set());
    const profit    = hdvPrice - analysis.cost;
    const profitPct = analysis.cost > 0 ? Math.round((profit / analysis.cost) * 100) : 0;
    const isProfit  = profit > 0;

    _updateCardMetrics(cardEl, analysis.cost, profit, profitPct, isProfit);
    _updateMissingBadge(cardEl, analysis.missingCount);
    _updateMissingNodes(cardEl);
}

/** @private */
function _updateCardMetrics(cardEl, craftCost, profit, profitPct, isProfit) {
    const costSpan = cardEl.querySelector('.deal-cost-value');
    if (costSpan) costSpan.textContent = `Coût Craft : ${craftCost} K`;

    const profitAmountEl = cardEl.querySelector('.deal-profit-amount');
    if (profitAmountEl) {
        profitAmountEl.textContent  = isProfit ? `+${profit} K` : `${profit} K`;
        profitAmountEl.className    = `deal-profit-amount ${isProfit ? 'success-text' : 'danger-text'}`;
    }

    const profitPctEl = cardEl.querySelector('.deal-profit-pct');
    if (profitPctEl) {
        profitPctEl.textContent = isProfit ? `+${profitPct}%` : `${profitPct}%`;
        profitPctEl.className   = `deal-profit-pct ${isProfit ? 'success-text' : 'danger-text'}`;
    }
}

/** @private */
function _updateMissingBadge(cardEl, missingCount) {
    const badge = cardEl.querySelector('.deal-missing-badge');
    if (!badge) return;
    if (missingCount === 0) {
        badge.style.display = 'none';
    } else {
        badge.style.display = '';
        badge.textContent   = `⚠️ ${missingCount} prix manquant${missingCount > 1 ? 's' : ''}`;
    }
}

/** @private */
function _updateMissingNodes(cardEl) {
    cardEl.querySelectorAll('.deal-price-input').forEach(input => {
        const nodeDiv = input.closest('.deal-node');
        if (!nodeDiv) return;
        nodeDiv.classList.toggle('missing-price-alert', !(parseInt(input.value, 10) > 0));
    });
}

/* =============================================================================
   SCAN DU MARCHÉ
============================================================================= */

/**
 * Lance l'analyse du marché : évalue la rentabilité de tous les équipements
 * craftables ayant un prix HDV renseigné, trie les résultats et les affiche.
 *
 * Un snapshot des 5 meilleurs deals est sauvegardé dans l'historique.
 */
function scanMarket() {
    const container     = document.getElementById('deals-container');
    container.innerHTML = '<div class="empty-deals-message">Analyse du marché en cours...</div>';

    // Délai pour laisser le navigateur peindre le message avant le calcul
    setTimeout(() => {
        const deals = _computeDeals();
        const dealsToShow = _sortDealsByPriority(deals);

        if (dealsToShow.length > 0) {
            _saveHistorySnapshot(dealsToShow);
        }

        _renderDealCards(container, dealsToShow);
        _renderHighLevelResSidebar();
        _renderLowLevelResSidebar();
    }, SCAN_DELAY_MS);
}

/**
 * Calcule les deals rentables pour la catégorie active.
 * Groupe les deals par nombre de prix manquants.
 *
 * @returns {Object.<number, Array>} Deals indexés par missingCount.
 * @private
 */
function _computeDeals() {
    const category    = DealsScannerState.currentCategory;
    const dealsByMissing = {};

    const levelMinRaw = parseInt(document.getElementById('deals-level-min')?.value, 10);
    const levelMaxRaw = parseInt(document.getElementById('deals-level-max')?.value, 10);
    const levelMin    = Number.isFinite(levelMinRaw) ? levelMinRaw : null;
    const levelMax    = Number.isFinite(levelMaxRaw) ? levelMaxRaw : null;

    dbEquipments.forEach(item => {
        if (!item.ingredients?.length) return;
        if (category && (item.categorie || 'Inconnu') !== category) return;

        // Filtre par niveau
        if (levelMin !== null && (item.niveau ?? 0) < levelMin) return;
        if (levelMax !== null && (item.niveau ?? 0) > levelMax) return;

        const hdvPrice = getStoredPrice(priceKeyEquip(item.id_itm));
        if (hdvPrice <= 0) return;

        // Exclure les items cachés manuellement
        if (HiddenItems.isHiddenDeal(item.id_itm)) return;

        const analysis  = evaluateTree(item.id_itm, 1, new Set());
        const profit    = hdvPrice - analysis.cost;
        if (profit <= 0) return;

        const profitPct = analysis.cost > 0 ? Math.round((profit / analysis.cost) * 100) : 0;
        const key       = analysis.missingCount;

        if (!dealsByMissing[key]) dealsByMissing[key] = [];
        dealsByMissing[key].push({
            item, hdvPrice, profit, profitPct,
            cost:         analysis.cost,
            treeHTML:     analysis.treeHTML,
            missingCount: analysis.missingCount,
        });
    });

    return dealsByMissing;
}

/**
 * Trie et sélectionne les meilleurs deals (priorité : moins de prix manquants,
 * puis meilleur ROI), dans la limite de MAX_DEALS.
 *
 * @param {Object.<number, Array>} dealsByMissing
 * @returns {Array}
 * @private
 */
function _sortDealsByPriority(dealsByMissing) {
    const missingKeys  = Object.keys(dealsByMissing).map(Number).sort((a, b) => a - b);
    const dealsToShow  = [];

    for (const key of missingKeys) {
        if (dealsToShow.length >= MAX_DEALS) break;
        dealsByMissing[key].sort((a, b) => b.profitPct - a.profitPct);
        const remaining = MAX_DEALS - dealsToShow.length;
        dealsToShow.push(...dealsByMissing[key].slice(0, remaining));
    }

    return dealsToShow;
}

/**
 * Sauvegarde un snapshot des meilleurs deals dans l'historique localStorage.
 * Limite l'historique à MAX_HISTORY_SNAPSHOTS entrées.
 *
 * @param {Array} dealsToShow
 * @private
 */
function _saveHistorySnapshot(dealsToShow) {
    const history = JSON.parse(localStorage.getItem('scan_history') || '[]');

    history.push({
        ts:       Date.now(),
        category: DealsScannerState.currentCategory || 'Toutes',
        top5:     dealsToShow.slice(0, 5).map(d => ({
            nom:       d.item.nom,
            profit:    d.profit,
            profitPct: d.profitPct,
            niveau:    d.item.niveau,
        })),
    });

    if (history.length > MAX_HISTORY_SNAPSHOTS) {
        history.splice(0, history.length - MAX_HISTORY_SNAPSHOTS);
    }

    localStorage.setItem('scan_history', JSON.stringify(history));
}

/**
 * Affiche les cartes de deals dans le conteneur principal.
 *
 * @param {HTMLElement} container
 * @param {Array}       deals
 * @private
 */
function _renderDealCards(container, deals) {
    container.innerHTML = '';

    if (deals.length === 0) {
        container.innerHTML = `
            <div class="empty-deals-message">
                Aucun bon plan rentable trouvé.<br>
                Essayez de renseigner plus de prix dans l'interface d'administration.
            </div>`;
        return;
    }

    deals.forEach(deal => {
        const card = _buildDealCard(deal);
        _attachCardListeners(card);
        container.appendChild(card);
    });
}

/**
 * Construit l'élément DOM d'une carte de deal.
 *
 * @param {object} deal
 * @returns {HTMLElement}
 * @private
 */
function _buildDealCard(deal) {
    const card          = document.createElement('div');
    card.className      = 'deal-card';
    card.dataset.itemId = deal.item.id_itm;

    const missingBadgeHtml = deal.missingCount === 0 ? '' : `
        <span class="deal-missing-badge">
            ⚠️ ${deal.missingCount} prix manquant${deal.missingCount > 1 ? 's' : ''}
        </span>`;

    card.innerHTML = `
        <div class="deal-header">
            <img src="${getIcon(deal.item.icone)}" alt="">
            <div class="deal-header-info">
                <h3>
                    <span class="deal-equip-name copyable-name"
                          title="Cliquer pour copier">${deal.item.nom}</span>
                    ${missingBadgeHtml}
                </h3>
                <div class="deal-metrics">
                    <span>Niveau ${deal.item.niveau}</span>
                    <span class="deal-cost-value">Coût Craft : ${deal.cost} K</span>
                    <label class="deal-hdv-label">
                        Prix HDV :
                        <input type="number" class="deal-hdv-input"
                               data-equip-id="${deal.item.id_itm}"
                               value="${deal.hdvPrice}" min="0">
                        <span class="deal-hdv-unit">K</span>
                    </label>
                </div>
            </div>
            <div class="deal-card-actions">
                <button class="btn-add-to-cart" data-item-id="${deal.item.id_itm}"
                        title="Ajouter au panier">
                    🛒 Panier
                </button>
                <button class="btn-hide-deal" data-item-id="${deal.item.id_itm}"
                        title="Cacher ce bon plan">
                    🙈 Cacher
                </button>
                <div class="deal-profit-badge">
                    <span class="deal-profit-amount success-text">+${deal.profit} K</span>
                    <span class="deal-profit-pct success-text">+${deal.profitPct}%</span>
                    <span class="deal-profit-label">Bénéfice Net</span>
                </div>
            </div>
        </div>
        <div class="deal-tree-container">${deal.treeHTML}</div>`;

    return card;
}

/**
 * Attache tous les listeners d'interaction sur une carte de deal :
 * modification du prix HDV, saisie de prix manquants, copie de noms.
 *
 * @param {HTMLElement} card
 * @private
 */
function _attachCardListeners(card) {
    // Bouton panier
    const cartBtn = card.querySelector('.btn-add-to-cart');
    if (cartBtn) {
        cartBtn.addEventListener('click', () => {
            addToCart(parseInt(cartBtn.dataset.itemId, 10));
        });
    }

    // Bouton cacher
    const hideBtn = card.querySelector('.btn-hide-deal');
    if (hideBtn) {
        hideBtn.addEventListener('click', () => {
            const id = parseInt(hideBtn.dataset.itemId, 10);
            HiddenItems.hideDeal(id);
            card.style.transition = 'opacity 0.25s';
            card.style.opacity    = '0';
            setTimeout(() => card.remove(), 260);
        });
    }

    // Prix HDV
    const hdvInput = card.querySelector('.deal-hdv-input');
    if (hdvInput) {
        hdvInput.addEventListener('input', (e) => {
            setStoredPrice(priceKeyEquip(e.target.dataset.equipId), e.target.value);
            recalcDealCard(card);
        });
    }

    // Prix de ressources manquantes (saisis directement dans l'arbre)
    card.querySelectorAll('.deal-price-input').forEach(input => {
        input.addEventListener('input', (e) => {
            setStoredPrice(priceKeyRes(e.target.dataset.resId), e.target.value);
            recalcDealCard(card);
        });
    });

    // Copie des noms cliquables
    card.querySelectorAll('.copyable-name').forEach(el => {
        el.addEventListener('click', function () {
            copyToClipboard(this.textContent.trim(), this);
        });
    });
}

/* =============================================================================
   PANNEAU DES BONS PLANS CACHÉS
============================================================================= */

/**
 * Affiche dans le conteneur deals la liste des bons plans cachés,
 * avec possibilité de les réafficher.
 * @private
 */
function _showHiddenDealsPanel() {
    const container = document.getElementById('deals-container');
    const hiddenIds = HiddenItems.allHiddenDeal();

    if (hiddenIds.size === 0) {
        container.innerHTML = `<div class="empty-deals-message">Aucun bon plan caché pour l'instant.</div>`;
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
            <button class="btn-unhide-deal" data-item-id="${id}">👁 Réafficher</button>
        </div>`;
    }).join('');

    container.innerHTML = `
        <div class="hidden-panel">
            <div class="hidden-panel-header">
                <h4>Bons plans cachés (${hiddenIds.size})</h4>
                <button id="btn-unhide-all-deals" class="btn-unhide-all">Tout réafficher</button>
            </div>
            <div class="hidden-panel-list">${rows}</div>
        </div>`;

    container.querySelector('#btn-unhide-all-deals').addEventListener('click', () => {
        HiddenItems.clearAllDeal();
        container.innerHTML = `<div class="empty-deals-message">Tous les bons plans sont de nouveau visibles.</div>`;
    });

    container.querySelectorAll('.btn-unhide-deal').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.itemId, 10);
            HiddenItems.showDeal(id);
            btn.closest('.hidden-item-row').remove();
            const remaining = container.querySelectorAll('.hidden-item-row').length;
            const h4 = container.querySelector('.hidden-panel-header h4');
            if (h4) h4.textContent = `Bons plans cachés (${remaining})`;
            if (remaining === 0) {
                container.innerHTML = `<div class="empty-deals-message">Tous les bons plans sont de nouveau visibles.</div>`;
            }
        });
    });
}
