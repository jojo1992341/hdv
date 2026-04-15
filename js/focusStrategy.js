/**
 * @file focusStrategy.js
 * @description Fonction utilitaire partagée pour calculer la meilleure stratégie de focus.
 * Utilisée par le calculateur et le scanner de brisage pour garantir des résultats identiques.
 */

'use strict';

/**
 * Calcule les Points De Brisage (PDB) pour chaque effet.
 * Formule exacte du calculateur : (3 × jet × niveau × poids_unite / 200) + 1
 * Pour les effets négatifs (sign = -1) : PDB = (PDB / 10) × -1
 *
 * @param {Array<object>} effects - Liste des effets avec jet (ou itemJets[index]), weightUnite, index, sign
 * @param {number} level - Niveau de l'équipement
 * @param {Object.<number, number>} [itemJets] - Optionnel : jets par index (pour le calculateur)
 * @returns {Object.<number, number>} PDB indexé par index d'effet
 */
function calcPdbs(effects, level, itemJets = null) {
    const pdbs = {};
    effects.forEach(eff => {
        const jet = itemJets !== null ? itemJets[eff.index] : eff.jet;
        let pdb = (3 * jet * level * eff.weightUnite / 200) + 1;
        if (eff.sign === -1) pdb = (pdb / 10) * -1;
        pdbs[eff.index] = pdb;
    });
    return pdbs;
}

/**
 * Calcule la meilleure stratégie de focus pour un équipement.
 * Compare le gain base avec tous les focus possibles et retourne le meilleur.
 *
 * @param {Array<object>} effects - Liste des effets avec name, abbr, weightRuneNormal, index, sign
 * @param {Object.<number, number>} pdbs - PDB par index d'effet
 * @param {number} totalPdb - Somme totale des PDB positifs
 * @param {number} coeff - Coefficient de brisage (0–1)
 * @returns {{
 *   baseKamas: { guaranteed: number, expected: number },
 *   bestFocus: { abbr: string, guaranteed: number, expected: number } | null
 * }}
 */
function calcBestFocusStrategy(effects, pdbs, totalPdb, coeff) {
    let baseGuaranteed = 0;
    let baseExpected = 0;
    const focusStrategies = [];

    effects.forEach(eff => {
        if (eff.sign === -1) return;

        const price = getStoredPrice(priceKeyRune(eff.name));
        if (price <= 0) return;

        const baseRunesFloat = (pdbs[eff.index] / eff.weightRuneNormal) * coeff;
        baseGuaranteed += Math.floor(baseRunesFloat) * price;
        baseExpected += baseRunesFloat * price;

        // Formule exacte du calculateur pour le focus
        const focusRunesFloat = ((pdbs[eff.index] + 0.5 * (totalPdb - pdbs[eff.index])) / eff.weightRuneNormal) * coeff;

        focusStrategies.push({
            abbr:       eff.abbr,
            guaranteed: Math.floor(focusRunesFloat) * price,
            expected:   focusRunesFloat * price,
        });
    });

    // Inclure la stratégie "Aucun focus" dans le tri
    const allStrategies = [
        { type: 'none', abbr: null, guaranteed: baseGuaranteed, expected: baseExpected },
        ...focusStrategies,
    ];

    // Tri par guaranteed décroissant, puis expected décroissant (même logique que le calculateur)
    allStrategies.sort((a, b) => b.guaranteed - a.guaranteed || b.expected - a.expected);

    const best = allStrategies[0];

    // Si la meilleure stratégie est "Aucun focus", bestFocus = null
    const bestFocus = best.type === 'none' ? null : {
        abbr:       best.abbr,
        guaranteed: best.guaranteed,
        expected:   best.expected,
    };

    return {
        baseKamas: { guaranteed: baseGuaranteed, expected: baseExpected },
        bestFocus,
    };
}
