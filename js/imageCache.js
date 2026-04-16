/**
 * @file imageCache.js
 * @description Gestion du cache d'images et utilitaires DOM légers.
 *
 * Responsabilités de ce module :
 *   - Précharger toutes les icônes d'équipements et de ressources au démarrage
 *   - Mettre en cache les images distantes sous forme de blob URLs
 *   - Exposer un point d'accès unique aux URLs d'icônes (getIcon)
 *   - Masquer l'écran de chargement une fois le préchargement terminé
 *   - Fournir le helper DOM copyToClipboard
 *
 * Chargement requis dans index.html AVANT app.js :
 *   <script src="imageCache.js"></script>
 *
 * @depends Aucune dépendance sur les autres modules du projet.
 */

/* =============================================================================
   CONFIGURATION
============================================================================= */

/**
 * Nombre d'images téléchargées simultanément lors du préchargement.
 * Valeur empirique : équilibre entre vitesse et charge réseau.
 * @type {number}
 */
const BATCH_SIZE = 20;

/* =============================================================================
   CACHE PRIVÉ
   La Map est privée — on ne l'expose pas directement.
   Toute lecture doit passer par getIcon().
============================================================================= */

/** @type {Map<string, string>} URL originale → blob URL (ou URL originale en fallback) */
const _imageCache = new Map();

/* =============================================================================
   CHARGEMENT INITIAL
============================================================================= */

/**
 * Précharge en parallèle (par lots) toutes les icônes présentes dans
 * les données d'équipements et de ressources.
 *
 * Met à jour l'écran de chargement (barre de progression + compteur)
 * au fil du téléchargement.
 *
 * @param {Array<{icone?: string}>} equipements - Liste des équipements.
 * @param {Array<{icone?: string}>} ressources  - Liste des ressources.
 * @returns {Promise<void>}
 */
async function preloadAllImages(equipements, ressources) {
    const urls = _collectIconUrls(equipements, ressources);
    const total = urls.length;

    _initLoadingUI(total);

    let loaded = 0;

    for (let i = 0; i < total; i += BATCH_SIZE) {
        const batch = urls.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
            batch.map(url =>
                fetchImageBlob(url).then(() => {
                    loaded++;
                    _updateLoadingProgress(loaded, total);
                })
            )
        );
    }
}

/**
 * Collecte tous les URLs d'icônes uniques depuis les deux listes de données.
 *
 * @param {Array<{icone?: string}>} equipements
 * @param {Array<{icone?: string}>} ressources
 * @returns {string[]} Tableau d'URLs uniques.
 */
function _collectIconUrls(equipements, ressources) {
    const urls = new Set();
    equipements.forEach(e => { if (e.icone) urls.add(e.icone); });
    ressources.forEach(r => { if (r.icone) urls.add(r.icone); });
    return [...urls];
}

/**
 * Initialise l'affichage de l'écran de chargement avant le préchargement.
 *
 * @param {number} total - Nombre total d'images à charger.
 */
function _initLoadingUI(total) {
    const subtitleEl = document.querySelector('.loading-subtitle');
    const counterEl  = document.getElementById('loading-counter');

    if (subtitleEl) subtitleEl.textContent = 'Chargement des icônes...';
    if (counterEl)  counterEl.textContent  = `0 / ${total}`;
}

/**
 * Met à jour la barre de progression et le compteur de l'écran de chargement.
 *
 * @param {number} loaded - Nombre d'images chargées jusqu'ici.
 * @param {number} total  - Nombre total d'images.
 */
function _updateLoadingProgress(loaded, total) {
    const barFill   = document.getElementById('loading-bar-fill');
    const counterEl = document.getElementById('loading-counter');
    const pct       = Math.round((loaded / total) * 100);

    if (barFill)   barFill.style.width      = `${pct}%`;
    if (counterEl) counterEl.textContent    = `${loaded} / ${total}`;
}

/* =============================================================================
   FETCH & CACHE
============================================================================= */

/**
 * Télécharge une image distante et la convertit en blob URL pour la mettre
 * en cache. Les images locales (chemin relatif) sont stockées telles quelles.
 *
 * En cas d'échec réseau, l'URL originale est mise en cache comme fallback
 * pour éviter des requêtes répétées inutiles.
 *
 * @param {string} url - URL de l'image à charger.
 * @returns {Promise<string>} Blob URL mise en cache, ou URL originale en fallback.
 */
async function fetchImageBlob(url) {
    if (_imageCache.has(url)) return _imageCache.get(url);

    // Images locales : pas de fetch nécessaire, chemin relatif suffisant.
    if (!url.startsWith('http')) {
        _imageCache.set(url, url);
        return url;
    }

    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            console.warn(`[imageCache] Échec HTTP ${resp.status} pour : ${url}`);
            _imageCache.set(url, url);
            return url;
        }
        const blob    = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        _imageCache.set(url, blobUrl);
        return blobUrl;
    } catch (err) {
        console.warn(`[imageCache] Erreur réseau pour : ${url}`, err);
        _imageCache.set(url, url); // Fallback : URL originale
        return url;
    }
}

/**
 * Retourne l'URL mise en cache pour une icône donnée.
 * Si l'URL n'est pas en cache (ex : image non préchargée), retourne l'URL originale.
 *
 * C'est le SEUL point d'accès autorisé au cache d'images dans l'application.
 * Utiliser cette fonction dans tous les `<img src="...">` générés dynamiquement.
 *
 * @param {string} url - URL originale de l'icône.
 * @returns {string} Blob URL ou URL originale.
 */
function getIcon(url) {
    if (!url) return '';
    return _imageCache.get(url) ?? url;
}

/* =============================================================================
   ÉCRAN DE CHARGEMENT
============================================================================= */

/**
 * Masque l'écran de chargement avec une transition CSS,
 * puis le supprime du DOM une fois l'animation terminée.
 *
 * Doit être appelé après la résolution de preloadAllImages().
 */
function hideLoadingScreen() {
    const screen = document.getElementById('loading-screen');
    if (!screen) return;

    screen.classList.add('loading-done');
    screen.addEventListener('transitionend', () => screen.remove(), { once: true });
}

/* =============================================================================
   UTILITAIRE DOM — PRESSE-PAPIER
   Placé ici car utilitaire pur sans dépendance métier.
   À déplacer dans un utils.js si d'autres helpers DOM s'accumulent.
============================================================================= */

/**
 * Copie un texte dans le presse-papier et donne un retour visuel
 * temporaire sur l'élément DOM cible.
 *
 * Ne fait rien si l'API Clipboard n'est pas disponible (HTTP non sécurisé).
 *
 * @param {string}      text    - Texte à copier.
 * @param {HTMLElement} element - Élément qui reçoit le feedback visuel.
 */
function copyToClipboard(text, element) {
    if (!navigator.clipboard) return;

    const originalHTML = element.innerHTML;

    navigator.clipboard.writeText(text).then(() => {
        element.innerHTML = '✅ Copié !';
        element.classList.add('copied-feedback');

        setTimeout(() => {
            element.innerHTML = originalHTML;
            element.classList.remove('copied-feedback');
        }, 1200);
    });
}
