/**
 * @file admin.render.js
 * @description Rendu des tableaux paginés d'équipements et de ressources.
 *
 * Responsabilités :
 *   - Rendu des lignes de tableau (équipements / ressources)
 *   - Mise à jour des contrôles de pagination (info page, boutons prev/next)
 *   - Attachement des listeners inline (checkbox, prix, focus/blur)
 *   - Gestion du sélecteur "tout cocher"
 *
 * @depends admin.state.js    — AdminState
 * @depends admin.filters.js  — getResourceUsageCount, getCraftPopularityScore
 * @depends admin.massActions.js — updateMassDeleteUI, checkAllEquipToggleState, checkAllResToggleState
 * @depends storage.js        — getAllPriceLots, setStoredPriceLot, priceKeyRes
 * @depends constants.js      — (indirectement via EFFECT_MAPPING dans les modales)
 */

/* =============================================================================
   CONFIGURATION
============================================================================= */

/**
 * Définition des 4 paliers de prix ressource.
 * Centralise les libellés et les clés pour éviter la duplication.
 *
 * @type {Array<{lot: string, label: string}>}
 */
const RES_PRICE_LOTS = [
    { lot: 'x1',    label: '×1'    },
    { lot: 'x10',   label: '×10'   },
    { lot: 'x100',  label: '×100'  },
    { lot: 'x1000', label: '×1000' },
];

/* =============================================================================
   PAGINATION — INITIALISATION DES LISTENERS
============================================================================= */

/**
 * Attache les listeners des sélecteurs de taille de page
 * et des boutons Précédent / Suivant.
 */
function setupPagination() {
    document.getElementById('page-size-equip').addEventListener('change', (e) => {
        AdminState.setEquipPageSize(parseInt(e.target.value, 10));
        AdminState.resetEquipPage();
        renderEquipmentsPage();
    });

    document.getElementById('page-size-res').addEventListener('change', (e) => {
        AdminState.setResPageSize(parseInt(e.target.value, 10));
        AdminState.resetResPage();
        renderResourcesPage();
    });

    document.getElementById('btn-prev-equip').addEventListener('click', () => {
        if (AdminState.equipPage > 1) {
            AdminState.setEquipPage(AdminState.equipPage - 1);
            renderEquipmentsPage();
        }
    });

    document.getElementById('btn-next-equip').addEventListener('click', () => {
        const maxPage = Math.ceil(AdminState.filteredEquipments.length / AdminState.equipPageSize);
        if (AdminState.equipPage < maxPage) {
            AdminState.setEquipPage(AdminState.equipPage + 1);
            renderEquipmentsPage();
        }
    });

    document.getElementById('btn-prev-res').addEventListener('click', () => {
        if (AdminState.resPage > 1) {
            AdminState.setResPage(AdminState.resPage - 1);
            renderResourcesPage();
            document.getElementById('tab-resources').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });

    document.getElementById('btn-next-res').addEventListener('click', () => {
        const maxPage = Math.ceil(AdminState.filteredResources.length / AdminState.resPageSize);
        if (AdminState.resPage < maxPage) {
            AdminState.setResPage(AdminState.resPage + 1);
            renderResourcesPage();
            document.getElementById('tab-resources').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
}

/* =============================================================================
   RENDU — TABLEAU ÉQUIPEMENTS
============================================================================= */

/**
 * Rend la page courante du tableau équipements.
 * Met à jour les contrôles de pagination et l'état de la checkbox "tout cocher".
 */
function renderEquipmentsPage() {
    const tbody      = document.getElementById('tbody-equipments');
    const total      = AdminState.filteredEquipments.length;
    const totalPages = Math.max(1, Math.ceil(total / AdminState.equipPageSize));

    // Borne la page courante
    if (AdminState.equipPage > totalPages) AdminState.setEquipPage(totalPages);

    const start     = (AdminState.equipPage - 1) * AdminState.equipPageSize;
    const paginated = AdminState.filteredEquipments.slice(start, start + AdminState.equipPageSize);

    _updatePaginationControls('equip', AdminState.equipPage, totalPages, total);

    tbody.innerHTML = '';
    let allChecked = paginated.length > 0;

    paginated.forEach(item => {
        if (!AdminState.selectedEquips.has(item.id_itm)) allChecked = false;
        const row = _buildEquipRow(item);
        tbody.appendChild(row);
    });

    document.getElementById('check-all-equip').checked = allChecked;
    updateMassDeleteUI();
}

/**
 * Construit l'élément `<tr>` d'une ligne d'équipement avec ses listeners.
 *
 * @param {object} item - Équipement à afficher.
 * @returns {HTMLTableRowElement}
 * @private
 */
function _buildEquipRow(item) {
    const isSelected      = AdminState.selectedEquips.has(item.id_itm);
    const typeName        = item.categorie || 'Inconnu';
    const recipeCount     = item.ingredients?.length ?? 0;
    const popularityScore = getCraftPopularityScore(item);
    const price           = parseInt(localStorage.getItem('equip_' + item.id_itm), 10) || 0;
    const safeName        = _escapeName(item.nom);

    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="checkbox" class="chk-equip" value="${item.id_itm}" ${isSelected ? 'checked' : ''}></td>
        <td><img src="${item.icone || ''}" alt="icon" onerror="this.src=''"></td>
        <td><strong class="copyable-name"
                    onclick="copyToClipboard('${safeName}', this)"
                    title="Cliquer pour copier">${item.nom}</strong></td>
        <td>${item.niveau}</td>
        <td>${typeName}</td>
        <td>${recipeCount} ingrédient(s)</td>
        <td title="Score = somme du nombre de crafts utilisant chaque ingrédient">
            <span class="popularity-score">${popularityScore}</span>
        </td>
        <td>
            <input type="number" class="equip-price-input admin-price-input"
                   data-id="${item.id_itm}" value="${price}" min="0">
        </td>
        <td class="action-buttons">
            <button class="btn btn-primary btn-sm" onclick="editEquipment(${item.id_itm})">Éditer</button>
            <button class="btn btn-danger btn-sm"  onclick="deleteEquipment(${item.id_itm})">Suppr.</button>
        </td>`;

    _attachEquipRowListeners(tr, item.id_itm);
    return tr;
}

/**
 * Attache les listeners de checkbox et de prix sur une ligne équipement.
 * @private
 */
function _attachEquipRowListeners(tr, itemId) {
    tr.querySelector('.chk-equip').addEventListener('change', (e) => {
        e.target.checked ? AdminState.selectEquip(itemId) : AdminState.deselectEquip(itemId);
        updateMassDeleteUI();
        checkAllEquipToggleState();
    });

    _attachPriceInputListeners(tr.querySelector('.equip-price-input'),
        (val) => localStorage.setItem('equip_' + itemId, val)
    );
}

/* =============================================================================
   RENDU — TABLEAU RESSOURCES
============================================================================= */

/**
 * Rend la page courante du tableau ressources.
 */
function renderResourcesPage() {
    const tbody      = document.getElementById('tbody-resources');
    const total      = AdminState.filteredResources.length;
    const totalPages = Math.max(1, Math.ceil(total / AdminState.resPageSize));

    if (AdminState.resPage > totalPages) AdminState.setResPage(totalPages);

    const start     = (AdminState.resPage - 1) * AdminState.resPageSize;
    const paginated = AdminState.filteredResources.slice(start, start + AdminState.resPageSize);

    _updatePaginationControls('res', AdminState.resPage, totalPages, total);

    tbody.innerHTML = '';
    let allChecked = paginated.length > 0;

    paginated.forEach(res => {
        if (!AdminState.selectedRes.has(res.id_res)) allChecked = false;
        const row = _buildResRow(res);
        tbody.appendChild(row);
    });

    document.getElementById('check-all-res').checked = allChecked;
    updateMassDeleteUI();
}

/**
 * Construit l'élément `<tr>` d'une ligne de ressource avec ses listeners.
 * Affiche 4 colonnes de prix (×1, ×10, ×100, ×1000) issues du localStorage.
 *
 * @param {object} res - Ressource à afficher.
 * @returns {HTMLTableRowElement}
 * @private
 */
function _buildResRow(res) {
    const isSelected = AdminState.selectedRes.has(res.id_res);
    const usageCount = getResourceUsageCount(res.id_res);
    const safeName   = _escapeName(res.nom);
    const niveauRes  = parseInt(localStorage.getItem('niveau_' + res.id_res), 10)
        || res.niveau || '—';

    // Taux de drop : priorité localStorage → JSON → vide
    const storedDrop = localStorage.getItem('drop_' + res.id_res);
    const dropValue  = storedDrop !== null ? storedDrop
                     : res.taux_drop != null ? res.taux_drop
                     : '';

    // 4 paliers de prix depuis le localStorage
    const lots = getAllPriceLots(res.id_res);

    // Persiste le niveau en localStorage s'il vient du JSON et n'y est pas encore
    const storedNiveau = parseInt(localStorage.getItem('niveau_' + res.id_res), 10);
    if (!Number.isFinite(storedNiveau) && Number.isFinite(res.niveau) && res.niveau > 0) {
        localStorage.setItem('niveau_' + res.id_res, res.niveau);
    }

    // Génère les 4 cellules de prix
    const priceCells = RES_PRICE_LOTS.map(({ lot, label }) => {
        const val = lots[lot];
        return `
        <td>
            <div class="res-price-lot-cell">
                <span class="res-price-lot-label">${label}</span>
                <input type="number"
                       class="res-price-input admin-price-input res-price-lot-input"
                       data-id="${res.id_res}"
                       data-lot="${lot}"
                       value="${val !== null ? val : ''}"
                       min="0"
                       placeholder="—">
            </div>
        </td>`;
    }).join('');

    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="checkbox" class="chk-res" value="${res.id_res}" ${isSelected ? 'checked' : ''}></td>
        <td><img src="${res.icone || ''}" alt="icon" onerror="this.src=''"></td>
        <td><span class="copyable-name"
                  onclick="copyToClipboard('${res.id_res}', this)"
                  title="Cliquer pour copier">${res.id_res}</span></td>
        <td><strong class="copyable-name"
                    onclick="copyToClipboard('${safeName}', this)"
                    title="Cliquer pour copier">${res.nom}</strong></td>
        <td>
            <input type="number" class="res-level-input admin-price-input"
                   data-id="${res.id_res}" value="${Number.isFinite(niveauRes) ? niveauRes : ''}"
                   min="0" placeholder="—">
        </td>
        <td>${usageCount} recette(s)</td>
        <td>
            <input type="text" class="res-drop-input admin-price-input"
                   data-id="${res.id_res}" value="${dropValue}"
                   placeholder="—">
        </td>
        ${priceCells}
        <td class="action-buttons">
            <button class="btn btn-primary btn-sm" onclick="editResource(${res.id_res})">Éditer</button>
            <button class="btn btn-danger btn-sm"  onclick="deleteResource(${res.id_res})">Suppr.</button>
        </td>`;

    _attachResRowListeners(tr, res.id_res);
    return tr;
}

/**
 * Attache les listeners de checkbox, taux de drop et prix (4 paliers)
 * sur une ligne ressource.
 * @private
 */
function _attachResRowListeners(tr, resId) {
    // ── Checkbox de sélection ──────────────────────────────────────────────
    tr.querySelector('.chk-res').addEventListener('change', (e) => {
        e.target.checked ? AdminState.selectRes(resId) : AdminState.deselectRes(resId);
        updateMassDeleteUI();
        checkAllResToggleState();
    });

    // ── Niveau ─────────────────────────────────────────────────────────────
    const levelInput = tr.querySelector('.res-level-input');
    _attachPriceInputListeners(levelInput, (val) => {
        if (val === '') {
            localStorage.removeItem('niveau_' + resId);
        } else {
            localStorage.setItem('niveau_' + resId, val);
        }
    });

    // ── Taux de drop ───────────────────────────────────────────────────────
    const dropInput = tr.querySelector('.res-drop-input');
    dropInput.addEventListener('input', (e) => {
        const normalized = _normalizeDrop(e.target.value);
        localStorage.setItem('drop_' + resId, normalized);
    });
    dropInput.addEventListener('blur', (e) => {
        const normalized = _normalizeDrop(e.target.value);
        e.target.value   = normalized;
        if (normalized === '') {
            localStorage.removeItem('drop_' + resId);
        } else {
            localStorage.setItem('drop_' + resId, normalized);
        }
    });

    // ── 4 paliers de prix ──────────────────────────────────────────────────
    tr.querySelectorAll('.res-price-lot-input').forEach(input => {
        const lot = input.dataset.lot;

        _attachPriceInputListeners(input, (val) => {
            // Persiste le palier concerné
            setStoredPriceLot(resId, lot, val === '' ? null : parseInt(val, 10));

            // Rétrocompatibilité : maintient res_{id} synchronisé avec ×1
            if (lot === 'x1') {
                if (val !== '') {
                    localStorage.setItem(priceKeyRes(resId), val);
                    localStorage.setItem(priceKeyRes(resId) + '_ts', Date.now());
                } else {
                    localStorage.removeItem(priceKeyRes(resId));
                    localStorage.removeItem(priceKeyRes(resId) + '_ts');
                }
            }
        });
    });
}

/* =============================================================================
   HELPERS PARTAGÉS
============================================================================= */

/**
 * Met à jour les contrôles de pagination d'une section (info texte + boutons).
 *
 * @param {"equip"|"res"} section
 * @param {number} currentPage
 * @param {number} totalPages
 * @param {number} totalItems
 * @private
 */
function _updatePaginationControls(section, currentPage, totalPages, totalItems) {
    document.getElementById(`page-info-${section}`).textContent =
        `Page ${currentPage} sur ${totalPages} (${totalItems} résultats)`;
    document.getElementById(`btn-prev-${section}`).disabled = (currentPage === 1);
    document.getElementById(`btn-next-${section}`).disabled = (currentPage === totalPages);
}

/**
 * Attache les listeners input / focus / blur sur un champ de prix.
 * Factorisé pour éviter la duplication entre équipements et ressources.
 *
 * @param {HTMLInputElement} input
 * @param {(value: string) => void} onInput - Callback de persistance appelé à chaque frappe.
 * @private
 */
function _attachPriceInputListeners(input, onInput) {
    if (!input) return;
    input.addEventListener('input', (e) => {
        // Normalise la virgule décimale en point pour les champs qui l'acceptent
        if (e.target.value.includes(',')) {
            const pos      = e.target.selectionStart;
            e.target.value = e.target.value.replace(',', '.');
            e.target.setSelectionRange(pos, pos);
        }
        onInput(e.target.value);
    });
    input.addEventListener('focus', (e) => { e.target.style.borderColor = 'var(--primary)'; });
    input.addEventListener('blur',  (e) => { e.target.style.borderColor = 'var(--border-color)'; });
}

/**
 * Normalise une valeur saisie dans le champ "Taux de drop".
 * Valeurs acceptées :
 *   - "CRAFT"   (toute casse, avec ou sans accents) → "CRAFT"
 *   - "ÉCHANGE" (toute casse, variantes sans accent) → "ÉCHANGE"
 *   - Nombre avec virgule ou point                  → "X.XX" (chaîne numérique)
 *   - Vide ou invalide                              → ""
 *
 * @param {string} val - Valeur brute saisie par l'utilisateur.
 * @returns {string}
 * @private
 */
function _normalizeDrop(val) {
    const stripped = val.trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // supprime les diacritiques
        .toUpperCase();

    if (stripped === 'CRAFT')   return 'CRAFT';
    if (stripped === 'ECHANGE') return 'ÉCHANGE';
    if (stripped === 'METIER')  return 'MÉTIER';
    if (stripped === 'SACHET')  return 'SACHET';
    if (stripped === 'QUETE')   return 'QUÊTE';

    // Tente une conversion numérique
    const numeric = val.trim().replace(',', '.');
    const parsed  = parseFloat(numeric);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
        return String(parsed);
    }

    return '';
}

/**
 * Échappe un nom pour injection sécurisée dans un attribut `onclick` HTML.
 * Prévient les injections via guillemets simples ou doubles dans les noms.
 *
 * @param {string} name
 * @returns {string}
 * @private
 */
function _escapeName(name) {
    return name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
