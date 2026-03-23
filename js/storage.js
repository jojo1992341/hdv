/**
 * @file storage.js
 * @description Couche d'abstraction pour la persistance des prix et timestamps
 *              dans le localStorage du navigateur.
 *
 * Convention de clés :
 *   res_{id}       → prix unitaire d'une ressource (×1)
 *   res_{id}_x1/x10/x100/x1000 → paliers de prix
 *   equip_{id}     → prix HDV d'un équipement
 *   rune_{nom}     → prix d'une rune
 *   *_ts           → timestamp de la dernière mise à jour
 */

const STORAGE_KEYS = Object.freeze({ RES: 'res_', EQUIP: 'equip_', RUNE: 'rune_' });

const LOT_SUFFIXES = Object.freeze({ x1: '_x1', x10: '_x10', x100: '_x100', x1000: '_x1000' });

function priceKeyRes(id)   { return STORAGE_KEYS.RES   + id; }
function priceKeyEquip(id) { return STORAGE_KEYS.EQUIP + id; }
function priceKeyRune(nom) { return STORAGE_KEYS.RUNE  + nom; }

function priceKeyResLot(id, lot) {
    if (!(lot in LOT_SUFFIXES)) console.warn(`[storage] Palier inconnu : "${lot}"`);
    return STORAGE_KEYS.RES + id + (LOT_SUFFIXES[lot] ?? '_x1');
}

function getStoredPrice(key) {
    const parsed = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function setStoredPrice(key, value) {
    localStorage.setItem(key, value);
    localStorage.setItem(key + '_ts', Date.now());
}

function getStoredPriceLot(id, lot) {
    const raw = localStorage.getItem(priceKeyResLot(id, lot));
    if (raw === null) return null;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function setStoredPriceLot(id, lot, value) {
    const key = priceKeyResLot(id, lot);
    if (value === null || value === '') {
        localStorage.removeItem(key);
        localStorage.removeItem(key + '_ts');
    } else {
        setStoredPrice(key, value);
    }
}

function getAllPriceLots(id) {
    return {
        x1:    getStoredPriceLot(id, 'x1'),
        x10:   getStoredPriceLot(id, 'x10'),
        x100:  getStoredPriceLot(id, 'x100'),
        x1000: getStoredPriceLot(id, 'x1000'),
    };
}

function setAllPriceLots(id, prices) {
    for (const lot of ['x1', 'x10', 'x100', 'x1000']) {
        if (Object.prototype.hasOwnProperty.call(prices, lot)) {
            setStoredPriceLot(id, lot, prices[lot] ?? null);
        }
    }
    if (Object.prototype.hasOwnProperty.call(prices, 'x1')) {
        if (prices.x1 != null) {
            setStoredPrice(priceKeyRes(id), prices.x1);
        } else {
            localStorage.removeItem(priceKeyRes(id));
            localStorage.removeItem(priceKeyRes(id) + '_ts');
        }
    }
}

function getStoredTimestamp(key) {
    const parsed = parseInt(localStorage.getItem(key + '_ts'), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

const DATE_LOCALE = 'fr-FR';

function formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toLocaleDateString(DATE_LOCALE)} ${d.toLocaleTimeString(DATE_LOCALE, { hour: '2-digit', minute: '2-digit' })}`;
}

function ageInfo(ts) {
    if (!ts) return { text: 'Jamais', cls: 'age-never' };
    const days = (Date.now() - ts) / 86_400_000;
    if (days < 1) return { text: "Aujourd'hui", cls: 'age-fresh' };
    if (days < 7) return { text: `${Math.floor(days)}j`, cls: 'age-ok' };
    return            { text: `${Math.floor(days)}j`, cls: 'age-old' };
}
