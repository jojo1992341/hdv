/**
 * @file admin.state.js
 * @description État centralisé du backoffice admin.
 *
 * Remplace les 12 variables `let` globales dispersées dans admin.js original.
 * Toutes les mutations passent par les setters exposés — aucun autre module
 * ne doit accéder directement aux propriétés internes de `_state`.
 *
 * Responsabilités :
 *   - Données brutes (dbEquipments, dbResources, dbEffects, dbFullData)
 *   - Données filtrées/triées (filteredEquipments, filteredResources)
 *   - Pagination équipements et ressources
 *   - Filtres de recherche et de catégorie
 *   - État de tri (colonne + direction)
 *   - Sélections de masse (Sets)
 */

/* =============================================================================
   CONFIGURATION
============================================================================= */

/** Taille de page par défaut pour les deux tableaux. @type {number} */
const ADMIN_DEFAULT_PAGE_SIZE = 50;

/* =============================================================================
   ÉTAT INTERNE (PRIVÉ)
============================================================================= */

const _state = {
    // ── Données brutes ────────────────────────────────────────────────────────
    /** @type {object}   Données JSON complètes (pour l'export). */
    fullData:             {},
    /** @type {object[]} Équipements craftables. */
    equipments:           [],
    /** @type {object[]} Ressources de base. */
    resources:            [],
    /** @type {object[]} Effets (non utilisé directement dans les vues actuelles). */
    effects:              [],

    // ── Données dérivées (résultat du filtrage + tri) ────────────────────────
    /** @type {object[]} Sous-ensemble filtré et trié des équipements. */
    filteredEquipments:   [],
    /** @type {object[]} Sous-ensemble filtré et trié des ressources. */
    filteredResources:    [],

    // ── Pagination équipements ───────────────────────────────────────────────
    equipPage:            1,
    equipPageSize:        ADMIN_DEFAULT_PAGE_SIZE,

    // ── Pagination ressources ────────────────────────────────────────────────
    resPage:              1,
    resPageSize:          ADMIN_DEFAULT_PAGE_SIZE,

    // ── Filtres de recherche ─────────────────────────────────────────────────
    /** @type {string} Terme de recherche équipements (en minuscules). */
    searchEquip:          '',
    /** @type {string} Catégorie active pour les équipements ('' = toutes). */
    catEquip:             '',
    /** @type {string} Terme de recherche ressources (en minuscules). */
    searchRes:            '',

    // ── Tri ──────────────────────────────────────────────────────────────────
    /** @type {{ column: string|null, asc: boolean }} */
    sortEquip:            { column: null, asc: true },
    /** @type {{ column: string|null, asc: boolean }} */
    sortRes:              { column: null, asc: true },

    // ── Sélections de masse ──────────────────────────────────────────────────
    /** @type {Set<number>} IDs des équipements sélectionnés. */
    selectedEquips:       new Set(),
    /** @type {Set<number>} IDs des ressources sélectionnées. */
    selectedRes:          new Set(),
};

/* =============================================================================
   ACCESSEURS — DONNÉES BRUTES
============================================================================= */

const AdminState = {
    // ── Getters ───────────────────────────────────────────────────────────────

    get fullData()           { return _state.fullData; },
    get equipments()         { return _state.equipments; },
    get resources()          { return _state.resources; },
    get effects()            { return _state.effects; },
    get filteredEquipments() { return _state.filteredEquipments; },
    get filteredResources()  { return _state.filteredResources; },

    // Pagination
    get equipPage()     { return _state.equipPage; },
    get equipPageSize() { return _state.equipPageSize; },
    get resPage()       { return _state.resPage; },
    get resPageSize()   { return _state.resPageSize; },

    // Filtres
    get searchEquip() { return _state.searchEquip; },
    get catEquip()    { return _state.catEquip; },
    get searchRes()   { return _state.searchRes; },

    // Tri
    get sortEquip() { return _state.sortEquip; },
    get sortRes()   { return _state.sortRes; },

    // Sélections (lecture directe des Sets — ne pas muter de l'extérieur)
    get selectedEquips() { return _state.selectedEquips; },
    get selectedRes()    { return _state.selectedRes; },

    // ── Setters — Données brutes ──────────────────────────────────────────────

    /**
     * Initialise les données brutes après chargement du JSON.
     * @param {{ fullData, equipments, resources, effects }} data
     */
    setData({ fullData, equipments, resources, effects }) {
        _state.fullData    = fullData;
        _state.equipments  = equipments;
        _state.resources   = resources;
        _state.effects     = effects;
    },

    /** @param {object[]} list */
    setEquipments(list) { _state.equipments = list; },

    /** @param {object[]} list */
    setResources(list) { _state.resources = list; },

    /** @param {object[]} list */
    setFilteredEquipments(list) { _state.filteredEquipments = list; },

    /** @param {object[]} list */
    setFilteredResources(list) { _state.filteredResources = list; },

    // ── Setters — Pagination ──────────────────────────────────────────────────

    /** @param {number} page */
    setEquipPage(page) { _state.equipPage = page; },

    /** @param {number} size */
    setEquipPageSize(size) { _state.equipPageSize = size; },

    /** Réinitialise la pagination équipements à la page 1. */
    resetEquipPage() { _state.equipPage = 1; },

    /** @param {number} page */
    setResPage(page) { _state.resPage = page; },

    /** @param {number} size */
    setResPageSize(size) { _state.resPageSize = size; },

    /** Réinitialise la pagination ressources à la page 1. */
    resetResPage() { _state.resPage = 1; },

    // ── Setters — Filtres ─────────────────────────────────────────────────────

    /**
     * Met à jour le terme de recherche équipements et remet la pagination à 1.
     * @param {string} query
     */
    setSearchEquip(query) {
        _state.searchEquip = query.toLowerCase();
        _state.equipPage   = 1;
    },

    /**
     * Met à jour le filtre de catégorie et remet la pagination à 1.
     * @param {string} cat
     */
    setCatEquip(cat) {
        _state.catEquip  = cat;
        _state.equipPage = 1;
    },

    /**
     * Met à jour le terme de recherche ressources et remet la pagination à 1.
     * @param {string} query
     */
    setSearchRes(query) {
        _state.searchRes = query.toLowerCase();
        _state.resPage   = 1;
    },

    // ── Setters — Tri ─────────────────────────────────────────────────────────

    /**
     * Bascule ou initialise le tri équipements sur une colonne donnée.
     * Si la colonne est déjà active, inverse la direction.
     * @param {string} column
     */
    toggleSortEquip(column) {
        if (_state.sortEquip.column === column) {
            _state.sortEquip.asc = !_state.sortEquip.asc;
        } else {
            _state.sortEquip = { column, asc: true };
        }
    },

    /**
     * Bascule ou initialise le tri ressources sur une colonne donnée.
     * @param {string} column
     */
    toggleSortRes(column) {
        if (_state.sortRes.column === column) {
            _state.sortRes.asc = !_state.sortRes.asc;
        } else {
            _state.sortRes = { column, asc: true };
        }
    },

    // ── Méthodes — Sélections de masse ────────────────────────────────────────

    /** @param {number} id */
    selectEquip(id)   { _state.selectedEquips.add(id); },
    /** @param {number} id */
    deselectEquip(id) { _state.selectedEquips.delete(id); },
    /** Vide la sélection équipements. */
    clearEquipSelection() { _state.selectedEquips.clear(); },

    /** @param {number} id */
    selectRes(id)   { _state.selectedRes.add(id); },
    /** @param {number} id */
    deselectRes(id) { _state.selectedRes.delete(id); },
    /** Vide la sélection ressources. */
    clearResSelection() { _state.selectedRes.clear(); },

    /**
     * Synchronise la sélection équipements avec une liste de checkboxes.
     * @param {NodeList} checkboxes
     * @param {boolean}  checked
     */
    bulkSelectEquips(checkboxes, checked) {
        checkboxes.forEach(chk => {
            const id = parseInt(chk.value, 10);
            checked ? _state.selectedEquips.add(id) : _state.selectedEquips.delete(id);
        });
    },

    /**
     * Synchronise la sélection ressources avec une liste de checkboxes.
     * @param {NodeList} checkboxes
     * @param {boolean}  checked
     */
    bulkSelectRes(checkboxes, checked) {
        checkboxes.forEach(chk => {
            const id = parseInt(chk.value, 10);
            checked ? _state.selectedRes.add(id) : _state.selectedRes.delete(id);
        });
    },
};
