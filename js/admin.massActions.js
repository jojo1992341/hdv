/**
 * @file admin.massActions.js
 * @description Sélection de masse et suppressions groupées dans le backoffice.
 *
 * Responsabilités :
 *   - Sélection / désélection de toutes les lignes d'un tableau
 *   - Suppression groupée des éléments sélectionnés
 *   - Mise à jour visuelle des boutons de suppression groupée
 *   - Synchronisation de l'état de la checkbox "tout cocher"
 *
 * @depends admin.state.js   — AdminState
 * @depends admin.render.js  — renderEquipmentsPage, renderResourcesPage
 * @depends admin.filters.js — applyFilterAndSortEquip, applyFilterAndSortRes
 */

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Attache les listeners de sélection de masse et de suppression groupée.
 * Doit être appelée une fois au chargement de la page.
 */
function setupMassActions() {
    _setupSelectAll('check-all-equip', '.chk-equip',
        (chks, checked) => AdminState.bulkSelectEquips(chks, checked)
    );

    _setupSelectAll('check-all-res', '.chk-res',
        (chks, checked) => AdminState.bulkSelectRes(chks, checked)
    );

    document.getElementById('btn-delete-multi-equip').addEventListener('click', _deleteSelectedEquipments);
    document.getElementById('btn-delete-multi-res').addEventListener('click', _deleteSelectedResources);
}

/**
 * Attache le listener "tout cocher / tout décocher" sur une checkbox maître.
 *
 * @param {string}   checkAllId   - ID de la checkbox maître.
 * @param {string}   itemSelector - Sélecteur CSS des checkboxes de lignes.
 * @param {Function} syncFn       - Fonction de synchronisation du Set de sélection.
 * @private
 */
function _setupSelectAll(checkAllId, itemSelector, syncFn) {
    document.getElementById(checkAllId).addEventListener('change', (e) => {
        const checkboxes = document.querySelectorAll(itemSelector);
        checkboxes.forEach(chk => { chk.checked = e.target.checked; });
        syncFn(checkboxes, e.target.checked);
        updateMassDeleteUI();
    });
}

/* =============================================================================
   SUPPRESSIONS GROUPÉES
============================================================================= */

/**
 * Supprime tous les équipements sélectionnés après confirmation.
 * Rafraîchit le filtre de catégories et les deux tableaux.
 * @private
 */
function _deleteSelectedEquipments() {
    const count = AdminState.selectedEquips.size;
    if (!confirm(`Voulez-vous vraiment supprimer ${count} équipement(s) ?`)) return;

    AdminState.setEquipments(
        AdminState.equipments.filter(e => !AdminState.selectedEquips.has(e.id_itm))
    );
    AdminState.clearEquipSelection();

    populateCategoryFilter();
    applyFilterAndSortEquip();
    applyFilterAndSortRes();
}

/**
 * Supprime toutes les ressources sélectionnées après confirmation.
 * Avertit l'utilisateur que les recettes des équipements ne sont pas modifiées.
 * @private
 */
function _deleteSelectedResources() {
    const count = AdminState.selectedRes.size;
    if (!confirm(
        `Voulez-vous vraiment supprimer ${count} ressource(s) ?\n` +
        `Attention : cela ne les enlèvera pas des recettes des équipements !`
    )) return;

    AdminState.setResources(
        AdminState.resources.filter(r => !AdminState.selectedRes.has(r.id_res))
    );
    AdminState.clearResSelection();

    populateResourcesDatalist();
    applyFilterAndSortRes();
}

/* =============================================================================
   MISE À JOUR DE L'UI
============================================================================= */

/**
 * Affiche ou masque les boutons de suppression groupée selon les sélections actives.
 * Met à jour le libellé avec le nombre d'éléments sélectionnés.
 */
function updateMassDeleteUI() {
    _updateDeleteButton('btn-delete-multi-equip', AdminState.selectedEquips.size);
    _updateDeleteButton('btn-delete-multi-res',   AdminState.selectedRes.size);
}

/**
 * Met à jour un bouton de suppression groupée.
 *
 * @param {string} btnId - ID du bouton.
 * @param {number} count - Nombre d'éléments sélectionnés.
 * @private
 */
function _updateDeleteButton(btnId, count) {
    const btn = document.getElementById(btnId);
    if (count > 0) {
        btn.classList.remove('hidden');
        btn.textContent = `🗑️ Supprimer (${count})`;
    } else {
        btn.classList.add('hidden');
    }
}

/**
 * Synchronise l'état de la checkbox "tout cocher" des équipements
 * avec l'état réel des checkboxes de lignes.
 */
function checkAllEquipToggleState() {
    _syncSelectAllCheckbox('check-all-equip', '.chk-equip');
}

/**
 * Synchronise l'état de la checkbox "tout cocher" des ressources.
 */
function checkAllResToggleState() {
    _syncSelectAllCheckbox('check-all-res', '.chk-res');
}

/**
 * Coche la checkbox maître si et seulement si toutes les checkboxes de lignes
 * sont cochées (et qu'il en existe au moins une).
 *
 * @param {string} masterCheckboxId
 * @param {string} itemSelector
 * @private
 */
function _syncSelectAllCheckbox(masterCheckboxId, itemSelector) {
    const checkboxes = document.querySelectorAll(itemSelector);
    const allChecked = checkboxes.length > 0
        && Array.from(checkboxes).every(c => c.checked);
    document.getElementById(masterCheckboxId).checked = allChecked;
}
