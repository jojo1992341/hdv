/**
 * @file dependencyGraph.js
 * @description Onglet 5 — Arbre de dépendances inversé des ressources.
 *
 * Construit un index inversé : pour chaque ressource ou item intermédiaire,
 * liste tous les équipements finaux qui l'utilisent (directement ou via
 * sous-recettes), ainsi que le chemin de craft correspondant.
 *
 * Responsabilités :
 *   - Construction de l'index inversé au démarrage
 *   - Affichage filtrable de la liste des ressources indexées
 *   - Affichage du détail (par catégorie) pour une ressource sélectionnée
 *
 * @depends imageCache.js — getIcon
 */

/* =============================================================================
   CONFIGURATION
============================================================================= */

/**
 * Nombre maximum de ressources affichées dans la liste latérale.
 * Au-delà, les résultats sont tronqués (triés par nombre d'utilisations).
 * @type {number}
 */
const MAX_DEP_LIST_SIZE = 80;

/* =============================================================================
   INDEX INVERSÉ (PRIVÉ)
   Structure : { [itemId: number]: Array<{ item: object, path: string[] }> }
     - item : équipement final qui utilise cette ressource
     - path : chemin de craft depuis l'équipement jusqu'à la ressource
               ex: ["Chapeau du Bouftou", "Laine de Bouftou"]
============================================================================= */

/** @type {Object.<number, Array<{item: object, path: string[]}>>} */
let _depReverseIndex = {};

/* =============================================================================
   CONSTRUCTION DE L'INDEX
============================================================================= */

/**
 * Construit (ou reconstruit) l'index inversé de toutes les dépendances
 * de craft à partir de dbEquipments.
 *
 * Pour chaque équipement craftable, parcourt récursivement tous ses
 * ingrédients (directs et imbriqués) et les enregistre dans l'index.
 *
 * Complexité : O(E × D) où E = nombre d'équipements, D = profondeur max des recettes.
 */
function buildDependencyIndex() {
    _depReverseIndex = {};

    dbEquipments.forEach(topItem => {
        if (!topItem.ingredients?.length) return;

        topItem.ingredients.forEach(ing =>
            _walkDependencies(ing.id_res, topItem, [topItem.nom])
        );
    });
}

/**
 * Parcourt récursivement les dépendances d'un item depuis une ressource donnée
 * et enregistre chaque utilisation dans l'index inversé.
 *
 * La déduplication garantit qu'un même équipement n'est enregistré qu'une
 * seule fois par ressource, même si celle-ci apparaît dans plusieurs branches.
 *
 * @param {number}   itemId  - ID de la ressource ou de l'item intermédiaire courant.
 * @param {object}   topItem - Équipement final racine de la dépendance.
 * @param {string[]} path    - Chemin de craft jusqu'à ce nœud (noms des intermédiaires).
 * @private
 */
function _walkDependencies(itemId, topItem, path) {
    if (!_depReverseIndex[itemId]) {
        _depReverseIndex[itemId] = [];
    }

    // Déduplication : n'enregistrer chaque équipement final qu'une seule fois par ressource
    const alreadyIndexed = _depReverseIndex[itemId].some(e => e.item.id_itm === topItem.id_itm);
    if (!alreadyIndexed) {
        _depReverseIndex[itemId].push({ item: topItem, path: [...path] });
    }

    // Descente récursive dans les sous-recettes de cet item intermédiaire
    const sub = dbEquipments.find(e => e.id_itm === itemId);
    sub?.ingredients?.forEach(ing =>
        _walkDependencies(ing.id_res, topItem, [...path, sub.nom])
    );
}

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Initialise l'onglet Arbre de Dépendances.
 * Construit l'index et affiche la liste complète au démarrage.
 * Doit être appelée une fois au chargement de la page.
 */
function setupDependencyGraph() {
    buildDependencyIndex();
    renderDepResourceList('');

    const searchInput = document.getElementById('dep-search');
    searchInput.addEventListener('input', (e) =>
        renderDepResourceList(e.target.value.toLowerCase().trim())
    );
}

/* =============================================================================
   LISTE DES RESSOURCES (PANNEAU GAUCHE)
============================================================================= */

/**
 * Affiche la liste des ressources indexées, filtrées par la requête donnée.
 * Triées par nombre décroissant d'utilisations dans des crafts.
 *
 * @param {string} query - Filtre de recherche (chaîne en minuscules, déjà trimmée).
 */
function renderDepResourceList(query) {
    const list    = document.getElementById('dep-resource-list');
    const entries = _buildResourceListEntries(query);

    list.innerHTML = entries
        .slice(0, MAX_DEP_LIST_SIZE)
        .map(_renderResourceListItem)
        .join('');

    _attachResourceListListeners(list);
}

/**
 * Construit la liste des entrées de ressources filtrées et triées.
 *
 * @param {string} query
 * @returns {Array<{id: number, name: string, icon: string, count: number}>}
 * @private
 */
function _buildResourceListEntries(query) {
    return Object.keys(_depReverseIndex)
        .map(Number)
        .map(id => {
            const resolved = _resolveItem(id);
            if (!resolved) return null;
            return {
                id,
                name:  resolved.nom,
                icon:  resolved.icone,
                count: _depReverseIndex[id].length,
            };
        })
        .filter(entry => entry && (!query || entry.name.toLowerCase().includes(query)))
        .sort((a, b) => b.count - a.count);
}

/**
 * Génère le HTML d'un élément de la liste de ressources.
 *
 * @param {{ id: number, name: string, icon: string, count: number }} entry
 * @returns {string}
 * @private
 */
function _renderResourceListItem({ id, name, icon, count }) {
    return `
        <div class="dep-res-item" data-id="${id}">
            <img src="${getIcon(icon)}" class="dep-res-icon" alt="">
            <span class="dep-res-name">${name}</span>
            <span class="dep-res-count">${count}</span>
        </div>`;
}

/**
 * Attache les listeners de sélection sur les éléments de la liste.
 * Au clic : marque l'élément actif et affiche son détail.
 *
 * @param {HTMLElement} list - Conteneur de la liste de ressources.
 * @private
 */
function _attachResourceListListeners(list) {
    list.querySelectorAll('.dep-res-item').forEach(el => {
        el.addEventListener('click', () => {
            list.querySelectorAll('.dep-res-item').forEach(x => x.classList.remove('active'));
            el.classList.add('active');
            renderDepDetail(parseInt(el.dataset.id, 10));
        });
    });
}

/* =============================================================================
   DÉTAIL D'UNE RESSOURCE (PANNEAU DROIT)
============================================================================= */

/**
 * Affiche le détail d'une ressource sélectionnée :
 * en-tête (icône, nom, nombre d'utilisations) et liste des crafts par catégorie.
 *
 * @param {number} resId - ID de la ressource ou de l'item intermédiaire.
 */
function renderDepDetail(resId) {
    const detail = document.getElementById('dep-detail');
    const item   = _resolveItem(resId);
    const usages = _depReverseIndex[resId] ?? [];

    if (!item || usages.length === 0) {
        detail.innerHTML = '<div class="dep-empty">Aucune utilisation trouvée.</div>';
        return;
    }

    const byCategory   = _groupByCategory(usages, u => u.item.categorie || 'Autre');
    const catBlocksHtml = _renderCategoryBlocks(byCategory);

    detail.innerHTML = `
        <div class="dep-detail-header">
            <img src="${getIcon(item.icone)}" class="dep-detail-icon" alt="">
            <div>
                <div class="dep-detail-name">${item.nom}</div>
                <div class="dep-detail-meta">
                    Utilisée dans <strong>${usages.length}</strong>
                    craft${usages.length > 1 ? 's' : ''}
                </div>
            </div>
        </div>
        <div class="dep-categories">${catBlocksHtml}</div>`;
}

/**
 * Génère le HTML des blocs de catégories pour le panneau de détail.
 * Les catégories sont triées par nombre décroissant d'utilisations.
 *
 * @param {Object.<string, Array>} byCategory - Usages groupés par catégorie.
 * @returns {string}
 * @private
 */
function _renderCategoryBlocks(byCategory) {
    return Object.entries(byCategory)
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([cat, usages]) => `
            <div class="dep-category-block">
                <div class="dep-category-title">
                    ${cat}
                    <span class="dep-category-count">${usages.length}</span>
                </div>
                ${usages.map(_renderUsageItem).join('')}
            </div>`)
        .join('');
}

/**
 * Génère le HTML d'une ligne d'utilisation dans le panneau de détail.
 *
 * @param {{ item: object, path: string[] }} usage
 * @returns {string}
 * @private
 */
function _renderUsageItem({ item, path }) {
    return `
        <div class="dep-usage-item">
            <img src="${getIcon(item.icone)}" class="dep-usage-icon" alt="">
            <div class="dep-usage-info">
                <span class="dep-usage-name">${item.nom}</span>
                <span class="dep-usage-path">${path.join(' → ')}</span>
            </div>
            <span class="dep-usage-level">Nv ${item.niveau}</span>
        </div>`;
}

/* =============================================================================
   UTILITAIRES
============================================================================= */

/**
 * Résout un ID en ressource ou équipement (premier trouvé).
 * Cherche d'abord dans dbResources, puis dans dbEquipments.
 *
 * @param {number} id - ID à résoudre.
 * @returns {object|null} Ressource ou équipement, ou null si introuvable.
 */
function _resolveItem(id) {
    return dbResources.find(r => r.id_res === id)
        ?? dbEquipments.find(e => e.id_itm === id)
        ?? null;
}

/**
 * Groupe un tableau d'éléments par catégorie via une fonction de clé.
 * Utilitaire générique réutilisable dans d'autres modules.
 *
 * @template T
 * @param {T[]}            items  - Éléments à grouper.
 * @param {(item: T) => string} keyFn - Fonction retournant la clé de groupe.
 * @returns {Object.<string, T[]>}
 */
function _groupByCategory(items, keyFn) {
    return items.reduce((groups, item) => {
        const key = keyFn(item);
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
        return groups;
    }, {});
}
