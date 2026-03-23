/**
 * @file admin.filters.js
 * @description Filtrage, tri et pipeline de mise à jour des tableaux admin.
 *
 * Responsabilités :
 *   - Listeners des champs de recherche et du filtre de catégorie
 *   - Listeners des en-têtes de colonnes triables
 *   - Comparateurs de tri (équipements et ressources)
 *   - Métriques utilitaires (usage, popularité)
 *   - Pipeline complet : filtrer → trier → déclencher le rendu
 *
 * @depends admin.state.js   — AdminState
 * @depends admin.render.js  — renderEquipmentsPage, renderResourcesPage
 */

/* =============================================================================
   INITIALISATION DES LISTENERS
============================================================================= */

/**
 * Attache les listeners des champs de recherche et du filtre de catégorie.
 * Chaque changement remet la pagination à 1 via les setters d'AdminState.
 */
function setupFilters() {
    document.getElementById('search-equip').addEventListener('input', (e) => {
        AdminState.setSearchEquip(e.target.value);
        applyFilterAndSortEquip();
    });

    document.getElementById('filter-category').addEventListener('change', (e) => {
        AdminState.setCatEquip(e.target.value);
        applyFilterAndSortEquip();
    });

    document.getElementById('search-res').addEventListener('input', (e) => {
        AdminState.setSearchRes(e.target.value);
        applyFilterAndSortRes();
    });
}

/**
 * Attache les listeners de tri sur les en-têtes de colonnes triables.
 * Met à jour l'icône de direction et déclenche le re-rendu.
 */
function setupSorting() {
    _setupSortableHeaders('#tab-equipments', AdminState.sortEquip,
        col => AdminState.toggleSortEquip(col),
        () => AdminState.sortEquip,
        applyFilterAndSortEquip
    );

    _setupSortableHeaders('#tab-resources', AdminState.sortRes,
        col => AdminState.toggleSortRes(col),
        () => AdminState.sortRes,
        applyFilterAndSortRes
    );
}

/**
 * Attache les listeners de tri sur les colonnes d'un tableau donné.
 *
 * @param {string}   tableSelector - Sélecteur CSS du tableau parent.
 * @param {object}   _sortRef      - Référence initiale (non utilisée directement, présente pour cohérence).
 * @param {Function} toggleFn      - Fonction de bascule du tri dans AdminState.
 * @param {Function} getSortFn     - Accesseur retournant l'état de tri courant.
 * @param {Function} renderFn      - Fonction de re-rendu à appeler après le tri.
 * @private
 */
function _setupSortableHeaders(tableSelector, _sortRef, toggleFn, getSortFn, renderFn) {
    document.querySelectorAll(`${tableSelector} th.sortable`).forEach(th => {
        th.addEventListener('click', () => {
            const column = th.getAttribute('data-sort');
            toggleFn(column);

            // Réinitialise toutes les icônes du tableau, puis affiche la bonne
            document.querySelectorAll(`${tableSelector} .sort-icon`)
                .forEach(icon => { icon.textContent = ''; });
            th.querySelector('.sort-icon').textContent = getSortFn().asc ? '▲' : '▼';

            renderFn();
        });
    });
}

/* =============================================================================
   PIPELINE : FILTRER → TRIER → RENDRE
============================================================================= */

/**
 * Filtre les équipements selon la recherche et la catégorie actives,
 * les trie, met à jour AdminState et déclenche le rendu de la page courante.
 */
function applyFilterAndSortEquip() {
    const filtered = AdminState.equipments.filter(item => {
        const matchSearch = item.nom.toLowerCase().includes(AdminState.searchEquip);
        const matchCat    = AdminState.catEquip === ''
            || (item.categorie || 'Inconnu') === AdminState.catEquip;
        return matchSearch && matchCat;
    });

    AdminState.setFilteredEquipments(sortEquipList(filtered));
    renderEquipmentsPage();
}

/**
 * Filtre les ressources selon la recherche active,
 * les trie, met à jour AdminState et déclenche le rendu.
 */
function applyFilterAndSortRes() {
    const filtered = AdminState.resources.filter(res =>
        res.nom.toLowerCase().includes(AdminState.searchRes)
    );

    AdminState.setFilteredResources(sortResList(filtered));
    renderResourcesPage();
}

/* =============================================================================
   COMPARATEURS DE TRI
============================================================================= */

/**
 * Retourne une copie triée d'une liste d'équipements selon l'état de tri courant.
 * Sans colonne active, retourne la liste telle quelle.
 *
 * Colonnes supportées :
 *   - `nom`, `categorie` → tri alphabétique (insensible à la casse)
 *   - `ingredients`      → tri par nombre d'ingrédients
 *   - `popularity`       → tri par score de popularité de craft
 *   - autres             → tri numérique (niveau, etc.)
 *
 * @param {object[]} list
 * @returns {object[]}
 */
function sortEquipList(list) {
    const { column, asc } = AdminState.sortEquip;
    if (!column) return list;

    return [...list].sort((a, b) => {
        const [valA, valB] = _getEquipSortValues(a, b, column);
        return _compareValues(valA, valB, asc);
    });
}

/**
 * Retourne une copie triée d'une liste de ressources selon l'état de tri courant.
 *
 * Colonnes supportées :
 *   - `nom`   → tri alphabétique
 *   - `usage` → tri par nombre de recettes qui utilisent la ressource
 *
 * @param {object[]} list
 * @returns {object[]}
 */
function sortResList(list) {
    const { column, asc } = AdminState.sortRes;
    if (!column) return list;

    return [...list].sort((a, b) => {
        const [valA, valB] = _getResSortValues(a, b, column);
        return _compareValues(valA, valB, asc);
    });
}

/**
 * Extrait les valeurs de comparaison pour deux équipements selon la colonne.
 * @private
 */
function _getEquipSortValues(a, b, column) {
    switch (column) {
        case 'ingredients':
            return [a.ingredients?.length ?? 0, b.ingredients?.length ?? 0];
        case 'popularity':
            return [getCraftPopularityScore(a), getCraftPopularityScore(b)];
        case 'nom':
        case 'categorie':
            return [(a[column] || '').toLowerCase(), (b[column] || '').toLowerCase()];
        default:
            return [a[column] ?? 0, b[column] ?? 0];
    }
}

/**
 * Extrait les valeurs de comparaison pour deux ressources selon la colonne.
 * Le cas `taux_drop` place les ressources sans taux (null) en fin de liste,
 * quel que soit le sens du tri.
 * @private
 */
function _getResSortValues(a, b, column) {
    switch (column) {
        case 'usage':
            return [getResourceUsageCount(a.id_res), getResourceUsageCount(b.id_res)];
        case 'nom':
            return [(a.nom || '').toLowerCase(), (b.nom || '').toLowerCase()];
        case 'taux_drop': {
            // null → toujours en dernier (représenté par Infinity côté ascendant)
            const valA = a.taux_drop != null ? parseFloat(a.taux_drop) : Infinity;
            const valB = b.taux_drop != null ? parseFloat(b.taux_drop) : Infinity;
            return [valA, valB];
        }
        default:
            return [a[column] ?? 0, b[column] ?? 0];
    }
}

/**
 * Compare deux valeurs scalaires avec gestion de la direction.
 * @private
 */
function _compareValues(valA, valB, asc) {
    if (valA < valB) return asc ? -1 : 1;
    if (valA > valB) return asc ? 1 : -1;
    return 0;
}

/* =============================================================================
   MÉTRIQUES UTILITAIRES
============================================================================= */

/**
 * Compte le nombre d'équipements craftables qui utilisent une ressource donnée.
 *
 * @param {number} resId - ID de la ressource.
 * @returns {number}
 */
function getResourceUsageCount(resId) {
    return AdminState.equipments.filter(eq =>
        eq.ingredients?.some(ing => ing.id_res === resId)
    ).length;
}

/**
 * Calcule le score de popularité de craft d'un équipement.
 * Score = somme du nombre de crafts utilisant chaque ingrédient direct.
 * Permet d'identifier les items dont les ressources sont très demandées.
 *
 * @param {object} item - Équipement avec ses ingrédients.
 * @returns {number}
 */
function getCraftPopularityScore(item) {
    if (!item.ingredients?.length) return 0;
    return item.ingredients.reduce((sum, ing) =>
        sum + getResourceUsageCount(ing.id_res), 0
    );
}
