/**
 * @file admin.modals.js
 * @description CRUD complet et éditeurs inline du backoffice admin.
 *
 * Responsabilités :
 *   - Gestion des modales (ouverture, fermeture, clic en dehors)
 *   - CRUD équipements : ajouter, éditer, supprimer, sauvegarder
 *   - CRUD ressources  : ajouter, éditer, supprimer, sauvegarder
 *     (avec 4 paliers de prix : ×1, ×10, ×100, ×1000)
 *   - Import JSON OCR  : lecture d'un fichier Prix*.json, rapprochement
 *     par id, injection des 4 paliers en localStorage + AdminState
 *   - Éditeur de recette inline (lignes d'ingrédients)
 *   - Éditeur d'effets inline (stats avec min/max)
 *   - Export JSON (recettes_dofus.json) incluant les 4 paliers de prix
 *
 * @depends admin.state.js   — AdminState
 * @depends admin.filters.js — applyFilterAndSortEquip, applyFilterAndSortRes,
 *                             sortEquipList, sortResList
 * @depends storage.js       — getAllPriceLots, setAllPriceLots, setStoredPriceLot,
 *                             getStoredPriceLot
 * @depends constants.js     — EFFECT_MAPPING
 */

/* =============================================================================
   CONSTANTES LOCALES
============================================================================= */

/**
 * Liste ordonnée des paliers de prix ressource.
 * Utilisée pour la lecture/écriture groupée dans la modale et l'export.
 * @type {ReadonlyArray<string>}
 */
const PRICE_LOTS = Object.freeze(['x1', 'x10', 'x100', 'x1000']);

/* =============================================================================
   MODALES — GESTION GÉNÉRIQUE
============================================================================= */

/**
 * Initialise la fermeture des modales :
 *   - boutons `.close-modal`
 *   - clic sur l'overlay (en dehors du contenu)
 */
function setupModals() {
    document.querySelectorAll('.close-modal').forEach(btn =>
        btn.addEventListener('click', closeAllModals)
    );
    document.querySelectorAll('.modal').forEach(modal =>
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeAllModals();
        })
    );
}

/**
 * Ouvre une modale par son ID.
 * @param {string} id - ID de l'élément `.modal`.
 */
function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
}

/** Ferme toutes les modales ouvertes. */
function closeAllModals() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

/* =============================================================================
   ÉQUIPEMENTS — CRUD
============================================================================= */

/**
 * Ouvre la modale d'ajout d'un nouvel équipement (formulaire vide).
 */
document.getElementById('btn-add-equip').addEventListener('click', () => {
    document.getElementById('modal-equip-title').textContent = 'Ajouter un équipement';
    document.getElementById('equip-original-id').value = '';
    document.getElementById('form-equip').reset();
    renderRecipeEditor([]);
    renderEffectsEditor([]);
    openModal('modal-equip');
});

/**
 * Ouvre la modale d'édition d'un équipement existant.
 * Exposé sur `window` pour l'appel depuis les boutons `onclick` inline du tableau.
 *
 * @param {number} id - ID de l'équipement à éditer.
 */
window.editEquipment = function (id) {
    const item = AdminState.equipments.find(i => i.id_itm === id);
    if (!item) return;

    document.getElementById('modal-equip-title').textContent = `Éditer : ${item.nom}`;
    document.getElementById('equip-original-id').value      = item.id_itm;
    document.getElementById('equip-name').value             = item.nom;
    document.getElementById('equip-category').value         = item.categorie || '';
    document.getElementById('equip-level').value            = item.niveau;
    document.getElementById('equip-icon').value             = item.icone || '';

    renderRecipeEditor(item.ingredients ?? []);
    renderEffectsEditor(item.stats ??[]);
    openModal('modal-equip');
};

/**
 * Supprime un équipement après confirmation.
 * Exposé sur `window` pour l'appel depuis les boutons `onclick` inline.
 *
 * @param {number} id
 */
window.deleteEquipment = function (id) {
    if (!confirm('Voulez-vous vraiment supprimer cet équipement ?')) return;

    AdminState.setEquipments(AdminState.equipments.filter(i => i.id_itm !== id));
    AdminState.deselectEquip(id);

    populateCategoryFilter();
    applyFilterAndSortEquip();
    applyFilterAndSortRes();
};

/**
 * Valide et sauvegarde le formulaire d'équipement (ajout ou modification).
 */
document.getElementById('btn-save-equip').addEventListener('click', (e) => {
    e.preventDefault();

    const originalId = parseInt(document.getElementById('equip-original-id').value, 10);
    const name       = document.getElementById('equip-name').value.trim();
    const category   = document.getElementById('equip-category').value.trim();
    const level      = parseInt(document.getElementById('equip-level').value, 10) || 1;
    const iconUrl    = document.getElementById('equip-icon').value.trim();

    if (!name || !category) {
        alert('Veuillez remplir le Nom et la Catégorie.');
        return;
    }

    const newIngredients = _readIngredientsFromEditor();
    const newStats       = _readStatsFromEditor();

    if (originalId) {
        _updateEquipment(originalId, { name, category, level, iconUrl, newIngredients, newStats });
    } else {
        _insertEquipment({ name, category, level, iconUrl, newIngredients, newStats });
    }

    populateCategoryFilter();
    applyFilterAndSortEquip();
    applyFilterAndSortRes();
    closeAllModals();
});

/**
 * Met à jour un équipement existant dans le tableau de données.
 * @private
 */
function _updateEquipment(id, { name, category, level, iconUrl, newIngredients, newStats }) {
    const idx = AdminState.equipments.findIndex(eq => eq.id_itm === id);
    if (idx === -1) return;

    const eq       = AdminState.equipments[idx];
    eq.nom         = name;
    eq.categorie   = category;
    eq.niveau      = level;
    eq.icone       = iconUrl;
    eq.ingredients = newIngredients;
    eq.stats       = newStats;
}

/**
 * Insère un nouvel équipement en tête du tableau de données.
 * L'ID est calculé comme max(ids existants) + 1.
 * @private
 */
function _insertEquipment({ name, category, level, iconUrl, newIngredients, newStats }) {
    const equipments = AdminState.equipments;
    const newId      = equipments.length > 0
        ? Math.max(...equipments.map(i => i.id_itm)) + 1
        : 1;

    equipments.unshift({
        id_itm:      newId,
        nom:         name,
        niveau:      level,
        categorie:   category,
        icone:       iconUrl,
        stats:       newStats,
        ingredients: newIngredients,
    });
}

/* =============================================================================
   RESSOURCES — CRUD
============================================================================= */

/**
 * Ouvre la modale d'ajout d'une nouvelle ressource (formulaire vide).
 * Vide également les 4 champs de prix.
 */
document.getElementById('btn-add-res').addEventListener('click', () => {
    document.getElementById('modal-res-title').textContent = 'Ajouter une ressource';
    document.getElementById('res-original-id').value = '';
    document.getElementById('form-res').reset();
    _clearResModalPrices();
    openModal('modal-res');
});

/**
 * Ouvre la modale d'édition d'une ressource existante.
 * Pré-remplit les 4 paliers de prix depuis le localStorage (priorité)
 * puis depuis AdminState si aucune valeur n'est en cache.
 *
 * Exposé sur `window` pour l'appel depuis les boutons `onclick` inline.
 *
 * @param {number} id
 */
window.editResource = function (id) {
    const res = AdminState.resources.find(r => r.id_res === id);
    if (!res) return;

    document.getElementById('modal-res-title').textContent = `Éditer : ${res.nom}`;
    document.getElementById('res-original-id').value       = res.id_res;
    document.getElementById('res-name').value              = res.nom;
    document.getElementById('res-icon').value              = res.icone || '';

    // Taux de drop : priorité localStorage → JSON → vide
    const storedDrop = localStorage.getItem('drop_' + res.id_res);
    document.getElementById('res-drop-rate').value =
        storedDrop !== null ? storedDrop
        : res.taux_drop != null ? res.taux_drop
        : '';

    // 4 paliers de prix : priorité localStorage → champs JSON du modèle → vide
    const lots = getAllPriceLots(res.id_res);
    PRICE_LOTS.forEach(lot => {
        const field = document.getElementById(`res-price-${lot}`);
        // Si localStorage a une valeur, on l'utilise ; sinon on tente le champ JSON
        const jsonVal = res[`prix_${lot.replace('x', '')}`] ?? null;
        const value   = lots[lot] !== null ? lots[lot] : jsonVal;
        field.value   = value !== null ? value : '';
    });

    openModal('modal-res');
};

/**
 * Supprime une ressource après confirmation.
 * Exposé sur `window` pour l'appel depuis les boutons `onclick` inline.
 *
 * @param {number} id
 */
window.deleteResource = function (id) {
    if (!confirm('Voulez-vous vraiment supprimer cette ressource ?')) return;

    AdminState.setResources(AdminState.resources.filter(r => r.id_res !== id));
    AdminState.deselectRes(id);

    applyFilterAndSortRes();
    populateResourcesDatalist();
};

/**
 * Valide et sauvegarde le formulaire de ressource (ajout ou modification).
 * Persiste les 4 paliers de prix en localStorage et dans AdminState.
 */
document.getElementById('btn-save-res').addEventListener('click', (e) => {
    e.preventDefault();

    const originalId = parseInt(document.getElementById('res-original-id').value, 10);
    const name       = document.getElementById('res-name').value.trim();
    const iconUrl    = document.getElementById('res-icon').value.trim();
    const dropRaw    = document.getElementById('res-drop-rate').value.trim();
    const dropNorm   = _parseDropValue(dropRaw);

    if (!name) {
        alert('Veuillez remplir le Nom.');
        return;
    }

    // Lecture des 4 paliers depuis les champs de la modale
    const prices = _readModalPrices();

    if (originalId) {
        const idx = AdminState.resources.findIndex(r => r.id_res === originalId);
        if (idx !== -1) {
            AdminState.resources[idx].nom       = name;
            AdminState.resources[idx].icone     = iconUrl;
            AdminState.resources[idx].taux_drop = dropNorm;
            // Fusionne les 4 paliers dans le modèle (pour l'export JSON)
            _applyPricesToResource(AdminState.resources[idx], prices);
        }
        // Synchronise localStorage : taux de drop
        if (dropNorm == null) {
            localStorage.removeItem('drop_' + originalId);
        } else {
            localStorage.setItem('drop_' + originalId, String(dropNorm));
        }
        // Synchronise localStorage : 4 paliers de prix
        setAllPriceLots(originalId, prices);

    } else {
        const resources = AdminState.resources;
        const newId     = resources.length > 0
            ? Math.max(...resources.map(r => r.id_res)) + 1
            : 1;

        const newRes = { id_res: newId, nom: name, icone: iconUrl, taux_drop: dropNorm };
        _applyPricesToResource(newRes, prices);
        resources.unshift(newRes);

        setAllPriceLots(newId, prices);
    }

    applyFilterAndSortRes();
    populateResourcesDatalist();
    closeAllModals();
});

/* =============================================================================
   RESSOURCES — HELPERS MODALE PRIX
============================================================================= */

/**
 * Lit les 4 champs de prix de la modale ressource.
 * Retourne null pour un champ vide (prix non renseigné).
 *
 * @returns {{ x1: number|null, x10: number|null, x100: number|null, x1000: number|null }}
 * @private
 */
function _readModalPrices() {
    const result = {};
    PRICE_LOTS.forEach(lot => {
        const raw     = document.getElementById(`res-price-${lot}`).value.trim();
        const parsed  = parseInt(raw, 10);
        result[lot]   = (raw !== '' && Number.isFinite(parsed)) ? parsed : null;
    });
    return result;
}

/**
 * Vide les 4 champs de prix de la modale ressource.
 * Appelé à l'ouverture en mode "ajout".
 * @private
 */
function _clearResModalPrices() {
    PRICE_LOTS.forEach(lot => {
        document.getElementById(`res-price-${lot}`).value = '';
    });
}

/**
 * Applique les 4 paliers de prix sur un objet ressource (modèle en mémoire).
 * Les valeurs null sont stockées comme null dans le JSON (prix non coté).
 *
 * Convention de nommage dans le modèle :
 *   lot "x1"   → champ "prix_1"
 *   lot "x10"  → champ "prix_10"
 *   lot "x100" → champ "prix_100"
 *   lot "x1000"→ champ "prix_1000"
 *
 * @param {object}                                           res    - Objet ressource à muter.
 * @param {{ x1, x10, x100, x1000: number|null }} prices - Paliers lus depuis la modale ou l'import.
 * @private
 */
function _applyPricesToResource(res, prices) {
    res.prix_1    = prices.x1    ?? null;
    res.prix_10   = prices.x10   ?? null;
    res.prix_100  = prices.x100  ?? null;
    res.prix_1000 = prices.x1000 ?? null;
}

/* =============================================================================
   IMPORT JSON OCR
============================================================================= */

/**
 * Configure l'import de prix ressources avec surveillance automatique du fichier.
 *
 * Si l'API File System Access est disponible (Chromium) :
 *   - Le bouton ouvre un file picker natif → retourne un FileSystemFileHandle
 *   - Un intervalle de 2 s relit le fichier et relance l'import si lastModified change
 *   - Le bouton affiche un indicateur de surveillance "👁 nomfichier.json"
 *   - Recliquer le bouton ouvre un nouveau picker (change de fichier ou stop)
 *
 * Sinon : fallback vers l'input file classique (import unique).
 * @private
 */
function _setupImportPrices() {
    const btn   = document.getElementById('btn-import-prices');
    const input = document.getElementById('input-import-prices');

    if (window.showOpenFilePicker) {
        // ── Mode File System Access API ──────────────────────────────────────
        _setupFileWatch({
            btn,
            label:    '📥 Importer des prix JSON',
            handler:  _handlePriceJsonFile,
            refreshFn: applyFilterAndSortRes,
        });
    } else {
        // ── Fallback classique ───────────────────────────────────────────────
        btn.addEventListener('click', () => input.click());
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            _handlePriceJsonFile(file);
            input.value = '';
        });
    }
}

/**
 * Configure l'import de prix équipements avec surveillance automatique du fichier.
 * Même logique que _setupImportPrices.
 * @private
 */
function _setupImportEquipPrices() {
    const btn   = document.getElementById('btn-import-equip-prices');
    const input = document.getElementById('input-import-equip-prices');

    if (window.showOpenFilePicker) {
        // ── Mode File System Access API ──────────────────────────────────────
        _setupFileWatch({
            btn,
            label:    '📥 Importer des prix JSON',
            handler:  _handleEquipPriceJsonFile,
            refreshFn: applyFilterAndSortEquip,
        });
    } else {
        // ── Fallback classique ───────────────────────────────────────────────
        btn.addEventListener('click', () => input.click());
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            _handleEquipPriceJsonFile(file);
            input.value = '';
        });
    }
}

/**
 * Attache la logique de surveillance automatique sur un bouton d'import.
 *
 * @param {{ btn: HTMLElement, label: string, handler: Function, refreshFn: Function }} opts
 * @private
 */
function _setupFileWatch({ btn, label, handler, refreshFn }) {
    /** @type {FileSystemFileHandle|null} */
    let fileHandle     = null;
    /** @type {number|null} Timestamp du dernier import. */
    let lastModified   = null;
    /** @type {number|null} ID de l'intervalle de surveillance. */
    let watchInterval  = null;

    /**
     * Arrête la surveillance et réinitialise l'état du bouton.
     */
    function stopWatch() {
        if (watchInterval !== null) {
            clearInterval(watchInterval);
            watchInterval = null;
        }
        fileHandle   = null;
        lastModified = null;
        btn.textContent = label;
        btn.classList.remove('btn-watching');
        btn.title = '';
    }

    /**
     * Lit le fichier via le handle et exécute l'import si le contenu a changé.
     */
    async function checkAndReload() {
        if (!fileHandle) return;
        try {
            const file = await fileHandle.getFile();
            if (file.lastModified === lastModified) return;

            lastModified = file.lastModified;
            handler(file);

            // Feedback discret sur le bouton
            const name = file.name;
            btn.textContent = `👁 ${name}`;
            _showWatchFeedback(btn, name);
        } catch {
            // Fichier inaccessible (déplacé, supprimé) → arrêt de la surveillance
            stopWatch();
        }
    }

    btn.addEventListener('click', async () => {
        // Si une surveillance est en cours → l'arrêter
        if (watchInterval !== null) {
            stopWatch();
            return;
        }

        try {
            [fileHandle] = await window.showOpenFilePicker({
                types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
                multiple: false,
            });
        } catch {
            // Annulation du picker
            return;
        }

        // Premier import immédiat
        const file   = await fileHandle.getFile();
        lastModified = file.lastModified;
        handler(file);
        refreshFn();

        // Démarre la surveillance
        const name = file.name;
        btn.textContent = `👁 ${name}`;
        btn.classList.add('btn-watching');
        btn.title = `Surveillance active — cliquer pour arrêter`;

        watchInterval = setInterval(checkAndReload, 2000);
    });
}

/**
 * Affiche un flash "✅ Mis à jour" sur le bouton pendant 1,5 s.
 * @param {HTMLElement} btn
 * @param {string}      filename
 * @private
 */
function _showWatchFeedback(btn, filename) {
    btn.classList.add('btn-watch-updated');
    setTimeout(() => {
        btn.classList.remove('btn-watch-updated');
        btn.textContent = `👁 ${filename}`;
    }, 1500);
}

/**
 * Lit un fichier JSON de prix OCR, valide son contenu,
 * injecte les prix en localStorage et dans AdminState,
 * puis rafraîchit le tableau.
 *
 * Deux formats acceptés :
 *
 * Format 1 — tableau plat (ressources uniquement) :
 * ```json
 * [
 *   { "id": 276, "prix_moyen": 23, "prix_1": 15, "prix_10": 287, ... }
 * ]
 * ```
 *
 * Format 2 — objet avec ressources + runes :
 * ```json
 * {
 *   "ressources": [ { "id": 276, "prix_1": 15, ... } ],
 *   "prix_runes": [ { "nom": "PA", "prix": 8000 }, { "nom": "Force", "prix": 450 } ]
 * }
 * ```
 *
 * @param {File} file - Fichier JSON sélectionné par l'utilisateur.
 * @private
 */
function _handlePriceJsonFile(file) {
    const reader = new FileReader();

    reader.onload = (e) => {
        let parsed;
        try {
            parsed = JSON.parse(e.target.result);
        } catch {
            alert(`❌ Fichier JSON invalide :\n${file.name}\n\nVérifiez la syntaxe du fichier.`);
            return;
        }

        // Détection du format
        let resEntries  = [];
        let runeEntries = [];

        if (Array.isArray(parsed)) {
            // Format 1 — tableau plat de ressources
            resEntries = parsed;
        } else if (parsed && typeof parsed === 'object') {
            // Format 2 — objet { ressources, prix_runes }
            if (Array.isArray(parsed.ressources))  resEntries  = parsed.ressources;
            if (Array.isArray(parsed.prix_runes))   runeEntries = parsed.prix_runes;
        } else {
            alert('❌ Le fichier JSON doit contenir un tableau ou un objet avec les clés "ressources" et/ou "prix_runes".');
            return;
        }

        const resReport  = _importPriceEntries(resEntries);
        const runeReport = _importRunePrices(runeEntries);

        _showImportReport(resReport, file.name, runeReport);

        // Rafraîchit le tableau pour afficher les nouvelles valeurs
        applyFilterAndSortRes();
    };

    reader.readAsText(file, 'utf-8');
}

/**
 * Importe les prix de runes depuis un tableau { nom, prix }.
 * Persiste chaque prix sous la clé `rune_{nom}` en localStorage.
 *
 * Le champ `nom` doit correspondre exactement au nom utilisé dans
 * runes_weights.json (ex: "PA", "Force", "Vitalité").
 *
 * @param {object[]} entries - Tableau { nom: string, prix: number }.
 * @returns {{ matched: number, skipped: number, errors: string[] }}
 * @private
 */
function _importRunePrices(entries) {
    const report = { matched: 0, skipped: 0, errors: [] };
    if (!entries.length) return report;

    // Construit un Set des noms valides depuis dbRunesWeights (si disponible)
    // Sinon, accepte tout nom non vide (les runes inconnues seront stockées
    // et simplement ignorées si le calculateur ne les reconnaît pas).
    const knownNames = typeof dbRunesWeights !== 'undefined'
        ? new Set(dbRunesWeights.map(r => r.nom))
        : null;

    entries.forEach((entry, index) => {
        const nom = entry.nom;
        if (!nom || typeof nom !== 'string' || nom.trim() === '') {
            report.errors.push(`Entrée rune #${index + 1} : champ "nom" manquant ou invalide.`);
            return;
        }

        if (knownNames && !knownNames.has(nom)) {
            report.skipped++;
            return;
        }

        const prix = _parseOcrPrice(entry.prix);
        if (prix === null) {
            report.skipped++;
            return;
        }

        localStorage.setItem('rune_' + nom, prix);
        report.matched++;
    });

    return report;
}

/**
 * Affiche un rapport d'import combiné (ressources + runes).
 *
 * @param {{ matched: number, skipped: number, errors: string[] }} resReport
 * @param {string}  filename
 * @param {{ matched: number, skipped: number, errors: string[] }} [runeReport]
 * @private
 */
function _showImportReport(resReport, filename, runeReport = null) {
    const lines = [
        `📥 Import terminé — ${filename}`,
        ``,
        `📦 Ressources : ✅ ${resReport.matched} mise(s) à jour · ⏭️ ${resReport.skipped} ignorée(s)`,
    ];

    if (runeReport && (runeReport.matched > 0 || runeReport.skipped > 0)) {
        lines.push(`💎 Runes      : ✅ ${runeReport.matched} mise(s) à jour · ⏭️ ${runeReport.skipped} ignorée(s)`);
    }

    const allErrors = [...resReport.errors, ...(runeReport?.errors ?? [])];
    if (allErrors.length > 0) {
        lines.push(``, `⚠️  ${allErrors.length} erreur(s) :`);
        allErrors.slice(0, 10).forEach(err => lines.push(`  • ${err}`));
        if (allErrors.length > 10) lines.push(`  … et ${allErrors.length - 10} autres.`);
    }

    alert(lines.join('\n'));
}

/**
 * Parcourt les entrées OCR et applique les prix sur les ressources connues.
 *
 * Stratégie de rapprochement : uniquement par `id` (= id_res dans le modèle).
 * Les entrées sans id, avec id inconnu ou sans aucun prix sont ignorées.
 *
 * @param {object[]} entries - Tableau d'objets issus du JSON OCR.
 * @returns {{ matched: number, skipped: number, errors: string[] }}
 * @private
 */
function _importPriceEntries(entries) {
    const report = { matched: 0, skipped: 0, errors:[] };

    entries.forEach((entry, index) => {
        // Validation : id obligatoire et numérique
        const id = parseInt(entry.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            report.errors.push(`Entrée #${index + 1} : id manquant ou invalide (${entry.id}).`);
            return;
        }

        // ── Détection des runes de forgemagie ─────────────────────────────────
        // Le champ `type` vaut "Rune de forgemagie" et le nom suit le pattern
        // "Rune {abréviation}" (ex: "Rune Vi", "Rune Ga Pa").
        // On extrait l'abréviation, on résout le nom complet via adminRuneAbbrToNom
        // (table inverse de runeName.json), et on stocke rune_{nom}.
        if (entry.type === 'Rune de forgemagie' && entry.nom) {
            const abbr    = entry.nom.replace(/^Rune\s+/i, '').trim();
            const fullNom = adminRuneAbbrToNom[abbr];

            if (fullNom) {
                const prix = _parseOcrPrice(entry.prix_1);
                if (prix !== null) {
                    localStorage.setItem('rune_' + fullNom, prix);
                    // Stocke aussi le prix moyen comme référence
                    const avg = _parseOcrPrice(entry.prix_moyen);
                    if (avg !== null) localStorage.setItem('rune_avg_' + fullNom, avg);
                    report.matched++;
                } else {
                    report.skipped++;
                }
            } else {
                report.skipped++;
            }
            return;
        }

        // ── Ressources ────────────────────────────────────────────────────────
        const resIdx = AdminState.resources.findIndex(r => r.id_res === id);
        if (resIdx === -1) {
            report.skipped++;
            return;
        }

        // Extraction des 4 paliers depuis l'entrée OCR
        // Les champs OCR sont prix_1, prix_10, prix_100, prix_1000
        const prices = {
            x1:    _parseOcrPrice(entry.prix_1),
            x10:   _parseOcrPrice(entry.prix_10),
            x100:  _parseOcrPrice(entry.prix_100),
            x1000: _parseOcrPrice(entry.prix_1000),
        };

        // Applique dans le modèle mémoire (AdminState)
        _applyPricesToResource(AdminState.resources[resIdx], prices);

        // Persiste en localStorage (source de vérité pour l'UI inline)
        setAllPriceLots(id, prices);

        // Traitement du prix moyen pour l'onglet Trading
        if (entry.hasOwnProperty('prix_moyen')) {
            const avgPrice = _parseOcrPrice(entry.prix_moyen);
            if (avgPrice !== null) {
                localStorage.setItem(`avg_${id}`, avgPrice);
            } else {
                localStorage.removeItem(`avg_${id}`);
            }
        }

        // Stocke le niveau de la ressource pour le filtre Trading
        if (entry.niveau != null) {
            const niveau = parseInt(entry.niveau, 10);
            if (Number.isFinite(niveau) && niveau > 0) {
                localStorage.setItem(`niveau_${id}`, niveau);
            }
        }

        report.matched++;
    });

    return report;
}

/**
 * Convertit une valeur brute issue du JSON OCR en entier ou null.
 * Les valeurs null, undefined, 0 négatif ou non numériques deviennent null.
 *
 * @param {*} raw - Valeur brute (ex: 287, null, "15", undefined).
 * @returns {number|null}
 * @private
 */
function _parseOcrPrice(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const parsed = parseInt(raw, 10);
    return (Number.isFinite(parsed) && parsed >= 0) ? parsed : null;
}

/* =============================================================================
   ÉDITEUR DE RECETTE
============================================================================= */

/**
 * Peuple le conteneur de l'éditeur de recette avec les ingrédients fournis.
 * @param {Array<{id_res: number, quantite: number}>} ingredients
 */
function renderRecipeEditor(ingredients) {
    const container = document.getElementById('recipe-editor-container');
    container.innerHTML = '';

    if (!Array.isArray(ingredients)) return;

    ingredients.forEach(ing => {
        const res = AdminState.resources.find(r => r.id_res === ing.id_res);
        addRecipeRow(ing.quantite, res?.nom ?? '', ing.id_res);
    });
}

/**
 * Ajoute une ligne d'ingrédient à l'éditeur de recette.
 * Gère la résolution automatique de l'ID à partir du nom saisi.
 *
 * @param {number} [qty=1]           - Quantité initiale.
 * @param {string}[resName='']      - Nom de la ressource.
 * @param {number|string}[idRes=''] - ID de la ressource.
 */
function addRecipeRow(qty = 1, resName = '', idRes = '') {
    const container = document.getElementById('recipe-editor-container');
    const div       = document.createElement('div');
    div.className   = 'recipe-row';
    div.innerHTML   = `
        <input type="number" class="rec-qty" value="${qty}" min="1" placeholder="Qté" required>
        <input type="text"   class="rec-name" value="${resName}"
               list="resources-datalist" placeholder="Nom de la ressource"
               autocomplete="off" required>
        <input type="number" class="rec-id" value="${idRes}"
               placeholder="ID" readonly tabindex="-1">
        <button type="button" class="btn btn-danger btn-sm"
                onclick="this.parentElement.remove()">X</button>`;

    // Résolution automatique de l'ID quand l'utilisateur tape un nom connu
    div.querySelector('.rec-name').addEventListener('input', (e) => {
        const match = AdminState.resources.find(
            r => r.nom.toLowerCase() === e.target.value.toLowerCase()
        );
        div.querySelector('.rec-id').value = match ? match.id_res : '';
    });

    container.appendChild(div);
}

document.getElementById('btn-add-recipe-row').addEventListener('click', () => addRecipeRow());

/**
 * Lit et valide les lignes de l'éditeur de recette.
 * Filtre les lignes incomplètes (quantité ou ID manquant).
 *
 * @returns {Array<{id_res: number, quantite: number}>}
 * @private
 */
function _readIngredientsFromEditor() {
    const ingredients =[];
    document.querySelectorAll('.recipe-row').forEach(row => {
        const qty = parseInt(row.querySelector('.rec-qty').value, 10) || 0;
        const id  = parseInt(row.querySelector('.rec-id').value, 10)  || 0;
        if (qty > 0 && id > 0) ingredients.push({ id_res: id, quantite: qty });
    });
    return ingredients;
}

/* =============================================================================
   ÉDITEUR D'EFFETS
============================================================================= */

/**
 * Peuple le conteneur de l'éditeur d'effets avec tous les effets de EFFECT_MAPPING.
 * Les effets déjà présents dans `existingStats` sont pré-cochés et pré-remplis.
 *
 * @param {Array<{id_effet: number, min: number, max?: number}>}[existingStats=[]]
 */
function renderEffectsEditor(existingStats =[]) {
    const container = document.getElementById('effects-editor-container');
    container.innerHTML = '';

    for (const[idStr, mapData] of Object.entries(EFFECT_MAPPING)) {
        const id          = parseInt(idStr, 10);
        const currentStat = existingStats.find(s => s.id_effet === id);
        const isActive    = !!currentStat;

        const displayName = mapData.sign === -1
            ? `<span class="danger-text">- ${mapData.name}</span>`
            : mapData.name;

        const itemDiv     = document.createElement('div');
        itemDiv.className = `effect-item ${isActive ? 'active' : ''}`;
        itemDiv.innerHTML = `
            <label class="effect-label">
                <input type="checkbox" class="eff-checkbox" value="${id}"
                       ${isActive ? 'checked' : ''}>${displayName}
            </label>
            <div class="effect-inputs">
                <input type="number" class="eff-min"
                       placeholder="Min" value="${isActive ? currentStat.min : ''}">
                <span>-</span>
                <input type="number" class="eff-max"
                       placeholder="Max" value="${isActive && currentStat.max != null ? currentStat.max : ''}">
            </div>`;

        itemDiv.querySelector('.eff-checkbox').addEventListener('change', (e) => {
            if (e.target.checked) {
                itemDiv.classList.add('active');
            } else {
                itemDiv.classList.remove('active');
                itemDiv.querySelector('.eff-min').value = '';
                itemDiv.querySelector('.eff-max').value = '';
            }
        });

        container.appendChild(itemDiv);
    }
}

/**
 * Lit et valide les effets cochés dans l'éditeur d'effets.
 *
 * @returns {Array<{id_effet: number, min: number, max?: number}>}
 * @private
 */
function _readStatsFromEditor() {
    const stats =[];
    document.querySelectorAll('.effect-item.active').forEach(item => {
        const effId  = parseInt(item.querySelector('.eff-checkbox').value, 10);
        const minRaw = item.querySelector('.eff-min').value;
        const maxRaw = item.querySelector('.eff-max').value;

        const stat = { id_effet: effId, min: parseInt(minRaw, 10) || 0 };
        if (maxRaw !== '') stat.max = parseInt(maxRaw, 10);
        stats.push(stat);
    });
    return stats;
}

/* =============================================================================
   EXPORT JSON
============================================================================= */

/**
 * Convertit une valeur brute saisie dans un champ taux de drop
 * en valeur stockable : nombre, "CRAFT", "ÉCHANGE", ou null.
 *
 * @param {string} raw - Valeur brute (texte du champ).
 * @returns {number|string|null}
 */
function _parseDropValue(raw) {
    const stripped = (raw || '').trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase();

    if (stripped === 'CRAFT')   return 'CRAFT';
    if (stripped === 'ECHANGE') return 'ÉCHANGE';
    if (stripped === 'METIER')  return 'MÉTIER';
    if (stripped === 'SACHET')  return 'SACHET';
    if (stripped === 'QUETE')   return 'QUÊTE';

    const numeric = (raw || '').trim().replace(',', '.');
    const parsed  = parseFloat(numeric);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) return parsed;

    return null;
}

/**
 * Initialise les boutons d'export JSON et le bouton d'import OCR.
 * Appelé depuis admin.js → _initAdminModules().
 */
function setupButtons() {
    document.getElementById('btn-export-equip').addEventListener('click', _exportJson);
    document.getElementById('btn-export-res').addEventListener('click', _exportJson);
    _setupImportPrices();
    _setupImportEquipPrices();
}

/* =============================================================================
   IMPORT PRIX — ÉQUIPEMENTS
============================================================================= */

/**
 * Lit un fichier JSON de prix HDV équipements, valide et injecte.
 * @param {File} file
 * @private
 */
function _handleEquipPriceJsonFile(file) {
    const reader = new FileReader();

    reader.onload = (e) => {
        let entries;
        try {
            entries = JSON.parse(e.target.result);
        } catch {
            alert(`❌ Fichier JSON invalide :\n${file.name}\n\nVérifiez la syntaxe du fichier.`);
            return;
        }

        if (!Array.isArray(entries)) {
            alert('❌ Le fichier JSON doit contenir un tableau d\'objets.');
            return;
        }

        const report = _importEquipPriceEntries(entries);
        _showEquipImportReport(report, file.name);

        applyFilterAndSortEquip();
    };

    reader.readAsText(file, 'utf-8');
}

/**
 * Parcourt les entrées et applique les prix HDV sur les équipements connus.
 *
 * Rapprochement par `id` (= id_itm).
 * Champ attendu : `prix` — entier positif représentant le prix HDV en Kamas.
 *
 * @param {object[]} entries
 * @returns {{ matched: number, skipped: number, errors: string[] }}
 * @private
 */
function _importEquipPriceEntries(entries) {
    const report = { matched: 0, skipped: 0, errors: [] };

    entries.forEach((entry, index) => {
        const id = parseInt(entry.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            report.errors.push(`Entrée #${index + 1} : id manquant ou invalide (${entry.id}).`);
            return;
        }

        const equipIdx = AdminState.equipments.findIndex(e => e.id_itm === id);
        if (equipIdx === -1) {
            report.skipped++;
            return;
        }

        const prix = _parseOcrPrice(entry.prix);
        if (prix === null) {
            report.skipped++;
            return;
        }

        // Persiste en localStorage (source de vérité pour l'UI inline)
        localStorage.setItem('equip_' + id, prix);
        localStorage.setItem('equip_' + id + '_ts', Date.now());

        report.matched++;
    });

    return report;
}

/**
 * Affiche le rapport d'import équipements.
 * @param {{ matched: number, skipped: number, errors: string[] }} report
 * @param {string} filename
 * @private
 */
function _showEquipImportReport(report, filename) {
    const lines = [
        `📥 Import terminé — ${filename}`,
        ``,
        `✅ ${report.matched} équipement(s) mis à jour`,
        `⏭️  ${report.skipped} entrée(s) ignorée(s) (id inconnu ou prix invalide)`,
    ];

    if (report.errors.length > 0) {
        lines.push(``, `⚠️  ${report.errors.length} erreur(s) :`);
        report.errors.slice(0, 10).forEach(err => lines.push(`  • ${err}`));
        if (report.errors.length > 10) {
            lines.push(`  … et ${report.errors.length - 10} autres.`);
        }
    }

    alert(lines.join('\n'));
}

/**
 * Exporte la base de données complète en JSON et déclenche le téléchargement.
 *
 * Avant l'export :
 *   1. Fusionne les taux de drop depuis le localStorage (saisies inline)
 *   2. Fusionne les 4 paliers de prix depuis le localStorage dans chaque ressource
 *
 * @private
 */
function _exportJson() {
    AdminState.resources.forEach(res => {
        // Taux de drop : priorité localStorage
        const storedDrop = localStorage.getItem('drop_' + res.id_res);
        if (storedDrop !== null) {
            res.taux_drop = _parseDropValue(storedDrop);
        }

        // 4 paliers de prix : flush localStorage → modèle
        const lots = getAllPriceLots(res.id_res);
        const hasAnyLot = PRICE_LOTS.some(lot => lots[lot] !== null);
        if (hasAnyLot) {
            _applyPricesToResource(res, lots);
        }
    });

    const fullData       = AdminState.fullData;
    fullData.equipements = sortEquipList(AdminState.equipments);
    fullData.ressources  = sortResList(AdminState.resources);

    const jsonStr = JSON.stringify(fullData, null, 2);
    const blob    = new Blob([jsonStr], { type: 'application/json' });
    const url     = URL.createObjectURL(blob);

    const link    = document.createElement('a');
    link.href     = url;
    link.download = 'recettes_dofus.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}