/**
 * @file hiddenItems.js
 * @description Gestion des items cachés — partagé entre le calculateur,
 * le scanner de brisage et les bons plans.
 *
 * * Deux namespaces de clés :
 *   hidden_smash:{id}  → item caché du scanner de brisage
 *   hidden_deal:{id}   → item caché des bons plans
 *
 *
 */

'use strict';

/* =============================================================================
   CLÉS
============================================================================= */

/** @param {number} id @returns {string} */
function _keySmash(id) { return `hidden_smash:${id}`; }

/** @param {number} id @returns {string} */
function _keyDeal(id)  { return `hidden_deal:${id}`;  }

/* =============================================================================
   API
============================================================================= */

const HiddenItems = {

    // ── SMASH ──────────────────────────────────────────────────────────────

    /** @param {number} id @returns {boolean} */
    isHiddenSmash(id) {
        return localStorage.getItem(_keySmash(id)) === '1';
    },

    /** @param {number} id */
    hideSmash(id) {
        localStorage.setItem(_keySmash(id), '1');
    },

    /** @param {number} id */
    showSmash(id) {
        localStorage.removeItem(_keySmash(id));
    },

    /** @param {number} id */
    toggleSmash(id) {
        this.isHiddenSmash(id) ? this.showSmash(id) : this.hideSmash(id);
    },

    /** @returns {Set<number>} Ensemble de tous les IDs cachés (smash). */
    allHiddenSmash() {
        const ids = new Set();
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            // La clé préfixée ressemble à "srv_default:hidden_smash:276"
            const m = key.match(/hidden_smash:(\d+)$/);
            if (m) ids.add(parseInt(m[1], 10));
        }
        return ids;
    },

    // ── DEAL ───────────────────────────────────────────────────────────────

    /** @param {number} id @returns {boolean} */
    isHiddenDeal(id) {
        return localStorage.getItem(_keyDeal(id)) === '1';
    },

    /** @param {number} id */
    hideDeal(id) {
        localStorage.setItem(_keyDeal(id), '1');
    },

    /** @param {number} id */
    showDeal(id) {
        localStorage.removeItem(_keyDeal(id));
    },

    /** @param {number} id */
    toggleDeal(id) {
        this.isHiddenDeal(id) ? this.showDeal(id) : this.hideDeal(id);
    },

    /** @returns {Set<number>} Ensemble de tous les IDs cachés (deal). */
    allHiddenDeal() {
        const ids = new Set();
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            const m = key.match(/hidden_deal:(\d+)$/);
            if (m) ids.add(parseInt(m[1], 10));
        }
        return ids;
    },

    /** Vide tous les hidden_deal (utile pour le bouton "tout réafficher"). */
    clearAllDeal() {
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.match(/hidden_deal:\d+$/)) toRemove.push(key);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
    },

    /** Vide tous les hidden_smash. */
    clearAllSmash() {
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.match(/hidden_smash:\d+$/)) toRemove.push(key);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
    },
};
