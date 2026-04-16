/**
 * @file farming.js
 * @description Onglet Farming — Classement des zones de farm par rentabilité.
 *
 * Philosophie : quantité > qualité.
 * On privilégie les zones avec le plus grand nombre de ressources droppables
 * et le meilleur revenu attendu par kill toutes ressources cumulées.
 *
 * @depends storage.js    — getAllPriceLots
 * @depends imageCache.js — getIcon
 */

'use strict';

/* =============================================================================
   CONFIGURATION
============================================================================= */

/** Nombre maximum de zones affichées dans le classement. @type {number} */
const FARMING_MAX_ZONES  = 50;

/** Nombre maximum de monstres détaillés par zone dans la vue étendue. @type {number} */
const FARMING_MAX_DETAIL = 10;

/* =============================================================================
   INITIALISATION
============================================================================= */

/**
 * Initialise l'onglet Farming.
 * Doit être appelée une fois depuis app.js.
 */
function setupFarming() {
    _populateLevelFilter();

    document.getElementById('btn-farming-compute')
        .addEventListener('click', _runFarmingAnalysis);
}

/**
 * Peuple le menu déroulant #farming-level-filter avec les niveaux
 * uniques trouvés dans zones_d_apparition de dbMonstres.
 * Trie les niveaux par ordre croissant.
 * @private
 */
function _populateLevelFilter() {
    const select = document.getElementById('farming-level-filter');
    if (!select) return;

    const levels = new Set();

    (dbMonstres || []).forEach(monstre => {
        (monstre.zones_d_apparition || []).forEach(zone => {
            if (zone.niveau != null && Number.isFinite(zone.niveau)) {
                levels.add(zone.niveau);
            }
        });
    });

    // Vide le select puis réinsère l'option "Tous"
    select.innerHTML = '<option value="">Tous les niveaux</option>';

    Array.from(levels)
        .sort((a, b) => a - b)
        .forEach(lvl => {
            const opt       = document.createElement('option');
            opt.value       = lvl;
            opt.textContent = `Niveau ${lvl}`;
            select.appendChild(opt);
        });
}

/* =============================================================================
   ALGORITHME PRINCIPAL
============================================================================= */

/**
 * Lance le calcul de rentabilité de farming et met à jour l'interface.
 * @private
 */
function _runFarmingAnalysis() {
    const btn        = document.getElementById('btn-farming-compute');
    const prospRaw   = parseFloat(document.getElementById('farming-prospection').value) || 100;
    const prosp      = Math.max(1, prospRaw);
    const minPrice   = parseFloat(document.getElementById('farming-min-price').value) || 0;
    const levelRaw   = document.getElementById('farming-level-filter')?.value ?? '';
    const levelFilter = levelRaw !== '' ? parseInt(levelRaw, 10) : null;

    btn.disabled    = true;
    btn.textContent = '⏳ Calcul en cours...';

    setTimeout(() => {
        const zones = _computeZoneRanking(prosp, minPrice, levelFilter);
        _renderZoneRanking(zones, prosp, levelFilter);

        btn.disabled    = false;
        btn.textContent = '⚔️ Calculer les meilleures zones';
    }, 50);
}

/**
 * Calcule le revenu attendu par kill pour chaque zone.
 *
 * Étapes :
 *   1. Parcourt dbMonstres, ignore ceux sans zones d'apparition.
 *   2. Pour chaque drop de type `id_res`, calcule le revenu attendu.
 *   3. Agrège par zone (id_sous_zone → zone) en ignorant les donjons basés sur dungeons.json.
 *   4. Si levelFilter est non null, n'inclut que les zones dont le niveau correspond.
 *
 * @param {number}      prosp        Prospection du joueur.
 * @param {number}      minPrice     Prix minimum (K) d'une ressource pour être comptée.
 * @param {number|null} levelFilter  Niveau exact à filtrer, ou null pour tout afficher.
 * @returns {Array<object>} Zones triées par revenu décroissant.
 */
function _computeZoneRanking(prosp, minPrice, levelFilter = null) {
    /** @type {Map<number, object>} id_sous_zone → zone aggregée */
    const zoneMap = new Map();

    if (!dbMonstres?.length) return new Array();

    // Crée un Set des noms de donjons en minuscules pour un filtrage exact
    const dungeonNames = new Set(
        (dbDungeons || new Array())
            .map(d => d.name?.fr?.toLowerCase() || '')
            .filter(Boolean)
    );

    dbMonstres.forEach(monstre => {
        if (!monstre.zones_d_apparition?.length) return;
        if (!monstre.drops?.length) return;

        // Calcule le revenu par kill pour ce monstre (ressources uniquement)
        let monsterRevenue = 0;
        const dropDetails  = new Array();

        monstre.drops.forEach(drop => {
            // On ne traite que les drops de ressources (id_res), pas d'équipements (id_itm)
            if (!drop.id_res) return;

            const price = _getResourcePrice(drop.id_res);
            if (!price || price < minPrice) return;

            const dropRate = drop.taux_drop ?? 0;

            // Calcul exact selon la formule demandée : prix * (drop / 100) * (prosp / 100)
            // Le taux effectif est plafonné à 100 % — au-delà, la ressource tombe à coup sûr.
            const effectivePct    = Math.min(100, dropRate * (prosp / 100));
            const expectedPerKill = effectivePct / 100;
            const kamasPerKill = price * expectedPerKill;

            if (kamasPerKill <= 0) return;

            monsterRevenue += kamasPerKill;
            dropDetails.push({
                id_res:    drop.id_res,
                taux_drop: dropRate,
                effective: effectivePct,
                price,
                kamasPerKill: kamasPerKill,
            });
        });

        if (monsterRevenue <= 0) return;

        // Ajoute ce monstre dans toutes ses zones d'apparition
        monstre.zones_d_apparition.forEach(zone => {
            const nomZone     = (zone.nom_zone     || '').toLowerCase();
            const nomSousZone = (zone.nom_sous_zone || '').toLowerCase();

            // Exclusion des donjons
            if (dungeonNames.has(nomZone) || dungeonNames.has(nomSousZone)) return;
            if (nomZone.includes('donjon') || nomSousZone.includes('donjon')) return;

            // Filtre par niveau : si un niveau est sélectionné, on ignore les zones hors plage
            if (levelFilter !== null && zone.niveau !== levelFilter) return;

            const key = zone.id_sous_zone;

            if (!zoneMap.has(key)) {
                zoneMap.set(key, {
                    id_sous_zone:  zone.id_sous_zone,
                    nom_sous_zone: zone.nom_sous_zone,
                    nom_zone:      zone.nom_zone,
                    niveau:        zone.niveau ?? null,
                    totalRevenue:  0,
                    monstreCount:  0,
                    resCount:      0,
                    monstres:      new Array(),
                    resIds:        new Set(),
                });
            }

            const z = zoneMap.get(key);
            z.totalRevenue += monsterRevenue;
            z.monstreCount++;

            dropDetails.forEach(d => z.resIds.add(d.id_res));
            z.resCount = z.resIds.size;

            z.monstres.push({
                id_monstre: monstre.id_monstre,
                nom:        monstre.nom,
                revenue:    monsterRevenue,
                drops:      dropDetails,
            });
        });
    });

    // Trie les monstres de chaque zone par revenue décroissant
    zoneMap.forEach(z => {
        z.monstres.sort((a, b) => b.revenue - a.revenue);
        delete z.resIds; // cleanup
    });

    // Retourne le tableau converti via Array.from au lieu de la syntaxe de décomposition interdite
    return Array.from(zoneMap.values())
        .sort((a, b) => b.totalRevenue - a.totalRevenue)
        .slice(0, FARMING_MAX_ZONES);
}

/**
 * Retourne le prix unitaire le plus bas d'une ressource parmi tous les lots disponibles.
 * Divise les prix de lots par leur taille pour obtenir le prix à l'unité.
 *
 * @param {number} resId
 * @returns {number} Prix le plus bas en K (0 si non renseigné).
 */
function _getResourcePrice(resId) {
    const lots = getAllPriceLots(resId);
    let minPrice = Infinity;

    if (lots.x1    != null && lots.x1    > 0) minPrice = Math.min(minPrice, lots.x1);
    if (lots.x10   != null && lots.x10   > 0) minPrice = Math.min(minPrice, lots.x10   / 10);
    if (lots.x100  != null && lots.x100  > 0) minPrice = Math.min(minPrice, lots.x100  / 100);
    if (lots.x1000 != null && lots.x1000 > 0) minPrice = Math.min(minPrice, lots.x1000 / 1000);

    return minPrice === Infinity ? 0 : minPrice;
}

/* =============================================================================
   RENDU
============================================================================= */

/**
 * Affiche le classement des zones dans le conteneur dédié.
 * @param {Array<object>} zones
 * @param {number}        prosp
 * @param {number|null}   levelFilter
 * @private
 */
function _renderZoneRanking(zones, prosp, levelFilter = null) {
    const container  = document.getElementById('farming-results');
    const levelLabel = levelFilter !== null ? ` · Niveau ${levelFilter}` : '';

    if (!zones.length) {
        container.innerHTML = `
            <div class="farming-empty">
                <p>Aucune zone calculable.<br>
                   Importez des prix via l'onglet Admin (📥 Importer des prix JSON)
                   et assurez-vous que le JSON de données contient les monstres.</p>
            </div>`;
        return;
    }

    const maxRevenue = zones[0].totalRevenue;
    const fmt = n => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

    const cards = zones.map((z, i) => {
        const barWidth  = Math.round((z.totalRevenue / maxRevenue) * 100);
        const rankClass = i === 0 ? 'rank-gold' : i === 1 ? 'rank-silver' : i === 2 ? 'rank-bronze' : '';
        const medal     = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;

        const topMonstres = z.monstres.slice(0, FARMING_MAX_DETAIL);

        const monstreRows = topMonstres.map(m => {
            const topDrops = m.drops
                .sort((a, b) => b.kamasPerKill - a.kamasPerKill)
                .slice(0, 4)
                .map(d => {
                    const res = dbResources.find(r => r.id_res === d.id_res);
                    return `<span class="farm-drop-badge" title="${res?.nom ?? '?'} — ${d.effective.toFixed(2)} % — ${fmt(d.price)} K/u">
                        ${res?.nom ?? `#${d.id_res}`} · ${fmt(d.kamasPerKill)} K/kill
                    </span>`;
                }).join('');

            return `<div class="farm-monstre-row">
                <span class="farm-monstre-name">${m.nom}</span>
                <span class="farm-monstre-revenue">${fmt(m.revenue)} K/kill</span>
                <div class="farm-drops">${topDrops}</div>
            </div>`;
        }).join('');

        const moreLabel = z.monstres.length > FARMING_MAX_DETAIL
            ? `<p class="farm-more">+ ${z.monstres.length - FARMING_MAX_DETAIL} monstre(s) supplémentaire(s)</p>`
            : '';

        return `
            <div class="farm-zone-card ${rankClass}">
                <div class="farm-zone-header">
                    <div class="farm-zone-rank">${medal}</div>
                    <div class="farm-zone-info">
                        <div class="farm-zone-name">${z.nom_sous_zone}${z.niveau != null ? ` <span class="farm-zone-level">Niv. ${z.niveau}</span>` : ''}</div>
                        <div class="farm-zone-parent">${z.nom_zone}</div>
                    </div>
                    <div class="farm-zone-stats">
                        <div class="farm-stat">
                            <span class="farm-stat-value">${fmt(z.totalRevenue)} K</span>
                            <span class="farm-stat-label">K/kill (somme zone)</span>
                        </div>
                        <div class="farm-stat">
                            <span class="farm-stat-value">${z.monstreCount}</span>
                            <span class="farm-stat-label">monstres</span>
                        </div>
                        <div class="farm-stat">
                            <span class="farm-stat-value">${z.resCount}</span>
                            <span class="farm-stat-label">ressources</span>
                        </div>
                    </div>
                </div>
                <div class="farm-zone-bar-track">
                    <div class="farm-zone-bar" style="width: ${barWidth}%"></div>
                </div>
                <div class="farm-monstres">
                    ${monstreRows}
                    ${moreLabel}
                </div>
            </div>`;
    }).join('');

    container.innerHTML = `
        <div class="farming-results-header">
            <h4>⚔️ Classement des zones — Prospection ${prosp}${levelLabel} · ${zones.length} zone(s)</h4>
            <p class="farming-results-note">
                Le revenu K/kill est la somme théorique attendue si vous tuez <em>tous</em> les monstres
                de la zone une fois.
            </p>
        </div>
        ${cards}`;
}