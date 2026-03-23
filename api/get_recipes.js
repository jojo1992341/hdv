/**
 * @file get_recipes.js
 * @description Scraper Node.js — génère recettes_dofus.json depuis l'API DofusDB avec système de cache optimisé.
 *
 * Usage :
 *   node get_recipes.js
 *
 * Prérequis :
 *   Node 18+ (fetch natif). Aucune dépendance npm.
 *
 * Sortie :
 *   recettes_dofus.json  — { equipements, ressources, effets, monstres }
 */

'use strict';

const fs = require('fs');

/* =============================================================================
   CONSTANTES & UTILITAIRES
============================================================================= */

const API_BASE = 'https://api.dofusdb.fr';
const PAGE_SIZE = 50;
const ICON_URL = (iconId) => `https://api.dofusdu.de/dofus3/v1/img/item/${iconId}-64.png`;
const OUTPUT_FILE = '../json/recettes_dofus.json';
const CACHE_DIR = '../json/cache';

/** Arrondi strict au centième (ex: 0.019999 -> 0.02) */
const roundTaux = (val) => Math.round(val * 100) / 100;

/* Création du dossier de cache s'il n'existe pas */
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/* =============================================================================
   NETTOYAGE ET PROJECTION DES DONNÉES (POUR RÉDUIRE LE CACHE)
============================================================================= */

function projectData(endpoint, data) {
    const projectedData = new Array();

    for (const item of data) {
        if (endpoint === 'items') {
            const effects = new Array();
            if (item.effects) {
                for (const e of item.effects) {
                    effects.push({ effectId: e.effectId, from: e.from, to: e.to });
                }
            }
            projectedData.push({
                id: item.id,
                name: { fr: item.name?.fr },
                level: item.level,
                type: { 
                    categoryId: item.type?.categoryId, 
                    name: { fr: item.type?.name?.fr } 
                },
                iconId: item.iconId,
                effects: effects
            });
        } 
        else if (endpoint === 'recipes') {
            projectedData.push({
                resultId: item.resultId,
                ingredientIds: item.ingredientIds,
                quantities: item.quantities
            });
        } 
        else if (endpoint === 'effects') {
            projectedData.push({
                id: item.id,
                description: { fr: item.description?.fr }
            });
        } 
        else if (endpoint === 'monsters') {
            const drops = new Array();
            if (item.drops) {
                for (const d of item.drops) {
                    drops.push({
                        objectId: d.objectId,
                        itemId: d.itemId,
                        percentDropForGrade1: d.percentDropForGrade1,
                        percentDrop: d.percentDrop
                    });
                }
            }
            projectedData.push({
                id: item.id,
                name: { fr: item.name?.fr },
                drops: drops,
                isBoss: item.isBoss,
                favoriteSubAreas: item.favoriteSubAreas,
                subareas: item.subareas,
                subAreaIds: item.subAreaIds
            });
        } 
        else if (endpoint === 'subareas') {
            projectedData.push({
                id: item.id,
                areaId: item.areaId,
                level: item.level,
                name: { fr: item.name?.fr },
                nameId: { fr: item.nameId?.fr }
            });
        } 
        else if (endpoint === 'areas') {
            projectedData.push({
                id: item.id,
                name: { fr: item.name?.fr },
                nameId: { fr: item.nameId?.fr }
            });
        }
        else if (endpoint === 'dungeons') {
            projectedData.push({
                id: item.id,
                name: { fr: item.name?.fr },
                nameId: { fr: item.nameId?.fr },
                optimalPlayerLevel: item.optimalPlayerLevel
            });
        }
        else {
            projectedData.push(item);
        }
    }

    return projectedData;
}

/* =============================================================================
   COUCHE RÉSEAU & CACHE
============================================================================= */

async function fetchAll(endpoint, queryParams = '') {
    const allData = new Array();
    let skip  = 0;
    let total = 1;

    while (skip < total) {
        const url = `${API_BASE}/${endpoint}?$limit=${PAGE_SIZE}&$skip=${skip}${queryParams}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Erreur API[${endpoint}] — HTTP ${response.status} (skip=${skip})`);
        }

        const json = await response.json();
        total = json.total;
        allData.push(...json.data);

        skip += PAGE_SIZE;
        process.stdout.write(`\r👉 Téléchargement [${endpoint}] : ${Math.min(skip, total)} / ${total}`);
    }

    console.log(`\n✅ ${endpoint} — ${allData.length} enregistrements téléchargés.`);
    return allData;
}

async function fetchWithCache(endpoint, queryParams = '') {
    const safeName = endpoint.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cachePath = `${CACHE_DIR}/${safeName}.json`;

    if (fs.existsSync(cachePath)) {
        console.log(`📦 Chargement depuis le cache local : ${cachePath}`);
        const fileContent = fs.readFileSync(cachePath, 'utf-8');
        return JSON.parse(fileContent);
    }

    const rawData = await fetchAll(endpoint, queryParams);
    const optimizedData = projectData(endpoint, rawData);

    fs.writeFileSync(cachePath, JSON.stringify(optimizedData), 'utf-8');
    return optimizedData;
}

async function fetchItemsAndSplitCache() {
    const itemsPath = `${CACHE_DIR}/items.json`;
    const ressourcesPath = `${CACHE_DIR}/ressources.json`;

    if (fs.existsSync(itemsPath) && fs.existsSync(ressourcesPath)) {
        console.log(`📦 Chargement depuis le cache local : ${itemsPath} & ${ressourcesPath}`);
        const itemsData = JSON.parse(fs.readFileSync(itemsPath, 'utf-8'));
        const ressourcesData = JSON.parse(fs.readFileSync(ressourcesPath, 'utf-8'));
        
        const combinedData = new Array();
        combinedData.push(...itemsData);
        combinedData.push(...ressourcesData);
        return combinedData;
    }

    const rawData = await fetchAll('items');
    const optimizedData = projectData('items', rawData);

    const itemsOnly = new Array();
    const ressourcesOnly = new Array();

    for (const item of optimizedData) {
        if (item.type && item.type.categoryId === 0) {
            itemsOnly.push(item);
        } else {
            ressourcesOnly.push(item);
        }
    }

    fs.writeFileSync(itemsPath, JSON.stringify(itemsOnly), 'utf-8');
    fs.writeFileSync(ressourcesPath, JSON.stringify(ressourcesOnly), 'utf-8');

    return optimizedData;
}

/* =============================================================================
   CONSTRUCTION DES INDEX
============================================================================= */

function buildIndex(items, keyField) {
    const map = new Map();
    for (const item of items) {
        map.set(item[keyField], item);
    }
    return map;
}

function buildDropsIndex(monsters) {
    const dropsMap = new Map();
    for (const monster of monsters) {
        if (!monster.drops || monster.drops.length === 0) continue;
        
        for (const drop of monster.drops) {
            const itemId = drop.objectId || drop.itemId;
            const rawTaux = drop.percentDropForGrade1 || drop.percentDrop || 0;
            const taux = roundTaux(rawTaux);
            
            if (itemId && taux > 0) {
                const currentTaux = dropsMap.get(itemId);
                if (currentTaux === undefined || taux < currentTaux) {
                    dropsMap.set(itemId, taux);
                }
            }
        }
    }
    return dropsMap;
}

/* =============================================================================
   NORMALISATION
============================================================================= */

function buildIngredients(recipe, itemsMap, ressourcesMap, dropsMap) {
    const ingredients = new Array();

    if (!recipe.ingredientIds || !recipe.quantities) return ingredients;

    for (let i = 0; i < recipe.ingredientIds.length; i++) {
        const ingId  = recipe.ingredientIds[i];
        const ingQty = recipe.quantities[i];

        ingredients.push({ id_res: ingId, quantite: ingQty });

        if (!ressourcesMap.has(ingId)) {
            const ingItem = itemsMap.get(ingId);
            
            ressourcesMap.set(ingId, {
                id_res:    ingId,
                nom:       ingItem?.name?.fr ?? `Inconnu (${ingId})`,
                icone:     ingItem ? ICON_URL(ingItem.iconId) : null,
                taux_drop: dropsMap.get(ingId) ?? null,
            });
        }
    }

    return ingredients;
}

function buildStats(resultItem, effectsMap, effetsUtilisesMap) {
    const stats = new Array();

    if (!resultItem.effects) return stats;

    for (const eff of resultItem.effects) {
        const effectId = eff.effectId;
        stats.push({
            id_effet: effectId,
            min:      eff.from,
            max:      eff.to !== 0 ? eff.to : eff.from,
        });

        if (!effetsUtilisesMap.has(effectId)) {
            const effectData = effectsMap.get(effectId);
            effetsUtilisesMap.set(effectId, {
                id_effet:    effectId,
                description: effectData?.description?.fr ?? `Effet Inconnu (${effectId})`,
            });
        }
    }

    return stats;
}

function normalizeRecipe(recipe, itemsMap, effectsMap, ressourcesMap, effetsUtilisesMap, dropsMap) {
    const resultItem = itemsMap.get(recipe.resultId);

    if (!resultItem?.name?.fr) return null;

    const ingredients = buildIngredients(recipe, itemsMap, ressourcesMap, dropsMap);
    const stats       = buildStats(resultItem, effectsMap, effetsUtilisesMap);

    return {
        id_itm:      resultItem.id,
        nom:         resultItem.name.fr,
        niveau:      resultItem.level ?? 0,
        categorie:   resultItem.type?.name?.fr ?? 'Inconnue',
        icone:       ICON_URL(resultItem.iconId),
        stats,
        ingredients,
    };
}

function buildMonsters(monsters, subareasMap, areasMap, itemsMap, dungeonsMap) {
    const result = new Array();

    // Dictionnaire pour faciliter la correspondance du nom de sous-zone avec un nom de donjon
    const dungeonNames = new Set();
    for (const d of dungeonsMap.values()) {
        if (d.name && d.name.fr) dungeonNames.add(d.name.fr.toLowerCase());
    }

    for (const m of monsters) {
        if (!m.name?.fr) continue;

        const drops = new Array();
        if (m.drops && m.drops.length > 0) {
            for (const d of m.drops) {
                const itemId = d.objectId || d.itemId;
                const rawTaux = d.percentDropForGrade1 || d.percentDrop || 0;
                const taux = roundTaux(rawTaux);

                if (itemId && taux > 0) {
                    const itemObj = itemsMap.get(itemId);
                    const isEquip = itemObj && itemObj.type && itemObj.type.categoryId === 0;

                    if (isEquip) {
                        drops.push({ id_itm: itemId, taux_drop: taux });
                    } else {
                        drops.push({ id_res: itemId, taux_drop: taux });
                    }
                }
            }
        }

        const zones_d_apparition = new Array();
        const possibleIds = new Set();
        
        if (m.favoriteSubAreas) m.favoriteSubAreas.forEach(id => possibleIds.add(id));
        if (m.subareas) m.subareas.forEach(id => possibleIds.add(id));
        if (m.subAreaIds) m.subAreaIds.forEach(id => possibleIds.add(id));

        for (const subId of possibleIds) {
            const sub = subareasMap.get(subId);
            const areaId = sub?.areaId;
            const area = areaId ? areasMap.get(areaId) : null;
            
            const nomSousZone = sub?.name?.fr ?? sub?.nameId?.fr ?? `Inconnue (${subId})`;
            const isDungeon = dungeonNames.has(nomSousZone.toLowerCase()) || nomSousZone.toLowerCase().includes('donjon');

            zones_d_apparition.push({
                id_sous_zone: subId,
                nom_sous_zone: nomSousZone,
                niveau: sub?.level ?? 0, // Ajout du niveau de la sous-zone
                id_zone: areaId ?? -1,
                nom_zone: area?.name?.fr ?? area?.nameId?.fr ?? `Inconnue (${areaId})`,
                est_donjon: isDungeon
            });
        }

        result.push({
            id_monstre: m.id,
            nom:        m.name.fr,
            isBoss:     m.isBoss ?? false,
            drops,
            zones_d_apparition
        });
    }

    return result;
}

/* =============================================================================
   POINT D'ENTRÉE
============================================================================= */

async function generateRecipesFile() {
    console.log('⏳ Étape 1 à 6 — Chargement des données (via API ou Cache)...');
    
    const items    = await fetchItemsAndSplitCache();
    const recipes  = await fetchWithCache('recipes');
    const effects  = await fetchWithCache('effects');
    const monsters = await fetchWithCache('monsters');
    const subareas = await fetchWithCache('subareas');
    const areas    = await fetchWithCache('areas');
    const dungeons = await fetchWithCache('dungeons');

    console.log('\n⏳ Étape 7 — Construction des index en mémoire...');
    const itemsMap    = buildIndex(items,    'id');
    const effectsMap  = buildIndex(effects,  'id');
    const subareasMap = buildIndex(subareas, 'id');
    const areasMap    = buildIndex(areas,    'id');
    const dungeonsMap = buildIndex(dungeons, 'id');
    const dropsMap    = buildDropsIndex(monsters);

    console.log('⏳ Étape 8 — Normalisation (équipements, ressources, effets, monstres, donjons)...');
    const equipements       = new Array();
    const ressourcesMap     = new Map();
    const effetsUtilisesMap = new Map();

    for (const recipe of recipes) {
        const equip = normalizeRecipe(
            recipe, itemsMap, effectsMap, ressourcesMap, effetsUtilisesMap, dropsMap
        );
        if (equip) equipements.push(equip);
    }

    const monstresNormalises = buildMonsters(monsters, subareasMap, areasMap, itemsMap, dungeonsMap);

    // ── Étape 9 — Écriture ────────────────────────────────────────
    console.log('⏳ Étape 9 — Écriture du fichier JSON final...');
    
    const finalData = {
        equipements,
        ressources: Array.from(ressourcesMap.values()),
        effets:     Array.from(effetsUtilisesMap.values()),
        monstres:   monstresNormalises
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalData, null, 2), 'utf-8');

    console.log(`\n🎉 SUCCÈS — ${OUTPUT_FILE} généré.`);
    console.log(`   ${equipements.length} équipements`);
    console.log(`   ${ressourcesMap.size} ressources uniques`);
    console.log(`   ${effetsUtilisesMap.size} effets uniques`);
    console.log(`   ${monstresNormalises.length} monstres`);
}

/* =============================================================================
   EXÉCUTION
============================================================================= */

generateRecipesFile().catch(err => {
    console.error('\n❌ Erreur fatale :', err.message);
    process.exit(1);
});