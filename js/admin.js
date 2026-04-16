/**
 * @file admin.js
 * @description Point d'entrée du backoffice admin Dofus Runes.
 *
 * Responsabilité UNIQUE : charger les données, initialiser les modules,
 * et lancer l'affichage initial. Aucune logique métier ici.
 *
 * Dépendances (chargées avant ce fichier via admin.html) :
 *   1. constants.js          — EFFECT_MAPPING
 *   2. admin.state.js        — AdminState
 *   3. admin.filters.js      — applyFilterAndSort*, sortEquipList, sortResList
 *   4. admin.render.js       — renderEquipmentsPage, renderResourcesPage, setupPagination
 *   5. admin.massActions.js  — setupMassActions, updateMassDeleteUI
 *   6. admin.modals.js       — setupModals, setupButtons, CRUD, éditeurs
 *   7. navigation.js         — AdminNav
 */

/* =============================================================================
   UTILITAIRES GLOBAUX
   Partagés avec admin.html via onclick="" — doivent rester sur window.
============================================================================= */

/**
 * Copie un texte dans le presse-papier et affiche un feedback visuel temporaire.
 * Déclaré ici (et non dans imageCache.js) car admin.html ne charge pas imageCache.js.
 *
 * @param {string}      text    - Texte à copier.
 * @param {HTMLElement} element - Élément déclencheur (feedback visuel).
 */
window.copyToClipboard = function (text, element) {
    if (!navigator.clipboard) {
        alert("La copie n'est pas supportée par votre navigateur.");
        return;
    }
    navigator.clipboard.writeText(text).then(() => {
        const originalHTML = element.innerHTML;
        element.innerHTML  = '✅ Copié !';
        element.classList.add('copied-feedback');
        setTimeout(() => {
            element.innerHTML = originalHTML;
            element.classList.remove('copied-feedback');
        }, 1200);
    }).catch(err => console.error('[admin] Erreur lors de la copie :', err));
};

/* =============================================================================
   CATALOGUE ET DATALIST
============================================================================= */

/**
 * Peuple le sélecteur de filtre de catégories à partir des données courantes.
 * Conserve la valeur sélectionnée si elle existe toujours après mise à jour.
 */
function populateCategoryFilter() {
    const select     = document.getElementById('filter-category');
    const currentVal = select.value;
    const categories = [...new Set(AdminState.equipments.map(e => e.categorie || 'Inconnu'))]
        .filter(Boolean)
        .sort();

    select.innerHTML = '<option value="">Toutes les catégories</option>';
    categories.forEach(cat => {
        const opt       = document.createElement('option');
        opt.value       = cat;
        opt.textContent = cat;
        select.appendChild(opt);
    });

    // Restaure la sélection si la catégorie existe toujours
    if (categories.includes(currentVal)) select.value = currentVal;
}

/**
 * Peuple la datalist de ressources utilisée pour l'autocomplete
 * dans l'éditeur de recette.
 */
function populateResourcesDatalist() {
    const datalist  = document.getElementById('resources-datalist');
    datalist.innerHTML = '';
    AdminState.resources.forEach(res => {
        const option  = document.createElement('option');
        option.value  = res.nom;
        datalist.appendChild(option);
    });
}

/* =============================================================================
   CHARGEMENT DES DONNÉES
============================================================================= */

/**
 * Table inverse de runeName.json : abbreviation → nom complet.
 * Utilisée pour résoudre les clés de stockage des prix de runes
 * lors de l'import JSON.
 * @type {Object.<string, string>}
 */
let adminRuneAbbrToNom = {};

/**
 * Charge le fichier JSON de données principal et runeName.json.
 * @returns {Promise<void>}
 */
async function _loadAdminData() {
    const [dofusRes, runeNameRes] = await Promise.all([
        fetch('../json/recettes_dofus.json'),
        fetch('../json/runeName.json'),
    ]);

    if (!dofusRes.ok)    throw new Error(`recettes_dofus.json — HTTP ${dofusRes.status}`);
    if (!runeNameRes.ok) throw new Error(`runeName.json — HTTP ${runeNameRes.status}`);

    const fullData = await dofusRes.json();
    AdminState.setData({
        fullData,
        equipments: fullData.equipements ?? [],
        resources:  fullData.ressources  ?? [],
        effects:    fullData.effets       ?? [],
    });

    // Construit la table inverse abbr → nom (ex: "Vi" → "Vitalité")
    const runeNames = await runeNameRes.json();
    adminRuneAbbrToNom = Object.fromEntries(
        Object.entries(runeNames).map(([nom, abbr]) => [abbr, nom])
    );
}

/* =============================================================================
   INITIALISATION DES MODULES
============================================================================= */

/**
 * Initialise tous les modules dans l'ordre correct.
 *
 * Ordre :
 *   1. Navigation      — AdminNav.init() remplace setupTabs()
 *   2. Filtres         — listeners recherche + catégorie + tri
 *   3. Pagination      — listeners prev/next + taille de page
 *   4. Actions masse   — listeners checkboxes + suppression groupée
 *   5. Modales         — listeners fermeture + CRUD complet
 *   6. Boutons export  — listener téléchargement JSON
 */
function _initAdminModules() {
    AdminNav.init();
    setupFilters();
    setupPagination();
    setupSorting();
    setupMassActions();
    setupModals();
    setupButtons();
}

/* =============================================================================
   POINT D'ENTRÉE
============================================================================= */

/**
 * Séquence de démarrage :
 *   1. Chargement du JSON
 *   2. Peuplement des filtres et datalists
 *   3. Initialisation des modules
 *   4. Affichage initial des deux tableaux
 */
window.onload = async () => {
    try {
        await _loadAdminData();

        populateCategoryFilter();
        populateResourcesDatalist();

        _initAdminModules();

        applyFilterAndSortEquip();
        applyFilterAndSortRes();
    } catch (err) {
        console.error('[admin] Échec du démarrage :', err);
        alert(`Impossible de charger le fichier JSON.\n\nDétail : ${err.message}`);
    }
};
