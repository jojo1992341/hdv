/**
 * @file constants.js
 * @description Constantes partagées entre app.js et admin.js.
 *
 * SOURCE OF TRUTH : Ce fichier est l'unique définition de EFFECT_MAPPING.
 * Ne jamais dupliquer ce dictionnaire dans d'autres fichiers.
 *
 * Chargement requis dans index.html et admin.html AVANT app.js et admin.js :
 *   <script src="constants.js"></script>
 */

/* =============================================================================
   EFFECT_MAPPING — Dictionnaire ID d'effet natif → { nom de rune, signe }
   =============================================================================
   Structure de chaque entrée :
     {
       name: string  — Nom de la caractéristique (ex: "PA", "Force", "% Critique")
       sign: 1 | -1  — 1 = bonus positif, -1 = malus
     }

   Les IDs proviennent du jeu DOFUS (API native).
   sign === -1 indique un effet négatif sur l'équipement (malus ou retrait).
============================================================================= */

const EFFECT_MAPPING = Object.freeze({

    // ── Points d'Action / Mouvement / Portée ────────────────────────────────
    111: { name: "PA",      sign:  1 },
    128: { name: "PM",      sign:  1 },
    117: { name: "Portée",  sign:  1 },
    182: { name: "Invocation", sign: 1 },

    101: { name: "PA",      sign: -1 },
    168: { name: "PA",      sign: -1 },
    127: { name: "PM",      sign: -1 },
    169: { name: "PM",      sign: -1 },
    116: { name: "Portée",  sign: -1 },
    2990: { name: "Invocation", sign: -1 },

    // ── Statistiques principales ─────────────────────────────────────────────
    118: { name: "Force",        sign:  1 },
    126: { name: "Intelligence", sign:  1 },
    123: { name: "Chance",       sign:  1 },
    119: { name: "Agilité",      sign:  1 },
    158: { name: "Pod",          sign:  1 },
    125: { name: "Vitalité",     sign:  1 },
    174: { name: "Initiative",   sign:  1 },
    124: { name: "Sagesse",      sign:  1 },
    176: { name: "Prospection",  sign:  1 },
    138: { name: "Puissance",    sign:  1 },
    178: { name: "Soin",         sign:  1 },
    115: { name: "% Critique",   sign:  1 },

    157: { name: "Force",        sign: -1 },
    155: { name: "Intelligence", sign: -1 },
    152: { name: "Chance",       sign: -1 },
    154: { name: "Agilité",      sign: -1 },
    159: { name: "Pod",          sign: -1 },
    153: { name: "Vitalité",     sign: -1 },
    175: { name: "Initiative",   sign: -1 },
    156: { name: "Sagesse",      sign: -1 },
    177: { name: "Prospection",  sign: -1 },
    179: { name: "Soin",         sign: -1 },
    171: { name: "% Critique",   sign: -1 },

    // ── Dommages généraux ────────────────────────────────────────────────────
    112:  { name: "Dommage",             sign:  1 },
    418:  { name: "Dommage Critiques",   sign:  1 },
    414:  { name: "Dommage Poussée",     sign:  1 },
    225:  { name: "Dommage Pièges",      sign:  1 },
    226:  { name: "Puissance Pièges",    sign:  1 },
    220:  { name: "Dommages Renvoyés",   sign:  1 },
    795:  { name: "Arme de chasse",      sign:  1 },

    419: { name: "Dommage Critiques",    sign: -1 },
    415: { name: "Dommage Poussée",      sign: -1 },

    // ── Dommages élémentaires ────────────────────────────────────────────────
    422: { name: "Dommage Terre",   sign:  1 },
    426: { name: "Dommage Eau",     sign:  1 },
    430: { name: "Dommage Neutre",  sign:  1 },
    424: { name: "Dommage Feu",     sign:  1 },
    428: { name: "Dommage Air",     sign:  1 },

    423: { name: "Dommage Terre",   sign: -1 },
    427: { name: "Dommage Eau",     sign: -1 },
    431: { name: "Dommage Neutre",  sign: -1 },
    425: { name: "Dommage Feu",     sign: -1 },
    429: { name: "Dommage Air",     sign: -1 },

    // ── Résistances fixes ────────────────────────────────────────────────────
    240: { name: "Résistance Terre",    sign:  1 },
    241: { name: "Résistance Eau",      sign:  1 },
    244: { name: "Résistance Neutre",   sign:  1 },
    243: { name: "Résistance Feu",      sign:  1 },
    242: { name: "Résistance Air",      sign:  1 },
    420: { name: "Résistance Critiques", sign: 1 },
    416: { name: "Résistance Poussée",  sign:  1 },

    246: { name: "Résistance Eau",       sign: -1 },
    421: { name: "Résistance Critiques", sign: -1 },
    417: { name: "Résistance Poussée",   sign: -1 },

    // ── Résistances % élémentaires ───────────────────────────────────────────
    210: { name: "% Résistance Terre",  sign:  1 },
    211: { name: "% Résistance Eau",    sign:  1 },
    214: { name: "% Résistance Neutre", sign:  1 },
    213: { name: "% Résistance Feu",    sign:  1 },
    212: { name: "% Résistance Air",    sign:  1 },

    215: { name: "% Résistance Terre",  sign: -1 },
    216: { name: "% Résistance Eau",    sign: -1 },
    219: { name: "% Résistance Neutre", sign: -1 },
    218: { name: "% Résistance Feu",    sign: -1 },
    217: { name: "% Résistance Air",    sign: -1 },

    // ── Dommages % (distance, mêlée, sorts, armes) ──────────────────────────
    2808: { name: "% Dommage d'armes",    sign:  1 },
    2804: { name: "% Dommage distance",   sign:  1 },
    2800: { name: "% Dommage mêlée",      sign:  1 },
    2812: { name: "% Dommage aux sorts",  sign:  1 },

    2805: { name: "% Dommage distance",   sign: -1 },
    2801: { name: "% Dommage mêlée",      sign: -1 },
    2813: { name: "% Dommage aux sorts",  sign: -1 },

    // ── Résistances % (distance, mêlée) ─────────────────────────────────────
    2807: { name: "% Résistance distance", sign:  1 },
    2803: { name: "% Résistance mêlée",    sign:  1 },

    2806: { name: "% Résistance distance", sign: -1 },
    2802: { name: "% Résistance mêlée",    sign: -1 },

    // ── Retrait / Esquive PA & PM ────────────────────────────────────────────
    412: { name: "Retrait PM",  sign:  1 },
    410: { name: "Retrait PA",  sign:  1 },
    161: { name: "Esquive PM",  sign:  1 },
    160: { name: "Esquive PA",  sign:  1 },

    413: { name: "Retrait PM",  sign: -1 },
    411: { name: "Retrait PA",  sign: -1 },
    163: { name: "Esquive PM",  sign: -1 },
    162: { name: "Esquive PA",  sign: -1 },

    // ── Tacle / Fuite ────────────────────────────────────────────────────────
    753: { name: "Tacle",  sign:  1 },
    752: { name: "Fuite",  sign:  1 },

    755: { name: "Tacle",  sign: -1 },
    754: { name: "Fuite",  sign: -1 },

});
