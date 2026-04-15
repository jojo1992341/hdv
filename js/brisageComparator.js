/**
 * @file brisageComparator.js
 * @description Onglet 6 — Comparateur de rentabilité de brisage.
 *
 * Identifie les équipements les plus rentables à briser pour obtenir
 * une rune cible donnée, en calculant le gain en kamas attendu vs
 * le coût d'acquisition de chaque item.
 *
 * @depends constants.js    — EFFECT_MAPPING
 * @depends storage.js      — getStoredPrice, priceKeyEquip
 * @depends imageCache.js   — getIcon
 * @depends dealsScanner.js — evaluateTree (calcul coût de craft)
 */

/* =============================================================================
   CONFIGURATION
============================================================================= */

/** Nombre maximum de résultats affichés dans le tableau. @type {number} */
const MAX_BRISAGE_RESULTS = 60;

/** Valeur de ROI substituée quand le ROI est null (pour le tri). @type {number} */
const NULL_ROI_SORT_VALUE = -9999;

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Initialise l'onglet Comparateur de Brisage.
 * Peuple le sélecteur de runes et attache les listeners.
 * Doit être appelée une fois au chargement de la page.
 */
function setupBrisageComparator() {
    const select = document.getElementById('brisage-rune-select');

    _populateRuneSelect(select);
    _initRunePriceFromStorage(select);

    select.addEventListener('change', () => _initRunePriceFromStorage(select));
    document.getElementById('btn-compute-brisage').addEventListener('click', computeBrisage);
}

/**
 * Peuple le sélecteur avec les noms de runes uniques triés.
 * @param {HTMLSelectElement} select
 * @private
 */
function _populateRuneSelect(select) {
    const uniqueRunes = [...new Set(dbRunesWeights.map(r => r.nom))].sort();
    select.innerHTML  = uniqueRunes
        .map(n => `<option value="${n}">${dbRuneNames[n] || n}</option>`)
        .join('');
}

/**
 * Pré-remplit le champ de prix de la rune depuis le localStorage.
 * @param {HTMLSelectElement} select
 * @private
 */
function _initRunePriceFromStorage(select) {
    const price = getStoredPrice(priceKeyRune(select.value));
    if (price > 0) document.getElementById('brisage-rune-price').value = price;
}

/* =============================================================================
   CALCUL PRINCIPAL
============================================================================= */

/**
 * Lance le calcul de rentabilité pour la rune et les filtres sélectionnés.
 * Affiche les résultats triés par ROI décroissant dans un tableau.
 */
function computeBrisage() {
    const params    = _readBrisageParams();
    const container = document.getElementById('brisage-results');

    if (!_validateParams(params, container)) return;

    const rw = dbRunesWeights.find(r => r.nom === params.runeName);
    if (!rw) {
        container.innerHTML = '<div class="brisage-empty">Données de rune introuvables.</div>';
        return;
    }

    const results = _computeBrisageResults(params, rw);

    if (results.length === 0) {
        const displayName = dbRuneNames[params.runeName] || params.runeName;
        container.innerHTML = `
            <div class="brisage-empty">
                Aucun item trouvé avec la rune <strong>${displayName}</strong>
                dans cette plage de niveaux.
            </div>`;
        return;
    }

    results.sort((a, b) => (b.roi ?? NULL_ROI_SORT_VALUE) - (a.roi ?? NULL_ROI_SORT_VALUE));
    container.innerHTML = _renderBrisageTable(results);
}

/**
 * Lit et normalise les paramètres du formulaire de brisage.
 * @returns {{ runeName, runePrice, coeff, lvlMin, lvlMax }}
 * @private
 */
function _readBrisageParams() {
    return {
        runeName:  document.getElementById('brisage-rune-select').value,
        runePrice: parseInt(document.getElementById('brisage-rune-price').value, 10) || 0,
        coeff:     (parseFloat(document.getElementById('brisage-coeff').value) || 100) / 100,
        lvlMin:    parseInt(document.getElementById('brisage-lvl-min').value, 10) || 1,
        lvlMax:    parseInt(document.getElementById('brisage-lvl-max').value, 10) || 230,
    };
}

/**
 * Valide les paramètres et affiche un message d'erreur si nécessaire.
 * @returns {boolean} true si les paramètres sont valides.
 * @private
 */
function _validateParams({ runePrice }, container) {
    if (runePrice === 0) {
        container.innerHTML = '<div class="brisage-empty danger-text">⚠ Renseignez le prix de la rune.</div>';
        return false;
    }
    return true;
}

/**
 * Calcule les résultats de brisage pour chaque équipement éligible.
 *
 * @param {{ runeName, runePrice, coeff, lvlMin, lvlMax }} params
 * @param {object} rw - Entrée dbRunesWeights correspondant à la rune cible.
 * @returns {Array<object>} Résultats de brisage enrichis.
 * @private
 */
function _computeBrisageResults(params, rw) {
    const { runeName, runePrice, coeff, lvlMin, lvlMax } = params;
    const weightUnite      = parseFloat(rw.poids_unite);
    const weightRuneNormal = parseFloat(rw.poids_rune_normal) || weightUnite;
    const results          = [];

    dbEquipments.forEach(item => {
        if (item.niveau < lvlMin || item.niveau > lvlMax) return;
        if (!item.stats?.length) return;

        const matchedEffect = _findMatchingEffect(item.stats, runeName);
        if (!matchedEffect) return;

        const pdb           = (3 * matchedEffect.jet * item.niveau * weightUnite / 200) + 1;
        const expectedRunes = (pdb / weightRuneNormal) * coeff;
        const expectedKamas = Math.round(expectedRunes * runePrice);

        const { itemCost, costSource } = _resolveItemCost(item);
        const craftAnalysis = evaluateTree(item.id_itm, 1, new Set());
        const craftCost = craftAnalysis.cost > 0 ? craftAnalysis.cost : null;
        const profit = expectedKamas - itemCost;
        const roi    = itemCost > 0 ? Math.round((profit / itemCost) * 100) : null;
        const roiCraft = craftCost && craftCost > 0 ? Math.round(((expectedKamas - craftCost) / craftCost) * 100) : null;

        results.push({ item, matchedEffect, expectedRunes, expectedKamas, itemCost, costSource, profit, roi, roiCraft, craftCost });
    });

    return results;
}

/**
 * Cherche dans les stats d'un item l'effet positif correspondant à la rune cible.
 * Retourne les bornes min/max et le jet moyen, ou null si aucun effet trouvé.
 *
 * @param {Array}  stats    - Statistiques de l'équipement.
 * @param {string} runeName - Nom de la rune cible.
 * @returns {{ min: number, max: number, jet: number }|null}
 * @private
 */
function _findMatchingEffect(stats, runeName) {
    for (const stat of stats) {
        const mapping = EFFECT_MAPPING[stat.id_effet];
        if (!mapping || mapping.name !== runeName || mapping.sign === -1) continue;

        const absMin = Math.abs(stat.min || 0);
        const absMax = Math.abs(stat.max || absMin);
        const min    = Math.min(absMin, absMax);
        const max    = Math.max(absMin, absMax);
        if (max === 0) continue;

        return { min, max, jet: Math.ceil((min + max) / 2) };
    }
    return null;
}

/**
 * Résout le coût d'acquisition d'un item :
 * priorité au prix HDV connu, sinon coût de craft calculé récursivement.
 *
 * @param {object} item
 * @returns {{ itemCost: number, costSource: "HDV"|"Craft"|"?" }}
 * @private
 */
function _resolveItemCost(item) {
    const hdvPrice     = getStoredPrice(priceKeyEquip(item.id_itm));
    const craftAnalysis = evaluateTree(item.id_itm, 1, new Set());

    if (hdvPrice > 0)           return { itemCost: hdvPrice,           costSource: 'HDV' };
    if (craftAnalysis.cost > 0) return { itemCost: craftAnalysis.cost, costSource: 'Craft' };
    return { itemCost: 0, costSource: '?' };
}

/* =============================================================================
   RENDU
============================================================================= */

/**
 * Génère le HTML du tableau de résultats de brisage.
 * @param {Array} results - Résultats triés.
 * @returns {string}
 * @private
 */
function _renderBrisageTable(results) {
    const rows = results
        .slice(0, MAX_BRISAGE_RESULTS)
        .map(_renderBrisageRow)
        .join('');

    return `
        <div class="brisage-table-wrap">
            <table class="brisage-table">
                <thead><tr>
                    <th></th><th>Item</th><th>Nv</th>
                    <th>Jet moyen</th><th>Runes attendues</th>
                    <th>Gain runes (K)</th><th>Coût item (K)</th>
                    <th>Bénéfice (K)</th><th>ROI HDV</th><th>ROI Craft</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

/**
 * Génère le HTML d'une ligne du tableau de résultats.
 * @param {object} r - Résultat de brisage pour un item.
 * @returns {string}
 * @private
 */
function _renderBrisageRow(r) {
    const roiClass   = r.roi === null ? '' : r.roi >= 0 ? 'success-text' : 'danger-text';
    const roiText    = r.roi === null ? '?' : `${r.roi > 0 ? '+' : ''}${r.roi}%`;
    const profitClass = r.profit >= 0 ? 'success-text' : 'danger-text';
    const profitText  = r.profit !== 0 ? `${r.profit > 0 ? '+' : ''}${r.profit} K` : '—';

    const costText = r.itemCost > 0
        ? `${r.itemCost} K <span class="brisage-cost-source">(${r.costSource})</span>`
        : '—';

    const roiCraftClass = r.roiCraft === null ? '' : r.roiCraft >= 0 ? 'success-text' : 'danger-text';
    const roiCraftText  = r.roiCraft === null ? '?' : `${r.roiCraft > 0 ? '+' : ''}${r.roiCraft}%`;

    return `<tr>
        <td><img src="${getIcon(r.item.icone)}" class="brisage-item-icon" alt=""></td>
        <td class="brisage-item-name">${r.item.nom}</td>
        <td class="brisage-level">${r.item.niveau}</td>
        <td class="brisage-mono">${r.matchedEffect.min}–${r.matchedEffect.max}</td>
        <td class="brisage-mono">${r.expectedRunes.toFixed(2)}</td>
        <td class="kamas-text">${r.expectedKamas} K</td>
        <td class="brisage-mono brisage-cost">${costText}</td>
        <td class="${profitClass} brisage-mono">${profitText}</td>
        <td class="${roiClass} brisage-mono brisage-roi">${roiText}</td>
        <td class="${roiCraftClass} brisage-mono brisage-roi">${roiCraftText}</td>
    </tr>`;
}
