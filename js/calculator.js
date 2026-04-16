/**
 * @file calculator.js
 * @description Onglet 1 — Calculateur de runes et de recettes de craft.
 *
 * Responsabilités :
 *   - Recherche et sélection d'un équipement
 *   - Rendu de la recette de craft (mode simple et multi)
 *   - Calcul du coût optimal de craft (achat vs craft récursif)
 *   - Calcul et affichage des runes attendues par brisage
 *   - Calcul du seuil de rentabilité et de la meilleure stratégie de focus
 *
 * @depends constants.js       — EFFECT_MAPPING
 * @depends storage.js         — getStoredPrice, setStoredPrice, priceKeyRes,
 *                               priceKeyEquip, priceKeyRune
 * @depends imageCache.js      — getIcon, copyToClipboard
 * @depends focusStrategy.js   — calcPdbs, calcBestFocusStrategy
 */

/* =============================================================================
   ÉTAT DU CALCULATEUR
   Encapsulé dans un objet pour éviter la pollution du scope global.
   Toutes les fonctions de ce module lisent/écrivent cet objet.
============================================================================= */

const CalculatorState = {
    /** @type {object|null} Équipement actuellement sélectionné */
    selectedItem: null,

    /**
     * Effets valides de l'équipement sélectionné, enrichis des poids de runes.
     * @type {Array<{name, abbr, min, max, weightUnite, weightRuneNormal, index, sign}>}
     */
    validEffects: [],

    /**
     * Jets courants par index d'effet (modifiables par l'utilisateur).
     * @type {Object.<number, number>}
     */
    itemJets: {},
};

/* =============================================================================
   TIER HELPERS
============================================================================= */

const TIER_MULTIPLIERS = { x1: 1, x10: 10, x100: 100, x1000: 1000 };

/**
 * Retourne le prix unitaire d'une ressource en fonction du palier actif.
 * Si le palier est x10/x100/x1000, lit le prix du lot et divise par le multiplicateur.
 * Fallback sur le prix de base si aucun prix de lot n'existe.
 *
 * @param {number} id - ID de la ressource.
 * @returns {number} Prix unitaire.
 */
function _getUnitPrice(id) {
    const tier = getPriceTier();
    if (tier === 'x1') return getStoredPrice(priceKeyRes(id));

    const mult = TIER_MULTIPLIERS[tier];
    const lotPrice = getStoredPriceLot(id, tier);
    if (lotPrice !== null && lotPrice > 0) return Math.round(lotPrice / mult);

    // Fallback: prix de base
    return getStoredPrice(priceKeyRes(id));
}

/**
 * Sauvegarde un prix dans le bon palier et synchronise le prix unitaire.
 *
 * @param {number} id - ID de la ressource.
 * @param {number} value - Prix saisi par l'utilisateur (prix du lot).
 */
function _setTierPrice(id, value) {
    const tier = getPriceTier();
    const mult = TIER_MULTIPLIERS[tier];

    // Sauvegarde dans le palier actif
    setStoredPriceLot(id, tier, value);

    // Synchronise le prix unitaire vers la clé de base
    const unitPrice = Math.round(value / mult);
    setStoredPrice(priceKeyRes(id), unitPrice);
}

/* =============================================================================
   SÉLECTEUR DE PALIER
============================================================================= */

/**
 * Initialise les boutons de sélection de palier (calculateur + brisage).
 * Lit le palier depuis localStorage et met à jour l'état actif des boutons.
 */
function setupTierSelector() {
    document.querySelectorAll('.tier-btn').forEach(btn => {
        // Marque le bouton actif initial
        if (btn.dataset.tier === getPriceTier()) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }

        btn.addEventListener('click', () => {
            const tier = btn.dataset.tier;
            setPriceTier(tier);

            // Met à jour tous les boutons (calculateur + brisage)
            document.querySelectorAll('.tier-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.tier === tier);
            });

            // Rafraîchit les prix affichés
            if (typeof renderRecipe === 'function') renderRecipe();
        });
    });
}

/* =============================================================================
   RÉFÉRENCES AUX DONNÉES GLOBALES (injectées par app.js au démarrage)
   Ces variables sont lues depuis le scope global de app.js.
   À terme, passer en paramètre via une fonction init(db).
============================================================================= */
// dbEquipments, dbResources, dbRunesWeights, dbRuneNames  ← scope global app.js

/* =============================================================================
   INITIALISATION DES LISTENERS
============================================================================= */

/**
 * Initialise la barre de recherche d'équipements (Onglet 1).
 * Affiche une liste déroulante filtrée à partir de 2 caractères saisis.
 */
function setupSearch() {
    const searchInput   = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        searchResults.innerHTML = '';

        if (query.length < 2) {
            searchResults.classList.add('hidden');
            return;
        }

        const matches = dbEquipments
            .filter(item => item.nom.toLowerCase().includes(query))
            .slice(0, 20);

        if (matches.length === 0) {
            searchResults.classList.add('hidden');
            return;
        }

        searchResults.classList.remove('hidden');
        matches.forEach(item => {
            const div = document.createElement('div');
            div.className = 'dropdown-item';
            div.innerHTML = `<img src="${getIcon(item.icone)}" alt=""> <span>${item.nom}</span>`;
            div.onclick = () => {
                selectItem(item);
                searchResults.classList.add('hidden');
                searchInput.value = '';
            };
            searchResults.appendChild(div);
        });
    });

    // Fermer le dropdown si clic hors de la zone de recherche
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrapper')) {
            searchResults.classList.add('hidden');
        }
    });
}

/**
 * Initialise les listeners globaux du calculateur :
 * coefficient de brisage, multiplicateur de craft, mode récursif, prix HDV.
 */
function setupGlobalListeners() {
    const coeffInput = document.getElementById('item-coeff');
    coeffInput.addEventListener('input', () => {
        updateCalculations();
        // Sauvegarde le coeff par équipement
        if (CalculatorState.selectedItem) {
            const coeff = coeffInput.value || '75';
            localStorage.setItem('coeff_' + CalculatorState.selectedItem.id_itm, coeff);
        }
        // Met à jour l'affichage du coefficient dans le scanner
        const display = document.getElementById('smash-coeff-display');
        if (display) display.textContent = (coeffInput.value || '75') + ' %';
    });

    document.getElementById('craft-multiplier').addEventListener('input', (e) => {
        const multiplier = parseInt(e.target.value, 10) || 1;
        document.querySelectorAll('.multi-qty').forEach(span => {
            const baseQty = parseInt(span.dataset.baseQty, 10) || 0;
            span.textContent = `${baseQty * multiplier}x`;
        });
        updateCalculations();
    });

    document.getElementById('toggle-recursive-craft').addEventListener('change', () => {
        renderRecipe();
        updateCalculations();
    });

    document.getElementById('item-hdv-price').addEventListener('input', (e) => {
        if (CalculatorState.selectedItem) {
            setStoredPrice(priceKeyEquip(CalculatorState.selectedItem.id_itm), e.target.value);
        }
    });
}

/* =============================================================================
   SÉLECTION D'UN ÉQUIPEMENT
============================================================================= */

/**
 * Sélectionne un équipement et met à jour toute l'interface du calculateur.
 * Point d'entrée principal de l'onglet 1.
 *
 * @param {object} item - Objet équipement issu de dbEquipments.
 */
function selectItem(item) {
    CalculatorState.selectedItem = item;
    document.getElementById('main-content').classList.remove('hidden');

    _renderItemHeader(item);
    renderRecipe();
    prepareRunesData();
    renderRunesTable();
    updateCalculations();
}

/**
 * Met à jour le header de l'item sélectionné (nom, niveau, icône, prix HDV,
 * bouton panier, checkbox "cacher du scanner").
 * @param {object} item
 */
function _renderItemHeader(item) {
    const nameEl = document.getElementById('item-name');
    nameEl.textContent = item.nom;
    nameEl.classList.add('copyable-name');
    nameEl.title = 'Cliquer pour copier';
    nameEl.onclick = () => copyToClipboard(item.nom, nameEl);

    document.getElementById('item-level').textContent = `Niveau ${item.niveau}`;
    document.getElementById('item-icon').src = getIcon(item.icone || '');
    document.getElementById('item-hdv-price').value = getStoredPrice(priceKeyEquip(item.id_itm));

    // Restaure le coefficient par équipement (défaut 75)
    const savedCoeff = localStorage.getItem('coeff_' + item.id_itm) || '75';
    document.getElementById('item-coeff').value = savedCoeff;

    // Bouton "Ajouter au panier"
    const cartBtn = document.getElementById('calc-btn-add-to-cart');
    if (cartBtn) {
        cartBtn.onclick = () => {
            if (typeof addToCart === 'function') addToCart(item.id_itm);
        };
    }

    // Checkbox "Cacher du scanner de brisage"
    const hideChk = document.getElementById('calc-hide-smash');
    if (hideChk) {
        hideChk.checked = HiddenItems.isHiddenSmash(item.id_itm);
        hideChk.onchange = () => {
            HiddenItems.toggleSmash(item.id_itm);
        };
    }
}

/* =============================================================================
   CALCUL DU COÛT OPTIMAL (ACHAT vs CRAFT)
============================================================================= */

/**
 * Calcule récursivement le coût optimal d'acquisition d'un item :
 * compare le prix d'achat HDV au coût de craft de ses ingrédients.
 *
 * @param {number} itemId  - ID de l'item à évaluer.
 * @param {Set}    visited - IDs déjà visités (évite les boucles infinies).
 * @returns {{ best: number, action: "buy"|"craft", craftCost: number, validCraft: boolean }}
 */
function getOptimalCost(itemId, visited = new Set()) {
    if (visited.has(itemId)) {
        return { best: 0, action: 'buy', craftCost: 0, validCraft: false };
    }
    visited.add(itemId);

    const buyPrice     = getStoredPrice(priceKeyRes(itemId));
    const craftableItem = dbEquipments.find(e => e.id_itm === itemId);

    if (!craftableItem?.ingredients?.length) {
        return { best: buyPrice, action: 'buy', craftCost: 0, validCraft: false };
    }

    let craftCost  = 0;
    let validCraft = true;

    craftableItem.ingredients.forEach(ing => {
        const child = getOptimalCost(ing.id_res, new Set(visited));
        if (child.best === 0) validCraft = false;
        craftCost += child.best * ing.quantite;
    });

    if (!validCraft || craftCost === 0) return { best: buyPrice, action: 'buy', craftCost, validCraft: false };
    if (buyPrice === 0)                 return { best: craftCost, action: 'craft', craftCost, validCraft: true };
    if (craftCost < buyPrice)           return { best: craftCost, action: 'craft', craftCost, validCraft: true };
    return { best: buyPrice, action: 'buy', craftCost, validCraft: true };
}

/* =============================================================================
   RENDU DE LA RECETTE
============================================================================= */

/**
 * Construit et affiche la recette de craft de l'item sélectionné.
 * Génère deux vues synchronisées : mode simple (x1) et mode multi (xN).
 */
function renderRecipe() {
    const containerSingle = document.getElementById('recipe-container-single');
    const containerMulti  = document.getElementById('recipe-container-multi');
    containerSingle.innerHTML = '';
    containerMulti.innerHTML  = '';

    const item = CalculatorState.selectedItem;
    if (!item?.ingredients) return;

    const useRecursive = document.getElementById('toggle-recursive-craft').checked;
    const multiplier   = parseInt(document.getElementById('craft-multiplier').value, 10) || 1;

    item.ingredients.forEach(ing => _buildRecipeNode(ing, 0, multiplier, useRecursive, containerSingle, containerMulti));

    _syncPriceInputs('single-price', 'multi-price');
}

/**
 * Construit récursivement un nœud de recette dans les deux conteneurs.
 *
 * @param {object}      ing          - Ingrédient courant { id_res, quantite }.
 * @param {number}      depth        - Profondeur d'imbrication (0 = niveau racine).
 * @param {number}      mult         - Multiplicateur de craft.
 * @param {boolean}     useRecursive - Afficher les sous-recettes des craftables.
 * @param {HTMLElement} containerSingle
 * @param {HTMLElement} containerMulti
 */
function _buildRecipeNode(ing, depth, mult, useRecursive, containerSingle, containerMulti) {
    const res           = dbResources.find(r => r.id_res === ing.id_res);
    if (!res) return;

    const craftableItem = dbEquipments.find(e => e.id_itm === ing.id_res);
    const isCraftable   = !!(craftableItem?.ingredients?.length);
    const price         = _getUnitPrice(res.id_res);

    _appendRecipeRow(containerSingle, ing, res, depth, ing.quantite, price, isCraftable, false);
    _appendRecipeRow(containerMulti,  ing, res, depth, ing.quantite * mult, price, isCraftable, true);

    if (useRecursive && isCraftable) {
        craftableItem.ingredients.forEach(child =>
            _buildRecipeNode(child, depth + 1, mult, useRecursive, containerSingle, containerMulti)
        );
    }
}

/**
 * Crée et insère un élément de ligne de recette dans un conteneur.
 *
 * @param {HTMLElement} container
 * @param {object}      ing
 * @param {object}      res
 * @param {number}      depth
 * @param {number}      displayQty
 * @param {number}      price
 * @param {boolean}     isCraftable
 * @param {boolean}     isMulti
 */
function _appendRecipeRow(container, ing, res, depth, displayQty, price, isCraftable, isMulti) {
    const div        = document.createElement('div');
    const inputClass = isMulti ? 'multi-price' : 'single-price';
    const qtyClass   = isMulti ? 'recipe-qty multi-qty' : 'recipe-qty';

    div.className = `recipe-item${depth > 0 ? ' is-nested' : ''}`;
    div.style.setProperty('--depth', depth);

    div.innerHTML = `
        <img src="${getIcon(res.icone)}" alt="">
        <span class="${qtyClass}" data-base-qty="${ing.quantite}">${displayQty}x</span>
        <div class="recipe-name-wrapper">
            <div class="recipe-name-title">
                <span class="recipe-name copyable-name" title="Cliquer pour copier">${res.nom}</span>
                ${isCraftable ? `<span class="cost-badge" style="display:none;"></span>` : ''}
            </div>
            ${isCraftable ? `<div class="recipe-meta"></div>` : ''}
        </div>
        <input type="number" class="recipe-price-input ${inputClass}"
               data-id="${res.id_res}" value="${price}" min="0">
    `;

    div.querySelector('.recipe-name').addEventListener('click', function () {
        copyToClipboard(res.nom, this);
    });

    container.appendChild(div);
}

/**
 * Synchronise les inputs de prix entre les vues simple et multi.
 * Met à jour le localStorage et déclenche le recalcul.
 *
 * @param {string} sourceClass - Classe CSS des inputs sources.
 * @param {string} targetClass - Classe CSS des inputs cibles à synchroniser.
 */
function _syncPriceInputs(sourceClass, targetClass) {
    document.querySelectorAll(`.${sourceClass}`).forEach(input => {
        input.addEventListener('input', (e) => {
            const val = e.target.value;
            const id  = e.target.dataset.id;
            document.querySelectorAll(`.${sourceClass}[data-id="${id}"]`).forEach(i => i.value = val);
            document.querySelectorAll(`.${targetClass}[data-id="${id}"]`).forEach(i => i.value = val);
            _setTierPrice(id, val);
            updateCalculations();
        });
    });
}

/* =============================================================================
   MISE À JOUR DES COÛTS DE RECETTE (UI)
============================================================================= */

/**
 * Met à jour l'affichage des coûts dans la recette (badges "CRAFT/ACHAT",
 * totaux simple et multi) et retourne le coût total de la recette x1.
 *
 * @returns {number} Coût total de la recette en x1.
 */
function updateRecipeCostsUI() {
    const item = CalculatorState.selectedItem;
    let totalSingle = 0;

    if (item?.ingredients) {
        item.ingredients.forEach(ing => {
            totalSingle += getOptimalCost(ing.id_res).best * ing.quantite;
        });
    }

    const multiplier = parseInt(document.getElementById('craft-multiplier').value, 10) || 1;
    document.getElementById('total-recipe-price').textContent       = `${totalSingle} K`;
    document.getElementById('total-recipe-price-multi').textContent = `${totalSingle * multiplier} K`;

    document.querySelectorAll('.recipe-item').forEach(itemDiv => {
        const input = itemDiv.querySelector('.recipe-price-input');
        const badge = itemDiv.querySelector('.cost-badge');
        const meta  = itemDiv.querySelector('.recipe-meta');
        if (!input || !badge || !meta) return;

        const costData = getOptimalCost(parseInt(input.dataset.id, 10));
        badge.style.display = 'inline-block';

        if (costData.validCraft) {
            if (costData.action === 'craft') {
                badge.textContent = 'CRAFT MOINS CHER';
                badge.className   = 'cost-badge badge-craft';
                meta.textContent  = `Coût de craft : ${costData.craftCost} K`;
            } else {
                badge.textContent = 'ACHAT MOINS CHER';
                badge.className   = 'cost-badge badge-buy';
                meta.textContent  = `Coût de craft : ${costData.craftCost} K`;
            }
        } else {
            badge.textContent        = 'PRIX INCOMPLET';
            badge.className          = 'cost-badge badge-buy';
            badge.style.borderColor  = 'var(--text-muted)';
            badge.style.color        = 'var(--text-muted)';
            meta.textContent         = 'Remplissez les prix des sous-ressources';
        }
    });

    return totalSingle;
}

/* =============================================================================
   DONNÉES DE RUNES
============================================================================= */

/**
 * Prépare les données de runes de l'item sélectionné :
 * filtre les effets valides, associe les poids de runes, calcule les jets initiaux.
 * Stocke le résultat dans CalculatorState.
 */
function prepareRunesData() {
    CalculatorState.validEffects = [];
    CalculatorState.itemJets     = {};

    const item = CalculatorState.selectedItem;
    if (!item?.stats) return;

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

        const displayName = dbRuneNames[mapping.name] || mapping.name;
        const abbr        = mapping.sign === -1 ? `-${displayName}` : displayName;

        CalculatorState.validEffects.push({
            name:            mapping.name,
            abbr,
            min:             actualMin,
            max:             actualMax,
            weightUnite:     parseFloat(rw.poids_unite),
            weightRuneNormal: parseFloat(rw.poids_rune_normal) || parseFloat(rw.poids_unite),
            index,
            sign:            mapping.sign,
        });

        CalculatorState.itemJets[index] = Math.floor((actualMin + actualMax) / 2);
    });
}

/**
 * Construit et affiche le tableau des runes de l'item sélectionné.
 * Attache les listeners de mise à jour des jets et des prix de runes.
 */
function renderRunesTable() {
    const tbody = document.getElementById('runes-tbody');
    tbody.innerHTML = '';

    CalculatorState.validEffects.forEach(eff => {
        const price    = getStoredPrice(priceKeyRune(eff.name));
        const runeData = dbResources.find(r => r.nom === `Rune ${eff.abbr}`);
        const iconHtml = runeData ? `<img src="${getIcon(runeData.icone)}" alt="${eff.abbr}">` : '';
        const jetMin   = `<span class="jet-bound">${eff.min} - </span>`;
        const jetMax   = `<span class="jet-bound"> - ${eff.max}</span>`;

        const tr = document.createElement('tr');

        if (eff.sign === -1) {
            tr.innerHTML = `
                <td class="rune-cell">${iconHtml}
                    <span class="rune-name-text danger-text" title="Malus ${eff.name}">${eff.abbr}</span>
                </td>
                <td><div class="jet-input-group">
                    ${jetMin}
                    <input type="number" class="jet-input" data-index="${eff.index}"
                           value="${CalculatorState.itemJets[eff.index]}" min="0">
                    ${jetMax}
                </div></td>
                <td style="color:var(--text-muted); font-size:0.8rem;">Malus</td>
                <td>-</td><td>-</td><td>-</td><td>-</td>
            `;
        } else {
            tr.innerHTML = `
                <td class="rune-cell">${iconHtml}
                    <span class="rune-name-text" title="${eff.name}">${eff.abbr}</span>
                </td>
                <td><div class="jet-input-group">
                    ${jetMin}
                    <input type="number" class="jet-input" data-index="${eff.index}"
                           value="${CalculatorState.itemJets[eff.index]}" min="0">
                    ${jetMax}
                </div></td>
                <td><input type="number" class="price-input rune-price-input"
                           data-name="${eff.name}" value="${price}" min="0"></td>
                <td id="base-runes-${eff.index}"></td>
                <td id="base-kamas-${eff.index}" class="kamas-text"></td>
                <td id="focus-runes-${eff.index}"></td>
                <td id="focus-kamas-${eff.index}" class="success-text"></td>
            `;
        }

        tbody.appendChild(tr);
    });

    // Listeners jets
    tbody.querySelectorAll('.jet-input').forEach(input => {
        input.addEventListener('input', (e) => {
            CalculatorState.itemJets[e.target.dataset.index] = parseInt(e.target.value, 10) || 0;
            updateCalculations();
        });
    });

    // Listeners prix de runes
    tbody.querySelectorAll('.rune-price-input').forEach(input => {
        input.addEventListener('input', (e) => {
            setStoredPrice(priceKeyRune(e.target.dataset.name), e.target.value);
            updateCalculations();
        });
    });
}

/* =============================================================================
   ALGORITHME DU SEUIL DE RENTABILITÉ
============================================================================= */

/**
 * Retourne le nombre estimé de brisages nécessaires pour atteindre
 * le coefficient de brisage `c` (formule logarithmique du jeu).
 *
 * Les paliers correspondent aux tranches de probabilité du jeu DOFUS.
 *
 * @param {number} c - Coefficient de brisage (0–4000).
 * @returns {number} Nombre de brisages estimé.
 */
function getSmashCountFromCoeff(c) {
    if (c >= 4000) return 0;
    if (c >= 980)  return 7      * Math.log(c / 4000) / Math.log(49 / 200);
    if (c >= 490)  return 7   + (7  * Math.log(c / 980)  / Math.log(1 / 2));
    if (c >= 250)  return 14  + (19  * Math.log(c / 490)  / Math.log(25 / 49));
    if (c >= 100)  return 33  + (224 * Math.log(c / 250)  / Math.log(2 / 5));
    if (c >= 50)   return 257 + (615 * Math.log(c / 100)  / Math.log(1 / 2));
    if (c >= 10)   return 872 + (10_000 * Math.log(c / 50)  / Math.log(1 / 5));
    if (c > 0)     return 10_872 + (14_000 * Math.log(c / 10) / Math.log(1 / 10));
    return 24_872;
}

/* =============================================================================
   CALCUL GLOBAL (POINT D'ENTRÉE PRINCIPAL)
============================================================================= */

/**
 * Recalcule et rafraîchit l'intégralité de l'interface du calculateur :
 * coûts de recette, PDB des runes, stratégies de focus, seuil de rentabilité.
 *
 * Appelée à chaque modification de prix, de jet ou de coefficient.
 */
function updateCalculations() {
    if (!CalculatorState.selectedItem) return;

    const totalRecipePrice = updateRecipeCostsUI();
    const currentPercent   = parseFloat(document.getElementById('item-coeff').value) || 0;
    const coeff            = currentPercent / 100;
    const level            = CalculatorState.selectedItem.niveau;

    const pdbs     = _calcPdbs(level);
    const totalPdb = Math.max(0, Object.values(pdbs).reduce((sum, v) => sum + v, 0));

    const { baseKamas, focusStrategies } = _calcStrategies(pdbs, totalPdb, coeff);

    document.getElementById('total-base-kamas').textContent = `${Math.round(baseKamas.expected)} K`;

    const allStrategies = [
        { type: 'none', name: 'Aucun focus', ...baseKamas },
        ...focusStrategies,
    ].sort((a, b) => b.guaranteed - a.guaranteed || b.expected - a.expected);

    const best = allStrategies[0];
    document.getElementById('estimated-gain').textContent = `${Math.round(best.expected)} K`;

    _renderProfitThreshold(best, totalRecipePrice, currentPercent, coeff);
    displayBestStrategy(best, totalRecipePrice);
}

/**
 * Calcule les Points De Brisage (PDB) pour chaque effet valide.
 * Utilise la fonction utilitaire calcPdbs de focusStrategy.js.
 *
 * @param {number} level - Niveau de l'équipement.
 * @returns {Object.<number, number>} PDB indexé par index d'effet.
 */
function _calcPdbs(level) {
    return calcPdbs(CalculatorState.validEffects, level, CalculatorState.itemJets);
}

/**
 * Calcule les gains kamas attendus en stratégie base et focus pour chaque rune.
 * Met à jour les colonnes base/focus du tableau des runes.
 * Utilise calcBestFocusStrategy pour la logique de calcul, puis affiche les résultats.
 *
 * @param {Object.<number, number>} pdbs     - PDB par index d'effet.
 * @param {number}                  totalPdb - Somme totale des PDB positifs.
 * @param {number}                  coeff    - Coefficient de brisage (0–1).
 * @returns {{ baseKamas: object, focusStrategies: object[] }}
 */
function _calcStrategies(pdbs, totalPdb, coeff) {
    let baseGuaranteed   = 0;
    let baseExpected     = 0;
    let baseMaxPotential = 0;
    const focusStrategies = [];

    CalculatorState.validEffects.forEach(eff => {
        if (eff.sign === -1) return;

        const price          = getStoredPrice(priceKeyRune(eff.name));
        const baseRunesFloat = (pdbs[eff.index] / eff.weightRuneNormal) * coeff;

        document.getElementById(`base-runes-${eff.index}`).innerHTML  = _formatRuneText(baseRunesFloat);
        document.getElementById(`base-kamas-${eff.index}`).innerHTML  = _formatKamasText(baseRunesFloat, price);

        baseGuaranteed   += Math.floor(baseRunesFloat) * price;
        baseExpected     += baseRunesFloat * price;
        baseMaxPotential += Math.ceil(baseRunesFloat)  * price;

        // Utilise la même formule que calcBestFocusStrategy
        const focusRunesFloat = ((pdbs[eff.index] + 0.5 * (totalPdb - pdbs[eff.index])) / eff.weightRuneNormal) * coeff;

        document.getElementById(`focus-runes-${eff.index}`).innerHTML = _formatRuneText(focusRunesFloat);
        document.getElementById(`focus-kamas-${eff.index}`).innerHTML = _formatKamasText(focusRunesFloat, price);

        focusStrategies.push({
            type:         'focus',
            name:         eff.abbr,
            guaranteed:   Math.floor(focusRunesFloat) * price,
            expected:     focusRunesFloat * price,
            maxPotential: Math.ceil(focusRunesFloat)  * price,
        });
    });

    return {
        baseKamas: { guaranteed: baseGuaranteed, expected: baseExpected, maxPotential: baseMaxPotential },
        focusStrategies,
    };
}

/**
 * Affiche le seuil de rentabilité et le nombre estimé de brisages.
 *
 * @param {{ expected: number }} bestStrategy
 * @param {number} totalRecipePrice
 * @param {number} currentPercent
 * @param {number} coeff
 */
function _renderProfitThreshold(bestStrategy, totalRecipePrice, currentPercent, coeff) {
    const gainEstime = bestStrategy.expected;
    let thresholdText = '--';
    let smashesText   = '';
    let smashes       = 0;

    if (gainEstime > 0 && totalRecipePrice > 0) {
        const thresholdVal = Math.ceil((totalRecipePrice / (gainEstime / coeff)) * 100);
        thresholdText = `${thresholdVal} %`;

        if (thresholdVal <= currentPercent) {
            smashes     = Math.max(0, Math.floor(getSmashCountFromCoeff(thresholdVal) - getSmashCountFromCoeff(currentPercent)));
            smashesText = `<br><span class="prob-detail">soit ${smashes} brisage(s) max</span>`;
        } else {
            smashesText = `<br><span class="prob-detail danger-text">Non rentable</span>`;
        }
    }

    document.getElementById('profit-threshold').innerHTML = thresholdText + smashesText;

    // Synchronise le multiplicateur avec le nombre de brisages calculé
    const multiInput = document.getElementById('craft-multiplier');
    if (document.activeElement !== multiInput) {
        multiInput.value = smashes > 0 ? smashes : 1;
        multiInput.dispatchEvent(new Event('input'));
    }
}

/* =============================================================================
   AFFICHAGE DE LA MEILLEURE STRATÉGIE
============================================================================= */

/**
 * Affiche le conseil de stratégie optimal dans la section "runes".
 * Crée l'élément #profit-advice s'il n'existe pas encore.
 *
 * @param {{ type: string, name: string, guaranteed: number, expected: number, maxPotential: number }} bestStrategy
 * @param {number} totalRecipePrice
 */
function displayBestStrategy(bestStrategy, totalRecipePrice) {
    let adviceDiv = document.getElementById('profit-advice');

    if (!adviceDiv) {
        adviceDiv             = document.createElement('div');
        adviceDiv.id          = 'profit-advice';
        adviceDiv.className   = 'profit-advice';
        document.querySelector('.runes-section').appendChild(adviceDiv);
    }

    if (bestStrategy.maxPotential === 0) {
        adviceDiv.innerHTML = '';
        return;
    }

    const strategyLabel = bestStrategy.type === 'none'
        ? '<strong>ne faire aucun focus</strong>'
        : `Focus les runes <strong>${bestStrategy.name}</strong>`;

    const colorClass = bestStrategy.expected >= totalRecipePrice ? 'success-text' : 'danger-text';
    const pctGain    = totalRecipePrice > 0
        ? Math.round(((bestStrategy.guaranteed - totalRecipePrice) / totalRecipePrice) * 100)
        : null;
    const gainVsCraft = pctGain !== null ? ` <span class="gain-vs-craft">(${pctGain > 0 ? '+' : ''}${pctGain}% vs craft)</span>` : '';

    const resultText = bestStrategy.guaranteed > 0
        ? `<strong class="${colorClass}">${bestStrategy.guaranteed} K 100% garantis</strong>${gainVsCraft}
           <br><span style="font-size:0.9em; color:var(--text-muted);">(Max Potentiel : ${bestStrategy.maxPotential} K)</span>`
        : `<strong class="${colorClass}">${bestStrategy.maxPotential} K au maximum</strong>
           <br><span style="font-size:0.9em; color:var(--text-muted);">(Rien n'est garanti à 100%)</span>`;

    adviceDiv.innerHTML = `Le choix le plus sûr est de ${strategyLabel} :<br>${resultText}`;
}

/* =============================================================================
   HELPERS DE FORMATAGE (privés)
============================================================================= */

/**
 * Formate un nombre de runes en texte avec probabilité si non entier.
 * @param {number} floatVal
 * @returns {string}
 */
function _formatRuneText(floatVal) {
    if (floatVal <= 0) return '0';
    const intVal = Math.floor(floatVal);
    const prob   = Math.round((floatVal - intVal) * 100);
    return prob === 0
        ? `Runes ${intVal}`
        : `Runes ${intVal}<br><span class="prob-detail">et ${prob}% de chance</span>`;
}

/**
 * Formate un gain en kamas avec probabilité si le nombre de runes n'est pas entier.
 * @param {number} floatVal
 * @param {number} price
 * @returns {string}
 */
function _formatKamasText(floatVal, price) {
    if (floatVal <= 0 || price <= 0) return '0 K';
    const intVal   = Math.floor(floatVal);
    const prob     = Math.round((floatVal - intVal) * 100);
    const baseKamas = intVal * price;
    return prob === 0
        ? `${baseKamas} K`
        : `${baseKamas} K<br><span class="prob-detail">et ${prob}% d'avoir ${price} K</span>`;
}
