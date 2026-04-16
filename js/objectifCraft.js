/**
 * @file objectifCraft.js
 * @description Onglet 4 — Planificateur de craft par objectif.
 *
 * Responsabilités :
 *   - Recherche et sélection d'un équipement craftable comme objectif
 *   - Agrégation récursive des ressources nécessaires (achat vs craft optimal)
 *   - Calcul du coût total estimé
 *   - Affichage de la liste de courses avec distinction prix connus / manquants
 *
 * @depends storage.js    — getStoredPrice, priceKeyRes
 * @depends imageCache.js — getIcon
 */

/* =============================================================================
   CONFIGURATION
============================================================================= */

/** Nombre maximum de résultats affichés dans le dropdown de recherche. */
const MAX_SEARCH_RESULTS = 15;

/* =============================================================================
   ÉTAT DU MODULE
============================================================================= */

const ObjectifState = {
    /** @type {object|null} Équipement sélectionné comme objectif de craft. */
    selectedItem: null,
};

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Initialise les listeners de l'onglet Objectif de Craft.
 * Doit être appelée une fois au chargement de la page.
 */
function setupObjectifCraft() {
    const searchInput   = document.getElementById('objectif-search');
    const searchResults = document.getElementById('objectif-search-results');
    const qtyInput      = document.getElementById('objectif-qty');
    const computeBtn    = document.getElementById('btn-compute-objectif');

    searchInput.addEventListener('input', (e) => {
        _handleObjectifSearch(e.target.value, searchInput, searchResults, computeBtn);
    });

    // Ferme le dropdown si clic en dehors
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#objectif-search-results') && e.target !== searchInput) {
            searchResults.classList.add('hidden');
        }
    });

    computeBtn.addEventListener('click', computeObjectif);

    qtyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && ObjectifState.selectedItem) computeObjectif();
    });
}

/**
 * Gère la saisie dans le champ de recherche : filtre les équipements craftables
 * et peuple le dropdown de résultats.
 *
 * @param {string}      rawQuery    - Valeur brute du champ de recherche.
 * @param {HTMLElement} searchInput
 * @param {HTMLElement} searchResults
 * @param {HTMLElement} computeBtn
 * @private
 */
function _handleObjectifSearch(rawQuery, searchInput, searchResults, computeBtn) {
    const query = rawQuery.toLowerCase().trim();
    searchResults.innerHTML = '';

    if (query.length < 2) {
        searchResults.classList.add('hidden');
        return;
    }

    const craftables = dbEquipments
        .filter(item => item.ingredients?.length > 0 && item.nom.toLowerCase().includes(query))
        .slice(0, MAX_SEARCH_RESULTS);

    if (craftables.length === 0) {
        searchResults.classList.add('hidden');
        return;
    }

    searchResults.classList.remove('hidden');
    craftables.forEach(item => {
        const div       = document.createElement('div');
        div.className   = 'dropdown-item';
        div.innerHTML   = `<img src="${getIcon(item.icone)}" alt=""> <span>${item.nom}</span>`;
        div.onclick     = () => _selectObjectifItem(item, searchInput, searchResults, computeBtn);
        searchResults.appendChild(div);
    });
}

/**
 * Sélectionne un équipement comme objectif de craft et met à jour l'UI.
 *
 * @param {object}      item
 * @param {HTMLElement} searchInput
 * @param {HTMLElement} searchResults
 * @param {HTMLElement} computeBtn
 * @private
 */
function _selectObjectifItem(item, searchInput, searchResults, computeBtn) {
    ObjectifState.selectedItem  = item;
    searchInput.value           = item.nom;
    searchResults.classList.add('hidden');

    document.getElementById('objectif-item-icon').src      = getIcon(item.icone);
    document.getElementById('objectif-item-name').textContent  = item.nom;
    document.getElementById('objectif-item-level').textContent = `Niveau ${item.niveau}`;
    document.getElementById('objectif-selected-item').classList.remove('hidden');

    computeBtn.disabled = false;
}

/* =============================================================================
   CALCUL DE L'OBJECTIF
============================================================================= */

/**
 * Calcule la liste de courses optimale pour crafter l'item objectif
 * en quantité donnée, puis affiche le résultat.
 *
 * Point d'entrée principal de l'onglet 4.
 */
function computeObjectif() {
    if (!ObjectifState.selectedItem) return;

    const qty      = _getObjectifQty();
    const shopping = {};

    _aggregateShoppingList(ObjectifState.selectedItem.id_itm, qty, new Set(), shopping);

    _renderObjectifResults(ObjectifState.selectedItem, qty, shopping);
}

/**
 * Lit et valide la quantité saisie par l'utilisateur (minimum 1).
 * @returns {number}
 * @private
 */
function _getObjectifQty() {
    const raw = parseInt(document.getElementById('objectif-qty').value, 10);
    return Math.max(1, raw || 1);
}

/**
 * Agrège récursivement les ressources nécessaires dans la liste de courses.
 *
 * Stratégie à chaque nœud craftable :
 *   - Si un prix d'achat est connu ET moins cher que le craft niveau 1 des
 *     sous-ingrédients → ajouter l'item entier dans la liste de courses.
 *   - Sinon → descendre récursivement dans les sous-ingrédients.
 *
 * Note : le coût de craft comparé est le coût de niveau 1 uniquement
 * (prix direct des ingrédients immédiats), pas le coût récursif optimal.
 * Cette simplification est intentionnelle pour la rapidité du calcul.
 *
 * @param {number} itemId    - ID de l'item à traiter.
 * @param {number} quantity  - Quantité requise pour cet item.
 * @param {Set}    visited   - IDs déjà traités (anti-boucle cyclique).
 * @param {Object} shopping  - Map accumulatrice : resId → { qty, name, icon, price, isCraftable }.
 * @private
 */
function _aggregateShoppingList(itemId, quantity, visited, shopping) {
    if (visited.has(itemId)) return;

    // Copie du Set pour l'isolation de chaque branche récursive
    const branchVisited = new Set(visited);
    branchVisited.add(itemId);

    const equip = dbEquipments.find(e => e.id_itm === itemId);

    if (equip?.ingredients?.length > 0) {
        _aggregateCraftableNode(equip, itemId, quantity, branchVisited, shopping);
    } else {
        _aggregateLeafNode(itemId, quantity, shopping);
    }
}

/**
 * Traite un nœud craftable : décide d'acheter l'item ou de crafter
 * en descendant dans ses ingrédients.
 * @private
 */
function _aggregateCraftableNode(equip, itemId, quantity, branchVisited, shopping) {
    const buyPrice  = getStoredPrice(priceKeyRes(itemId));
    const craftCost = _computeDirectCraftCost(equip);

    // Acheter si le prix est connu et compétitif (comparaison niveau 1 uniquement)
    if (buyPrice > 0 && buyPrice * quantity <= craftCost) {
        if (!shopping[itemId]) {
            shopping[itemId] = {
                qty:         0,
                name:        equip.nom,
                icon:        getIcon(equip.icone),
                price:       buyPrice,
                isCraftable: true,
            };
        }
        shopping[itemId].qty += quantity;
        return;
    }

    // Crafter : descendre dans les ingrédients
    equip.ingredients.forEach(ing =>
        _aggregateShoppingList(ing.id_res, ing.quantite * quantity, branchVisited, shopping)
    );
}

/**
 * Traite un nœud feuille (ressource non craftable) : l'ajoute dans la liste.
 * @private
 */
function _aggregateLeafNode(itemId, quantity, shopping) {
    const res   = dbResources.find(r => r.id_res === itemId);
    const name  = res?.nom  ?? 'Inconnu';
    const icon  = res?.icone ? getIcon(res.icone) : '';
    const price = getStoredPrice(priceKeyRes(itemId));

    if (!shopping[itemId]) {
        shopping[itemId] = { qty: 0, name, icon, price, isCraftable: false };
    }
    shopping[itemId].qty += quantity;
}

/**
 * Calcule le coût de craft direct (niveau 1 uniquement) d'un équipement.
 * Utilisé uniquement pour la comparaison achat/craft dans l'agrégation.
 *
 * @param {object} equip - Équipement avec ses ingrédients.
 * @returns {number} Somme des prix d'achat des ingrédients directs × quantités.
 * @private
 */
function _computeDirectCraftCost(equip) {
    return equip.ingredients.reduce((total, ing) => {
        return total + getStoredPrice(priceKeyRes(ing.id_res)) * ing.quantite;
    }, 0);
}

/* =============================================================================
   RENDU DES RÉSULTATS
============================================================================= */

/**
 * Affiche la liste de courses et le coût total estimé.
 *
 * @param {object} item     - Item objectif sélectionné.
 * @param {number} qty      - Quantité à crafter.
 * @param {Object} shopping - Map des ressources agrégées.
 * @private
 */
function _renderObjectifResults(item, qty, shopping) {
    const entries  = Object.entries(shopping);
    const hasPrice = entries.filter(([, v]) => v.price > 0);
    const noPrice  = entries.filter(([, v]) => v.price === 0);
    const totalCost = hasPrice.reduce((sum, [, v]) => sum + v.price * v.qty, 0);

    const missingWarnHtml = noPrice.length > 0
        ? `<span class="objectif-missing-warn">⚠ ${noPrice.length} prix manquant${noPrice.length > 1 ? 's' : ''}</span>`
        : '';

    document.getElementById('objectif-results').innerHTML = `
        <div class="objectif-result-header">
            <div class="objectif-result-item">
                <img src="${getIcon(item.icone)}" alt="">
                <span>${qty}x ${item.nom}</span>
            </div>
            <div class="objectif-total">
                <span class="objectif-total-label">Coût total estimé</span>
                <span class="objectif-total-value kamas-text">${totalCost} K</span>
                ${missingWarnHtml}
            </div>
        </div>
        <div class="objectif-section-title">📦 Ressources (${entries.length} types)</div>
        <div class="objectif-rows">
            ${_renderShoppingRows(hasPrice, false)}
            ${_renderShoppingRows(noPrice, true)}
        </div>`;
}

/**
 * Génère le HTML des lignes de ressources de la liste de courses.
 *
 * @param {Array}   entries  - Paires [id, shoppingEntry] à afficher.
 * @param {boolean} missing  - Indique si ce groupe a des prix manquants.
 * @returns {string} HTML des lignes.
 * @private
 */
function _renderShoppingRows(entries, missing) {
    return entries.map(([, v]) => `
        <div class="objectif-row${missing ? ' objectif-row-missing' : ''}">
            <img src="${v.icon}" class="objectif-row-icon" alt="">
            <span class="objectif-row-name">${v.name}</span>
            <span class="objectif-row-qty">${v.qty}x</span>
            <span class="objectif-row-cost">
                ${v.price > 0
                    ? `${v.price * v.qty} K`
                    : `<span class="danger-text">Prix manquant</span>`}
            </span>
        </div>`
    ).join('');
}
