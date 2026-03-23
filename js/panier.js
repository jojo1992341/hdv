/**
 * @file panier.js
 * @description Onglet Panier — Liste agrégée des ressources à acheter pour
 *              crafter tous les équipements ajoutés depuis l'onglet Bons Plans.
 *
 * Responsabilités :
 *   - Stocker les équipements sélectionnés (PanierState)
 *   - Calculer récursivement la liste plate optimale de ressources à acheter
 *     (même logique buy-vs-craft que evaluateTree dans dealsScanner.js)
 *   - Agréger les quantités quand plusieurs équipements partagent une ressource
 *   - Rendre le tableau de ressources avec coût total
 *
 * @depends storage.js    — getStoredPrice, priceKeyRes
 * @depends imageCache.js — getIcon, copyToClipboard
 */

'use strict';

/* =============================================================================
   ÉTAT DU MODULE
============================================================================= */

const PanierState = {
    /**
     * Équipements dans le panier.
     * @type {Map<number, {item: object, qty: number}>}
     */
    items: new Map(),
};

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Initialise l'onglet Panier.
 * Doit être appelée une fois depuis app.js après AppNav.init().
 */
function setupPanier() {
    document.getElementById('btn-panier-clear')
        .addEventListener('click', _clearPanier);
}

/* =============================================================================
   API PUBLIQUE — ajout / suppression
============================================================================= */

/**
 * Ajoute un équipement au panier (ou incrémente sa quantité) puis rafraîchit
 * l'onglet et met à jour le badge de compteur dans l'onglet nav.
 *
 * @param {number} itemId - id_itm de l'équipement à ajouter.
 */
function addToCart(itemId) {
    const item = dbEquipments.find(e => e.id_itm === itemId);
    if (!item) return;

    if (PanierState.items.has(itemId)) {
        PanierState.items.get(itemId).qty++;
    } else {
        PanierState.items.set(itemId, { item, qty: 1 });
    }

    _updateCartBadge();
    _renderPanier();
    _showAddFeedback(itemId);
}

/**
 * Retire un équipement du panier et rafraîchit.
 * @param {number} itemId
 */
function removeFromCart(itemId) {
    PanierState.items.delete(itemId);
    _updateCartBadge();
    _renderPanier();
}

/**
 * Modifie la quantité d'un équipement dans le panier.
 * @param {number} itemId
 * @param {number} qty
 */
function setCartQty(itemId, qty) {
    const entry = PanierState.items.get(itemId);
    if (!entry) return;
    if (qty <= 0) {
        removeFromCart(itemId);
    } else {
        entry.qty = qty;
        _renderPanier();
    }
}

/* =============================================================================
   CALCUL — DEUX LISTES : ACHETER / CRAFTER
============================================================================= */

/**
 * Calcule récursivement les deux listes de ressources pour un nœud :
 *
 *   toBuy  — ressources à acheter directement (feuilles ou nœuds craftables
 *            où achat ≤ craft)
 *   toCraft — ressources craftables qu'il est moins cher de crafter
 *            (affichées dans la section dédiée ; leurs sous-ingrédients
 *            continuent la récursion dans les deux maps)
 *
 * @param {number} itemId
 * @param {number} qty
 * @param {Map}    toBuy   — accumulateur "à acheter", muté en place
 * @param {Map}    toCraft — accumulateur "à crafter", muté en place
 * @param {Set}    visited — anti-boucle
 * @private
 */
function _collectResources(itemId, qty, toBuy, toCraft, visited = new Set()) {
    if (visited.has(itemId)) return;
    visited.add(itemId);

    const equip      = dbEquipments.find(e => e.id_itm === itemId);
    const isCraftable = !!(equip?.ingredients?.length);

    if (!isCraftable) {
        _accumulateEntry(itemId, qty, toBuy);
        return;
    }

    const craftCost = _computeCraftCostOnly(equip, qty, new Set(visited));
    const unitBuy   = getStoredPrice(priceKeyRes(itemId));
    const buyTotal  = unitBuy * qty;
    const shouldBuy = unitBuy > 0 && buyTotal <= craftCost;

    if (shouldBuy) {
        _accumulateEntry(itemId, qty, toBuy);
    } else {
        // Ce nœud est crafté → l'ajouter dans toCraft
        _accumulateEntry(itemId, qty, toCraft);
        // Ses sous-ingrédients continuent la récursion dans les deux maps
        equip.ingredients.forEach(ing => {
            _collectResources(ing.id_res, ing.quantite * qty, toBuy, toCraft, new Set(visited));
        });
    }
}

/**
 * Calcule uniquement le coût total de craft récursif d'un nœud
 * (sans accumuler) pour la comparaison buy-vs-craft.
 *
 * @param {object} equip
 * @param {number} qty
 * @param {Set}    visited
 * @returns {number}
 * @private
 */
function _computeCraftCostOnly(equip, qty, visited) {
    let total = 0;
    equip.ingredients.forEach(ing => {
        if (visited.has(ing.id_res)) return;
        const childEquip  = dbEquipments.find(e => e.id_itm === ing.id_res);
        const isCraftable = !!(childEquip?.ingredients?.length);
        const childQty    = ing.quantite * qty;
        const buyP        = getStoredPrice(priceKeyRes(ing.id_res));

        if (!isCraftable || buyP <= 0) {
            total += buyP * childQty;
        } else {
            const subCraft = _computeCraftCostOnly(childEquip, childQty, new Set(visited));
            total += Math.min(buyP * childQty, subCraft);
        }
    });
    return total;
}

/**
 * Ajoute ou agrège une entrée dans une Map accumulatrice.
 * @param {number} itemId
 * @param {number} qty
 * @param {Map}    acc
 * @private
 */
function _accumulateEntry(itemId, qty, acc) {
    const res       = dbResources.find(r => r.id_res === itemId)
                   ?? dbEquipments.find(e => e.id_itm === itemId);
    const unitPrice = getStoredPrice(priceKeyRes(itemId));

    if (acc.has(itemId)) {
        acc.get(itemId).qty += qty;
    } else {
        acc.set(itemId, {
            id:        itemId,
            nom:       res?.nom   ?? `#${itemId}`,
            icone:     res?.icone ?? '',
            qty,
            unitPrice,
        });
    }
}

/**
 * Construit les deux listes agrégées (toBuy / toCraft) pour TOUS les
 * équipements du panier.
 * Pour chaque entrée de toCraft, génère le treeHTML via evaluateTree
 * une fois les quantités finales connues.
 *
 * @returns {{ toBuy: Map, toCraft: Map }}
 * @private
 */
function _buildAggregatedResources() {
    const toBuy   = new Map();
    const toCraft = new Map();

    PanierState.items.forEach(({ item, qty }) => {
        if (!item.ingredients?.length) return;
        item.ingredients.forEach(ing => {
            _collectResources(ing.id_res, ing.quantite * qty, toBuy, toCraft);
        });
    });

    // Génère l'arbre de craft pour chaque entrée toCraft
    // (après agrégation pour avoir la qty finale correcte)
    toCraft.forEach((entry, itemId) => {
        const result = evaluateTree(itemId, entry.qty, new Set());
        entry.treeHTML  = result.treeHTML;
        entry.craftCost = result.cost;
    });

    return { toBuy, toCraft };
}

/* =============================================================================
   RENDU
============================================================================= */

/**
 * Rend le contenu de l'onglet Panier.
 * @private
 */
function _renderPanier() {
    const container = document.getElementById('panier-content');
    if (!container) return;

    if (PanierState.items.size === 0) {
        container.innerHTML = `
            <div class="panier-empty">
                <div class="panier-empty-icon">🛒</div>
                <p>Votre panier est vide.<br>
                   Ajoutez des équipements depuis l'onglet
                   <strong>Bons Plans (Crafts)</strong> en cliquant sur 🛒.</p>
            </div>`;
        return;
    }

    const { toBuy, toCraft } = _buildAggregatedResources();
    const fmt = n => n.toLocaleString('fr-FR');

    /* ── Section équipements ─────────────────────────────── */
    const equipRows = Array.from(PanierState.items.values()).map(({ item, qty }) => `
        <tr class="panier-equip-row">
            <td class="panier-equip-icon"><img src="${getIcon(item.icone)}" alt=""></td>
            <td class="panier-equip-name">
                <span class="copyable-name"
                      onclick="copyToClipboard('${item.nom.replace(/'/g, "\\'")}', this)"
                      title="Cliquer pour copier">${item.nom}</span>
                <span class="panier-equip-level">Niv. ${item.niveau}</span>
            </td>
            <td class="panier-equip-qty">
                <input type="number" class="panier-qty-input" min="1" value="${qty}"
                       data-item-id="${item.id_itm}"
                       title="Quantité à crafter">
            </td>
            <td class="panier-equip-actions">
                <button class="btn-panier-remove" data-item-id="${item.id_itm}"
                        title="Retirer du panier">✕</button>
            </td>
        </tr>`).join('');

    /* ── Utilitaire : construire les lignes d'une Map ressource ── */
    const buildResRows = (map) => {
        let totalCost    = 0;
        let missingCount = 0;
        const rows = Array.from(map.values())
            .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
            .map(r => {
                const lineTotal = r.unitPrice > 0 ? r.unitPrice * r.qty : 0;
                totalCost += lineTotal;
                if (r.unitPrice <= 0) missingCount++;

                const priceCell = r.unitPrice > 0
                    ? `<span class="panier-res-price">${fmt(lineTotal)} K</span>
                       <span class="panier-res-unit">(${fmt(r.unitPrice)} K/u)</span>`
                    : `<span class="panier-res-missing">Prix manquant</span>`;

                return `
                <tr class="panier-res-row ${r.unitPrice <= 0 ? 'panier-res-missing-row' : ''}">
                    <td class="panier-res-icon"><img src="${getIcon(r.icone)}" alt=""></td>
                    <td class="panier-res-name">
                        <span class="copyable-name"
                              onclick="copyToClipboard('${r.nom.replace(/'/g, "\\'")}', this)"
                              title="Cliquer pour copier">${r.nom}</span>
                    </td>
                    <td class="panier-res-qty">${fmt(r.qty)}×</td>
                    <td class="panier-res-total">${priceCell}</td>
                </tr>`;
            }).join('');
        return { rows, totalCost, missingCount };
    };

    /* ── Section "À acheter" ─────────────────────────────── */
    const buy = buildResRows(toBuy);
    const buyMissingBadge = buy.missingCount > 0
        ? `<span class="panier-missing-badge">⚠️ ${buy.missingCount} prix manquant${buy.missingCount > 1 ? 's' : ''}</span>`
        : '';

    const sectionBuy = `
        <section class="panier-section">
            <div class="panier-res-header">
                <h3 class="panier-section-title">📦 Ressources à acheter (${toBuy.size})</h3>
                <div class="panier-total-block">
                    ${buyMissingBadge}
                    <span class="panier-total-label">Coût total estimé</span>
                    <span class="panier-total-value">${fmt(buy.totalCost)} K</span>
                </div>
            </div>
            ${buy.rows
                ? `<table class="panier-table panier-res-table">
                       <thead><tr>
                           <th></th><th>Ressource</th>
                           <th>Quantité</th><th>Coût</th>
                       </tr></thead>
                       <tbody>${buy.rows}</tbody>
                   </table>`
                : `<p class="panier-section-empty">Aucune ressource à acheter.</p>`
            }
        </section>`;

    /* ── Section "À crafter" ─────────────────────────────── */
    let sectionCraft = '';
    if (toCraft.size > 0) {
        const craftCards = Array.from(toCraft.values())
            .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
            .map(r => {
                const fmt2       = n => n.toLocaleString('fr-FR');
                const costLabel  = r.craftCost > 0
                    ? `<span class="panier-craft-cost">${fmt2(r.craftCost)} K</span>`
                    : `<span class="panier-res-missing">Coût inconnu</span>`;

                return `
                <div class="panier-craft-card">
                    <div class="panier-craft-card-header">
                        <img src="${getIcon(r.icone)}" alt="" class="panier-craft-icon">
                        <span class="panier-craft-name copyable-name"
                              onclick="copyToClipboard('${r.nom.replace(/'/g, "\\'")}', this)"
                              title="Cliquer pour copier">${r.nom}</span>
                        <span class="panier-craft-qty">${fmt2(r.qty)}×</span>
                        <span class="panier-craft-cost-wrap">Coût craft : ${costLabel}</span>
                        <button class="panier-craft-toggle" title="Afficher / masquer les ingrédients">▼</button>
                    </div>
                    <div class="panier-craft-tree deal-tree-container">
                        ${r.treeHTML || '<p class="panier-tree-empty">Arbre de craft indisponible.</p>'}
                    </div>
                </div>`;
            }).join('');

        sectionCraft = `
        <section class="panier-section panier-section-craft">
            <div class="panier-res-header">
                <h3 class="panier-section-title">🔨 Ressources à crafter (${toCraft.size})</h3>
                <span class="panier-craft-note">Moins cher à crafter qu'à acheter</span>
            </div>
            <div class="panier-craft-cards">${craftCards}</div>
        </section>`;
    }

    /* ── Assemblage ──────────────────────────────────────── */
    container.innerHTML = `
        <section class="panier-section">
            <h3 class="panier-section-title" style="padding: 1rem 1.25rem; border-bottom: 1px solid var(--brd); background: var(--bg-raised); display: block;">
                🛡️ Équipements à crafter (${PanierState.items.size})
            </h3>
            <table class="panier-table panier-equip-table">
                <thead><tr>
                    <th></th><th>Équipement</th><th>Qté</th><th></th>
                </tr></thead>
                <tbody>${equipRows}</tbody>
            </table>
        </section>

        ${sectionBuy}
        ${sectionCraft}`;

    _attachPanierListeners(container);
}

/**
 * Attache les listeners sur les boutons et inputs du panier.
 * @param {HTMLElement} container
 * @private
 */
function _attachPanierListeners(container) {
    // Boutons supprimer
    container.querySelectorAll('.btn-panier-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            removeFromCart(parseInt(btn.dataset.itemId, 10));
        });
    });

    // Inputs quantité
    container.querySelectorAll('.panier-qty-input').forEach(input => {
        input.addEventListener('change', () => {
            const id  = parseInt(input.dataset.itemId, 10);
            const qty = parseInt(input.value, 10);
            setCartQty(id, isNaN(qty) ? 1 : qty);
        });
    });

    // Toggle arbre de craft (section 🔨)
    container.querySelectorAll('.panier-craft-toggle').forEach(btn => {
        const tree = btn.closest('.panier-craft-card').querySelector('.panier-craft-tree');
        btn.addEventListener('click', () => {
            const isOpen = !tree.classList.contains('hidden');
            tree.classList.toggle('hidden', isOpen);
            btn.textContent = isOpen ? '▶' : '▼';
        });
    });

    // Copie des noms dans l'arbre de craft
    container.querySelectorAll('.deal-node-name-text.copyable-name').forEach(el => {
        el.addEventListener('click', function () {
            copyToClipboard(this.textContent.trim(), this);
        });
    });
}

/* =============================================================================
   UTILITAIRES UI
============================================================================= */

/**
 * Vide entièrement le panier.
 * @private
 */
function _clearPanier() {
    if (PanierState.items.size === 0) return;
    if (!confirm(`Vider le panier (${PanierState.items.size} équipement(s)) ?`)) return;
    PanierState.items.clear();
    _updateCartBadge();
    _renderPanier();
}

/**
 * Met à jour le badge numérique dans le bouton de navigation du panier.
 * @private
 */
function _updateCartBadge() {
    const badge = document.getElementById('panier-nav-badge');
    if (!badge) return;
    const count = PanierState.items.size;
    badge.textContent = count > 0 ? count : '';
    badge.classList.toggle('hidden', count === 0);
}

/**
 * Feedback visuel temporaire sur le bouton 🛒 d'un deal card.
 * @param {number} itemId
 * @private
 */
function _showAddFeedback(itemId) {
    const btn = document.querySelector(`.btn-add-to-cart[data-item-id="${itemId}"]`);
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML  = '✅ Ajouté !';
    btn.disabled   = true;
    setTimeout(() => {
        btn.innerHTML = orig;
        btn.disabled  = false;
    }, 1200);
}
