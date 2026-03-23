/**
 * @file app.js
 * @description Point d'entrée principal de l'application Dofus Runes.
 *
 * Responsabilité UNIQUE : charger les données, initialiser les modules,
 * et démarrer l'application. Aucune logique métier ici.
 *
 * Dépendances (chargées avant ce fichier via index.html) :
 *   1. constants.js         — EFFECT_MAPPING
 *   2. storage.js           — getStoredPrice, setStoredPrice, priceKeyRes…
 *   3. imageCache.js        — preloadAllImages, hideLoadingScreen, getIcon
 *   4. navigation.js        — AppNav
 *   5. calculator.js        — setupSearch, setupGlobalListeners
 *   6. dealsScanner.js      — setupDealsScanner, populateDealsCategoryFilter
 *   7. dashboard.js         — setupDashboard
 *   8. objectifCraft.js     — setupObjectifCraft
 *   9. dependencyGraph.js   — setupDependencyGraph
 *  10. brisageComparator.js — setupBrisageComparator
 *  11. historique.js        — setupHistorique
 *  12. trading.js           — setupTrading
 *  13. farming.js           — setupFarming
 */

/* =============================================================================
   UTILITAIRES GLOBAUX
   Exposés sur window pour être accessibles depuis les modules (trading.js, etc.)
   et depuis les attributs onclick="" inline.
============================================================================= */

/**
 * Copie un texte dans le presse-papier et affiche un feedback visuel temporaire.
 * Identique à la version de admin.js — déclarée ici pour l'application principale
 * qui ne charge pas admin.js.
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
    }).catch(err => console.error('[app] Erreur lors de la copie :', err));
};

/* =============================================================================
   DONNÉES GLOBALES
   Exposées au scope global car tous les modules y accèdent en lecture.
   En lecture seule après l'initialisation — ne pas muter depuis les modules.
============================================================================= */

/** @type {object[]} Équipements craftables avec recettes et statistiques. */
let dbEquipments = new Array();

/** @type {object[]} Ressources de base (ingrédients non craftables). */
let dbResources = new Array();

/** @type {object[]} Monstres avec drops et zones d'apparition. */
let dbMonstres = new Array();

/** @type {object[]} Poids des runes pour le calcul de brisage. */
let dbRunesWeights = new Array();

/** @type {Object.<string, string>} Mapping nom interne → nom affiché des runes. */
let dbRuneNames = {};

/** @type {object[]} Liste des donjons du jeu pour filtrer les zones. */
let dbDungeons = new Array();

/* =============================================================================
   CHARGEMENT DES DONNÉES
============================================================================= */

/**
 * Charge en parallèle les fichiers JSON de données.
 * Lève une erreur si l'un des fichiers est inaccessible ou malformé.
 *
 * @returns {Promise<void>}
 */
async function _loadData() {
    const[dofusRes, rwRes, rnRes, djRes] = await Promise.all([
        fetch('json/recettes_dofus.json'),
        fetch('json/runes_weights.json'),
        fetch('json/runeName.json'),
        fetch('json/cache/dungeons.json')
    ]);

    if (!dofusRes.ok) throw new Error(`recettes_dofus.json — HTTP ${dofusRes.status}`);
    if (!rwRes.ok)    throw new Error(`runes_weights.json — HTTP ${rwRes.status}`);
    if (!rnRes.ok)    throw new Error(`runeName.json — HTTP ${rnRes.status}`);
    if (!djRes.ok)    throw new Error(`dungeons.json — HTTP ${djRes.status}`);

    const dofusData  = await dofusRes.json();
    
    dbEquipments     = dofusData.equipements ?? new Array();
    dbResources      = dofusData.ressources  ?? new Array();
    dbMonstres       = dofusData.monstres    ?? new Array();
    
    dbRunesWeights   = await rwRes.json();
    dbRuneNames      = await rnRes.json();
    dbDungeons       = await djRes.json();
}

/* =============================================================================
   INITIALISATION DES MODULES
   Ordre respectant les dépendances inter-modules.
============================================================================= */

/**
 * Initialise tous les modules de l'application dans l'ordre correct.
 *
 * Ordre :
 *   1. Navigation          — doit être prêt avant tout module utilisant onTabChange()
 *   2. Calculateur         — onglet par défaut, initialisé en premier
 *   3. Deals Scanner       — inclut le filtre de catégories (dépend des données)
 *   4. Dashboard           — enregistre son callback onTabChange
 *   5. Objectif Craft      — aucune dépendance inter-module
 *   6. Arbre de dép.       — construit son index (opération coûteuse, une seule fois)
 *   7. Brisage             — dépend de EFFECT_MAPPING + evaluateTree
 *   8. Historique          — enregistre son callback onTabChange
 *   9. Trading             — analyse de rentabilité des ressources HDV
 *  10. Farming             — classement des zones de farm
 */
function _initModules() {
    AppNav.init();

    setupSearch();
    setupGlobalListeners();

    setupDealsScanner();
    populateDealsCategoryFilter();

    setupDashboard();
    setupObjectifCraft();
    setupDependencyGraph();
    setupBrisageComparator();
    setupHistorique();
    setupTrading();
    setupFarming();
    setupPanier();
    setupBrisageScanner();
}

/* =============================================================================
   POINT D'ENTRÉE
============================================================================= */

/**
 * Séquence de démarrage :
 *   1. Chargement parallèle des JSON
 *   2. Initialisation des modules
 *   3. Préchargement des icônes (avec écran de progression)
 *   4. Masquage de l'écran de chargement
 */
window.onload = async () => {
    try {
        await _loadData();
        _initModules();
        await preloadAllImages(dbEquipments, dbResources);
        hideLoadingScreen();
    } catch (err) {
        console.error('[app] Échec du démarrage :', err);
        alert(`Impossible de charger l'application.\n\nDétail : ${err.message}`);
    }
};