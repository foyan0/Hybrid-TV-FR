const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');

const app = express();
app.use(cors());

let isUpdatingEPG = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let epgData = {}; 
let channelsCache = {}; 

const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

// La Blacklist : Suppression totale des chaînes parasites et VOD déguisées
const BLACKLIST = [
    'ALACARTE', 'DISNEYPLUS', 'NETFLIX', 'PRIMEVIDEO', 'APPLETV',
    'MULTISPORTS', 'TEST', 'MIRROR', 'BACKUPCHANNEL', 'EVENEMENT', 'LIVEEVENT', 'BOXOFFICE1', 'BOXOFFICE2', 'CANALPLAY'
];

function parseConfig(encodedConfig) {
    try {
        if (!encodedConfig || encodedConfig === 'manifest.json') return { sources: [], epg: true };
        const jsonStr = Buffer.from(encodedConfig, 'base64').toString('utf8');
        return JSON.parse(jsonStr);
    } catch (e) {
        return { sources: [], epg: true };
    }
}

// === LE MOTEUR DE DICTIONNAIRE ABSOLU ===
// Crée un ADN unique pour chaque chaîne pour une fusion et un classement sans erreur
function getChannelData(rawName) {
    if (!rawName) return null;
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    // Nettoyage radical : on supprime les crochets, parenthèses et préfixes inutiles
    n = n.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ');
    n = n.replace(/^(FR|BE|CH|CA|VIP)\s*[:|/-]+\s*/i, '');
    n = n.replace(/DURING EVENT ONLY/g, '').replace(/EVENT ONLY/g, '');

    // Suppression des balises de qualité (On NE TOUCHE PAS au mot FRANCE ou FR ici pour ne pas casser France 2 !)
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'DIRECT', 'RAW', 'ACCESS'];
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'gi'), ''); });
    
    // L'ADN de la chaîne
    let c = n.replace(/[^A-Z0-9]/g, '');
    if (!c || c.length < 2) return null;

    // Éjection immédiate si la chaîne est blacklistée
    if (BLACKLIST.some(b => c.includes(b))) return null;

    // --- LE DICTIONNAIRE COMPLET (Zéro perte) ---

    // 1. TNT ET GENERALISTES
    if (c.startsWith('TF1')) {
        if (c.includes('SERIE') || c.includes('FILM')) return { id: 'hyb_tnt_20', name: 'TF1 Séries Films', category: 'tnt', index: 20 };
        return { id: 'hyb_tnt_1', name: 'TF1', category: 'tnt', index: 1 };
    }
    if (c.startsWith('FRANCE2')) return { id: 'hyb_tnt_2', name: 'France 2', category: 'tnt', index: 2 };
    if (c.startsWith('FRANCE3')) return { id: 'hyb_tnt_3', name: 'France 3', category: 'tnt', index: 3 };
    if (c.startsWith('FRANCE4')) return { id: 'hyb_tnt_4', name: 'France 4', category: 'tnt', index: 4 };
    if (c.startsWith('FRANCE5')) return { id: 'hyb_tnt_5', name: 'France 5', category: 'tnt', index: 5 };
    if (c.startsWith('M6')) {
        if (c.includes('MUSIC')) return { id: 'hyb_mus_m6', name: 'M6 Music', category: 'musique', index: 1 };
        if (c.includes('INTERN')) return { id: 'hyb_tnt_6_int', name: 'M6 International', category: 'tnt', index: 6 };
        return { id: 'hyb_tnt_6', name: 'M6', category: 'tnt', index: 6 };
    }
    if (c.startsWith('ARTE')) return { id: 'hyb_tnt_7', name: 'Arte', category: 'tnt', index: 7 };
    if (c.startsWith('C8')) return { id: 'hyb_tnt_8', name: 'C8', category: 'tnt', index: 8 };
    if (c.startsWith('W9')) return { id: 'hyb_tnt_9', name: 'W9', category: 'tnt', index: 9 };
    if (c.startsWith('TMC')) return { id: 'hyb_tnt_10', name: 'TMC', category: 'tnt', index: 10 };
    if (c.startsWith('TFX')) return { id: 'hyb_tnt_11', name: 'TFX', category: 'tnt', index: 11 };
    if (c.startsWith('NRJ12') || c.startsWith('NRJ')) {
        if (c.includes('HIT')) return { id: 'hyb_mus_nrj', name: 'NRJ Hits', category: 'musique', index: 2 };
        return { id: 'hyb_tnt_12', name: 'NRJ 12', category: 'tnt', index: 12 };
    }
    if (c.includes('LCP') || c.includes('PUBLICSENAT')) return { id: 'hyb_tnt_13', name: 'LCP / Public Sénat', category: 'tnt', index: 13 };
    if (c.includes('GULLI')) return { id: 'hyb_tnt_18', name: 'Gulli', category: 'tnt', index: 18 };
    if (c.includes('6TER')) return { id: 'hyb_tnt_22', name: '6ter', category: 'tnt', index: 22 };
    if (c.includes('RMCSTORY') || c.includes('NUMERO23')) return { id: 'hyb_tnt_23', name: 'RMC Story', category: 'tnt', index: 23 };
    if (c.includes('RMCDECOUVERTE')) return { id: 'hyb_tnt_24', name: 'RMC Découverte', category: 'tnt', index: 24 };
    if (c.includes('CHERIE25') || c === 'CHERIE') return { id: 'hyb_tnt_25', name: 'Chérie 25', category: 'tnt', index: 25 };
    if (c.includes('13EMERUE') || c.includes('13RUE')) return { id: 'hyb_tnt_13rue', name: '13ème Rue', category: 'tnt', index: 30 };
    if (c.includes('TEVA')) return { id: 'hyb_tnt_teva', name: 'Téva', category: 'tnt', index: 31 };
    if (c.includes('RTL9')) return { id: 'hyb_tnt_rtl9', name: 'RTL9', category: 'tnt', index: 32 };
    if (c.includes('AB1')) return { id: 'hyb_tnt_ab1', name: 'AB1', category: 'tnt', index: 33 };
    if (c.includes('AB3')) return { id: 'hyb_tnt_ab3', name: 'AB3', category: 'tnt', index: 34 };
    if (c.includes('ABXPLORE') || c.includes('ABEXPLORE')) return { id: 'hyb_tnt_abx', name: 'ABXplore', category: 'tnt', index: 35 };
    if (c.includes('RTSUN') || c.includes('RTS1') || c.includes('RTSUNE')) return { id: 'hyb_tnt_rts1', name: 'RTS Un', category: 'tnt', index: 40 };
    if (c.includes('RTSDEUX') || c.includes('RTS2')) return { id: 'hyb_tnt_rts2', name: 'RTS Deux', category: 'tnt', index: 41 };
    if (c.includes('LAUNE')) return { id: 'hyb_tnt_laune', name: 'La Une', category: 'tnt', index: 42 };
    if (c.includes('LADEUX') || c.includes('TIPIK')) return { id: 'hyb_tnt_tipik', name: 'Tipik', category: 'tnt', index: 43 };
    if (c.includes('LATROIS')) return { id: 'hyb_tnt_latrois', name: 'La Trois', category: 'tnt', index: 44 };
    if (c.includes('COMEDIE')) return { id: 'hyb_tnt_comedie', name: 'Comédie+', category: 'tnt', index: 45 };

    // 2. INFORMATION
    if (c.includes('BFM')) {
        if (c.includes('BUSINESS')) return { id: 'hyb_info_bfmbiz', name: 'BFM Business', category: 'info', index: 11 };
        return { id: 'hyb_info_1', name: 'BFMTV', category: 'info', index: 1 };
    }
    if (c.includes('CNEWS') || c === 'CNEW') return { id: 'hyb_info_2', name: 'CNews', category: 'info', index: 2 };
    if (c.includes('LCI')) return { id: 'hyb_info_3', name: 'LCI', category: 'info', index: 3 };
    if (c.includes('FRANCEINFO')) return { id: 'hyb_info_4', name: 'France Info', category: 'info', index: 4 };
    if (c.includes('FRANCE24')) return { id: 'hyb_info_5', name: 'France 24', category: 'info', index: 5 };
    if (c.includes('METEO')) return { id: 'hyb_info_6', name: 'La Chaîne Météo', category: 'info', index: 6 };
    if (c.includes('EURONEWS')) return { id: 'hyb_info_7', name: 'Euronews', category: 'info', index: 7 };
    if (c.includes('LCN')) return { id: 'hyb_info_8', name: 'LCN', category: 'info', index: 8 };
    if (c.includes('20MINUTES')) return { id: 'hyb_info_9', name: '20 Minutes TV', category: 'info', index: 9 };
    if (c.includes('AFRICA24')) return { id: 'hyb_info_af24', name: 'Africa 24', category: 'info', index: 10 };
    if (c.includes('CGTN')) return { id: 'hyb_info_cgtn', name: 'CGTN', category: 'info', index: 11 };
    if (c.includes('I24')) return { id: 'hyb_info_i24', name: 'I24 News', category: 'info', index: 12 };
    if (c.includes('RTFRANCE')) return { id: 'hyb_info_rtfr', name: 'RT France', category: 'info', index: 13 };
    if (c.includes('TECHCO') || c.includes('01TV')) return { id: 'hyb_info_techco', name: 'Tech & Co', category: 'info', index: 14 };
    if (c.includes('TV5')) {
        if (c.includes('EUROPE')) return { id: 'hyb_info_tv5eur', name: 'TV5 Monde Europe', category: 'info', index: 15 };
        if (c.includes('INFO')) return { id: 'hyb_info_tv5inf', name: 'TV5 Monde Info', category: 'info', index: 16 };
        return { id: 'hyb_info_tv5', name: 'TV5 Monde', category: 'info', index: 18 };
    }

    // 3. SPORTS
    if (c.includes('DAZN') || c.includes('LIGUE1') || c.includes('PASSLIGUE') || c.includes('LEAUGE1')) {
        let isLive = c.includes('LIVE') || c.includes('LIGUE1') || c.includes('PASS') || c.includes('LEAUGE');
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        if (parseInt(num) > 8) return null; // Coupe les canaux vides
        if (isLive) return { id: 'hyb_sport_daznlive'+num, name: 'DAZN Ligue 1 - Live '+num, category: 'sports', index: 10 + parseInt(num) };
        return { id: 'hyb_sport_dazn'+num, name: 'DAZN '+num, category: 'sports', index: 30 + parseInt(num) };
    }
    if (c.includes('BEINSPORT') || c.includes('BEIN')) {
        let isMax = c.includes('MAX');
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        return { id: 'hyb_sport_bein' + (isMax?'max':'') + num, name: isMax ? 'beIN SPORTS MAX '+num : 'beIN SPORTS '+num, category: 'sports', index: isMax ? 60 + parseInt(num) : 50 + parseInt(num) };
    }
    if (c.includes('RMCSPORT')) {
        let isLive = c.includes('LIVE');
        let isAccess = c.includes('ACCESS');
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        if (isLive) return { id: 'hyb_sport_rmclive'+num, name: 'RMC Sport Live '+num, category: 'sports', index: 100 + parseInt(num) };
        if (isAccess) return { id: 'hyb_sport_rmcaccess'+num, name: 'RMC Sport Access '+num, category: 'sports', index: 110 + parseInt(num) };
        return { id: 'hyb_sport_rmc'+num, name: 'RMC Sport '+num, category: 'sports', index: 90 + parseInt(num) };
    }
    if (c.includes('EUROSPORT')) {
        let is360 = c.includes('360');
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        if (is360) return { id: 'hyb_sport_euro360_'+num, name: 'Eurosport 360 - '+num, category: 'sports', index: 130 + parseInt(num) };
        return { id: 'hyb_sport_euro'+num, name: 'Eurosport '+num, category: 'sports', index: 120 + parseInt(num) };
    }
    if (c.includes('CANAL') && (c.includes('SPORT') || c.includes('FOOT') || c.includes('FORMULA1') || c.includes('MOTOGP') || c.includes('PREMIERLEAGUE') || c.includes('TOP14'))) {
        if (c.includes('SPORT360')) return { id: 'hyb_sport_cplussport360', name: 'Canal+ Sport 360', category: 'sports', index: 152 };
        if (c.includes('FOOT')) return { id: 'hyb_sport_cplusfoot', name: 'Canal+ Foot', category: 'sports', index: 151 };
        if (c.includes('FORMULA1') || c.includes('F1')) return { id: 'hyb_sport_cplusf1', name: 'Canal+ Formula 1', category: 'sports', index: 153 };
        if (c.includes('MOTOGP')) return { id: 'hyb_sport_cplusmoto', name: 'Canal+ MotoGP', category: 'sports', index: 154 };
        if (c.includes('PREMIERLEAGUE')) return { id: 'hyb_sport_cpluspl', name: 'Canal+ Premier League', category: 'sports', index: 155 };
        if (c.includes('TOP14')) return { id: 'hyb_sport_cplustop14', name: 'Canal+ Top 14', category: 'sports', index: 156 };
        return { id: 'hyb_sport_cplussport', name: 'Canal+ Sport', category: 'sports', index: 150 };
    }
    if (c.includes('ELEVENSPORT')) {
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        return { id: 'hyb_sport_eleven'+num, name: 'Eleven Sports '+num, category: 'sports', index: 185 + parseInt(num) };
    }
    if (c.includes('LEQUIPE') || c === 'LEQUIPETV') return { id: 'hyb_sport_lequipe', name: "L'Équipe", category: 'sports', index: 160 };
    if (c.includes('OLTV') || c.includes('OLPLAY')) return { id: 'hyb_sport_oltv', name: 'OLTV', category: 'sports', index: 170 };
    if (c.includes('AUTOMOTO')) return { id: 'hyb_sport_automoto', name: 'Automoto', category: 'sports', index: 180 };
    if (c.includes('GOLF')) return { id: 'hyb_sport_golf', name: 'Golf Channel', category: 'sports', index: 181 };
    if (c.includes('EQUIDIA')) return { id: 'hyb_sport_equidia', name: 'Equidia', category: 'sports', index: 182 };
    if (c.includes('INFOSPORT')) return { id: 'hyb_sport_infosport', name: 'Infosport+', category: 'sports', index: 183 };
    if (c.includes('SPORTENFRANCE')) return { id: 'hyb_sport_sportenfrance', name: 'Sport En France', category: 'sports', index: 184 };

    // 4. CINE+ ET CINEMA
    if (c.includes('CINE') || c.includes('CINA')) {
        if (c.includes('PREMIER')) return { id: 'hyb_cine_premier', name: 'Ciné+ Premier', category: 'cinema', index: 11 };
        if (c.includes('FRISSON') || c.includes('ISSON')) return { id: 'hyb_cine_frisson', name: 'Ciné+ Frisson', category: 'cinema', index: 12 };
        if (c.includes('EMOTION')) return { id: 'hyb_cine_emotion', name: 'Ciné+ Émotion', category: 'cinema', index: 13 };
        if (c.includes('FAMIZ')) return { id: 'hyb_cine_famiz', name: 'Ciné+ Famiz', category: 'cinema', index: 14 };
        if (c.includes('CLUB') && !c.includes('SERIE')) return { id: 'hyb_cine_club', name: 'Ciné+ Club', category: 'cinema', index: 15 };
        if (c.includes('CLASSIC')) return { id: 'hyb_cine_classic', name: 'Ciné+ Classic', category: 'cinema', index: 16 };
        if (c.includes('MAX')) return { id: 'hyb_cine_max', name: 'Ciné+ Max', category: 'cinema', index: 17 };
        if (c.includes('STAR')) {
            if (c.includes('HIT')) return { id: 'hyb_mus_cstar', name: 'CStar Hits', category: 'musique', index: 8 };
            return { id: 'hyb_tnt_17', name: 'CStar', category: 'tnt', index: 17 }; // CSTAR !
        }
        if (c.includes('ACTION')) return { id: 'hyb_cine_action', name: 'Action', category: 'cinema', index: 30 };
        return { id: 'hyb_cine_plus', name: 'Ciné+', category: 'cinema', index: 19 };
    }

    if (c.includes('ACTION')) return { id: 'hyb_cine_action', name: 'Action', category: 'cinema', index: 30 };
    if (c.includes('POLAR')) return { id: 'hyb_cine_polar', name: 'Polar+', category: 'cinema', index: 31 };
    if (c.includes('PARAMOUNT')) {
        if (c.includes('DECALE')) return { id: 'hyb_cine_paramountdecale', name: 'Paramount Channel Décalé', category: 'cinema', index: 33 };
        return { id: 'hyb_cine_paramount', name: 'Paramount Channel', category: 'cinema', index: 32 };
    }
    if (c.includes('TCM')) return { id: 'hyb_cine_tcm', name: 'TCM Cinéma', category: 'cinema', index: 34 };
    if (c.includes('WARNER')) return { id: 'hyb_cine_warner', name: 'Warner TV', category: 'cinema', index: 35 };
    if (c.includes('SYFY') || c.includes('SCIFI')) return { id: 'hyb_cine_syfy', name: 'Syfy', category: 'cinema', index: 36 };
    if (c.includes('SERIECLUB')) return { id: 'hyb_cine_serieclub', name: 'Série Club', category: 'cinema', index: 37 };
    if (c.includes('TVBREIZH')) return { id: 'hyb_cine_tvbreizh', name: 'TV Breizh', category: 'cinema', index: 38 };
    if (c.includes('COMEDY')) return { id: 'hyb_cine_comedy', name: 'Comedy Central', category: 'cinema', index: 39 };
    if (c.includes('OCS')) {
        if (c.includes('MAX')) return { id: 'hyb_cine_ocsmax', name: 'OCS Max', category: 'cinema', index: 40 };
        if (c.includes('CHOC')) return { id: 'hyb_cine_ocschoc', name: 'OCS Choc', category: 'cinema', index: 41 };
        if (c.includes('GEANT') || c.includes('GEANET')) return { id: 'hyb_cine_ocsgeant', name: 'OCS Géants', category: 'cinema', index: 42 };
        if (c.includes('CITY')) return { id: 'hyb_cine_ocscity', name: 'OCS City', category: 'cinema', index: 43 };
        return { id: 'hyb_cine_ocs', name: 'OCS', category: 'cinema', index: 44 };
    }
    if (c.includes('ALTICE')) return { id: 'hyb_cine_altice', name: 'Altice Studio', category: 'cinema', index: 45 };

    // 5. CANAL+ (BOUQUET GENERAL)
    if (c.includes('CANAL') && !c.includes('CANALJ') && !c.includes('CANALD') && !c.includes('SAVOIR') && !c.includes('ALPHA')) {
        if (c.includes('CINEMA') || c.includes('CNEMA')) return { id: 'hyb_canal_cinema', name: 'Canal+ Cinéma', category: 'canal', index: 2 };
        if (c.includes('GRANDECRAN')) return { id: 'hyb_canal_grandecran', name: 'Canal+ Grand Écran', category: 'canal', index: 3 };
        if (c.includes('SERIES')) return { id: 'hyb_canal_series', name: 'Canal+ Séries', category: 'canal', index: 4 };
        if (c.includes('BOXOFFICE')) return { id: 'hyb_canal_boxoffice', name: 'Canal+ Box Office', category: 'canal', index: 5 };
        if (c.includes('DOC')) return { id: 'hyb_canal_docs', name: 'Canal+ Docs', category: 'canal', index: 11 };
        if (c.includes('KIDS')) return { id: 'hyb_canal_kids', name: 'Canal+ Kids', category: 'canal', index: 12 };
        if (c.includes('DECALE')) return { id: 'hyb_canal_decale', name: 'Canal+ Décalé', category: 'canal', index: 13 };
        if (c.includes('FAMILY')) return { id: 'hyb_canal_family', name: 'Canal+ Family', category: 'canal', index: 14 };
        if (c.includes('FILM')) return { id: 'hyb_canal_film', name: 'Canal+ Film', category: 'canal', index: 15 };
        if (c.includes('ELLES')) return { id: 'hyb_canal_elles', name: 'Canal+ Elles', category: 'canal', index: 16 };
        if (c.includes('ULTRA') || c.includes('4K')) return { id: 'hyb_canal_ultra', name: 'Canal+ UHD', category: 'canal', index: 17 };
        return { id: 'hyb_canal_cplus', name: 'Canal+', category: 'canal', index: 1 };
    }

    // 6. DECOUVERTE
    if (c.includes('NATGEO') || c.includes('NATIONALGEO')) {
        if (c.includes('WILD')) return { id: 'hyb_dec_natgeowild', name: 'Nat Geo Wild', category: 'decouverte', index: 2 };
        return { id: 'hyb_dec_natgeo', name: 'National Geographic', category: 'decouverte', index: 1 };
    }
    if (c.includes('PLANET')) {
        if (c.includes('CRIME') || c.includes('CI') || c.includes('JUSTICE')) return { id: 'hyb_dec_planetecrime', name: 'Planète+ Crime', category: 'decouverte', index: 11 };
        if (c.includes('AVENTURE') || c.includes('AE')) return { id: 'hyb_dec_planeteaventure', name: 'Planète+ Aventure', category: 'decouverte', index: 12 };
        return { id: 'hyb_dec_planete', name: 'Planète+', category: 'decouverte', index: 10 };
    }
    if (c.includes('DISCOVERY')) {
        if (c.includes('SCIENCE')) return { id: 'hyb_dec_discoveryscience', name: 'Discovery Science', category: 'decouverte', index: 21 };
        if (c.includes('ID') || c.includes('INVESTIGATION')) return { id: 'hyb_dec_discoveryid', name: 'Discovery Investigation', category: 'decouverte', index: 22 };
        return { id: 'hyb_dec_discovery', name: 'Discovery Channel', category: 'decouverte', index: 20 };
    }
    if (c.includes('USHUAIA')) return { id: 'hyb_dec_ushuaia', name: 'Ushuaïa TV', category: 'decouverte', index: 30 };
    if (c.includes('HISTOIRE')) {
        if (c.includes('TOUTE')) return { id: 'hyb_dec_toutehistoire', name: "Toute L'Histoire", category: 'decouverte', index: 31 };
        return { id: 'hyb_dec_histoire', name: 'Histoire TV', category: 'decouverte', index: 32 };
    }
    if (c.includes('ANIMAUX')) return { id: 'hyb_dec_animaux', name: 'Animaux', category: 'decouverte', index: 33 };
    if (c.includes('CHASSE') || c.includes('PECHE')) return { id: 'hyb_dec_chasse', name: 'Chasse et Pêche', category: 'decouverte', index: 34 };
    if (c.includes('TREK')) return { id: 'hyb_dec_trek', name: 'Trek', category: 'decouverte', index: 35 };
    if (c.includes('SEASON')) return { id: 'hyb_dec_seasons', name: 'Seasons', category: 'decouverte', index: 36 };
    if (c.includes('CRIMEDISTRICT')) return { id: 'hyb_dec_crime', name: 'Crime District', category: 'decouverte', index: 37 };
    if (c.includes('SCIENCE')) return { id: 'hyb_dec_science', name: 'Science & Vie TV', category: 'decouverte', index: 38 };

    // 7. JEUNESSE
    if (c.includes('CARTOON')) return { id: 'hyb_jeu_cartoon', name: 'Cartoon Network', category: 'jeunesse', index: 1 };
    if (c.includes('BOOMERANG')) return { id: 'hyb_jeu_boom', name: 'Boomerang', category: 'jeunesse', index: 2 };
    if (c.includes('BOING') || c.includes('BOEING')) return { id: 'hyb_jeu_boing', name: 'Boing', category: 'jeunesse', index: 3 };
    if (c.includes('DISNEY')) {
        if (c.includes('JR') || c.includes('JUNIOR')) return { id: 'hyb_jeu_disneyjr', name: 'Disney Junior', category: 'jeunesse', index: 11 };
        if (c.includes('XD')) return { id: 'hyb_jeu_disneyxd', name: 'Disney XD', category: 'jeunesse', index: 12 };
        if (c.includes('CINEMA') || c.includes('MAGIC')) return { id: 'hyb_jeu_disneycinema', name: 'Disney Cinéma', category: 'jeunesse', index: 13 };
        return { id: 'hyb_jeu_disney', name: 'Disney Channel', category: 'jeunesse', index: 10 };
    }
    if (c.includes('NICKELODEON') || c.includes('NICK')) {
        if (c.includes('TEEN') || c.includes('4TEEN')) return { id: 'hyb_jeu_nickteen', name: 'Nickelodeon Teen', category: 'jeunesse', index: 21 };
        if (c.includes('JR') || c.includes('JUNIOR')) return { id: 'hyb_jeu_nickjr', name: 'Nickelodeon Junior', category: 'jeunesse', index: 22 };
        if (c.includes('TOON')) return { id: 'hyb_jeu_nicktoons', name: 'Nicktoons', category: 'jeunesse', index: 23 };
        return { id: 'hyb_jeu_nick', name: 'Nickelodeon', category: 'jeunesse', index: 20 };
    }
    if (c.includes('GAMEONE') || c.includes('G1')) return { id: 'hyb_jeu_gameone', name: 'Game One', category: 'jeunesse', index: 30 };
    if (c.includes('JONE')) return { id: 'hyb_jeu_jone', name: 'J-One', category: 'jeunesse', index: 31 };
    if (c.includes('CANALJ')) return { id: 'hyb_jeu_canalj', name: 'Canal J', category: 'jeunesse', index: 32 };
    if (c.includes('TIJI')) return { id: 'hyb_jeu_tiji', name: 'Tiji', category: 'jeunesse', index: 33 };
    if (c.includes('TELETOON')) return { id: 'hyb_jeu_teletoon', name: 'Télétoon+', category: 'jeunesse', index: 34 };
    if (c.includes('PIWI')) return { id: 'hyb_jeu_piwi', name: 'Piwi+', category: 'jeunesse', index: 35 };
    if (c.includes('MANGAS')) return { id: 'hyb_jeu_mangas', name: 'Mangas', category: 'jeunesse', index: 36 };
    if (c.includes('TOONAMI')) return { id: 'hyb_jeu_toonami', name: 'Toonami', category: 'jeunesse', index: 37 };
    if (c.includes('BABYTV')) return { id: 'hyb_jeu_baby', name: 'Baby TV', category: 'jeunesse', index: 38 };
    if (c.includes('GONG')) {
        if (c.includes('MAX')) return { id: 'hyb_jeu_gongmax', name: 'Gong Max', category: 'jeunesse', index: 40 };
        return { id: 'hyb_jeu_gong', name: 'Gong', category: 'jeunesse', index: 39 };
    }

    // 8. MUSIQUE
    if (c.includes('CSTAR') && c.includes('HIT')) return { id: 'hyb_mus_cstar', name: 'CStar Hits', category: 'musique', index: 8 };
    if (c.includes('MTV')) {
        if (c.includes('HIT')) return { id: 'hyb_mus_mtvhits', name: 'MTV Hits', category: 'musique', index: 11 };
        if (c.includes('80')) return { id: 'hyb_mus_mtv80', name: 'MTV 80s', category: 'musique', index: 12 };
        if (c.includes('90')) return { id: 'hyb_mus_mtv90', name: 'MTV 90s', category: 'musique', index: 13 };
        return { id: 'hyb_mus_mtv', name: 'MTV', category: 'musique', index: 10 };
    }
    if (c.includes('TRACE')) {
        if (c.includes('AFRICA')) return { id: 'hyb_mus_traceaf', name: 'Trace Africa', category: 'musique', index: 31 };
        if (c.includes('CARIBBEAN')) return { id: 'hyb_mus_traceca', name: 'Trace Caribbean', category: 'musique', index: 32 };
        return { id: 'hyb_mus_trace', name: 'Trace Urban', category: 'musique', index: 30 };
    }
    if (c.includes('MCM')) {
        if (c.includes('POP')) return { id: 'hyb_mus_mcmpop', name: 'MCM Pop', category: 'musique', index: 41 };
        if (c.includes('TOP')) return { id: 'hyb_mus_mcmtop', name: 'MCM Top', category: 'musique', index: 42 };
        return { id: 'hyb_mus_mcm', name: 'MCM', category: 'musique', index: 40 };
    }
    if (c.includes('MEZZO')) {
        if (c.includes('LIVE')) return { id: 'hyb_mus_mezzolive', name: 'Mezzo Live', category: 'musique', index: 51 };
        return { id: 'hyb_mus_mezzo', name: 'Mezzo', category: 'musique', index: 50 };
    }
    if (c.includes('MELODY')) return { id: 'hyb_mus_melody', name: 'Melody', category: 'musique', index: 60 };
    if (c.includes('RFMTV')) return { id: 'hyb_mus_rfmtv', name: 'RFM TV', category: 'musique', index: 61 };

    // 9. AUTRES (Sécurité : Ce qui passe les filtres mais n'est pas identifié)
    let prettyName = rawName.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\b(?:FHD|HD|SD|4K|1080P|720P)\b/gi, '').trim();
    prettyName = prettyName.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
    
    return { id: 'hyb_id_' + c, name: prettyName, category: 'autres', index: 500 };
}

// Fonction utilitaire pour synchroniser l'EPG
function toSyncId(rawName) {
    if (!rawName) return '';
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return n.replace(/[^A-Z0-9]/g, ''); 
}

function parseXmltvDate(str) {
    if (!str || str.length < 14) return 0;
    const y = str.substring(0,4), m = str.substring(4,6), d = str.substring(6,8);
    const h = str.substring(8,10), min = str.substring(10,12), s = str.substring(12,14);
    let offset = str.substring(15).trim() || '+0200';
    if (!offset.includes(':') && offset.length >= 5) offset = offset.slice(0,3) + ':' + offset.slice(3);
    else if (offset.length < 5) offset = '+02:00';
    const ts = new Date(`${y}-${m}-${d}T${h}:${min}:${s}${offset}`).getTime();
    return isNaN(ts) ? 0 : ts;
}

function formatTime(timestamp) {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)).replace(':', 'h');
}

async function fetchAndParseEPG(url, isGz) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await axios.get(url, { responseType: 'stream', timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            let stream = response.data;
            if (isGz) { const unzip = zlib.createGunzip(); stream = stream.pipe(unzip); }

            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
            let localChannels = {}; let localEpg = {};      
            let inChannel = false, chanBlock = '';
            let inProgramme = false, progBlock = '';

            rl.on('line', (line) => {
                if (line.includes('<desc') || line.includes('<icon')) return;

                if (line.includes('<channel ')) { inChannel = true; chanBlock = line; }
                else if (inChannel) { chanBlock += '\n' + line; }
                
                if (inChannel && chanBlock.includes('</channel>')) {
                    const idM = chanBlock.match(/id=["']([^"']+)["']/);
                    const nameM = chanBlock.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
                    if (idM && nameM) {
                        let cData = getChannelData(nameM[1]);
                        if (cData) localChannels[idM[1]] = cData.id; 
                    }
                    inChannel = false; chanBlock = '';
                }

                if (line.includes('<programme ')) { inProgramme = true; progBlock = line; }
                else if (inProgramme) { progBlock += '\n' + line; }

                if (inProgramme && progBlock.includes('</programme>')) {
                    const startM = progBlock.match(/start=["']([^"']+)["']/);
                    const stopM = progBlock.match(/stop=["']([^"']+)["']/);
                    const chanM = progBlock.match(/channel=["']([^"']+)["']/);
                    const titleM = progBlock.match(/<title[^>]*>([^<]+)<\/title>/);
                    
                    if (startM && stopM && chanM && titleM) {
                        const syncId = localChannels[chanM[1]];
                        if (syncId) {
                            if (!localEpg[syncId]) localEpg[syncId] = [];
                            localEpg[syncId].push({
                                start: parseXmltvDate(startM[1]), stop: parseXmltvDate(stopM[1]),
                                title: titleM[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim()
                            });
                        }
                    }
                    inProgramme = false; progBlock = '';
                }
            });

            const timeoutId = setTimeout(() => { stream.destroy(); reject(new Error("Timeout")); }, 60000);
            rl.on('close', () => { clearTimeout(timeoutId); resolve(localEpg); });
            rl.on('error', (err) => { clearTimeout(timeoutId); reject(err); });
        } catch (err) { reject(err); }
    });
}

async function updateEPG() {
    if (isUpdatingEPG) return;
    isUpdatingEPG = true; 
    let tempEpgData = {};
    const sources = [
        { url: 'https://xmltvfr.fr/xmltv/xmltv_francophone.xml', isGz: false },
        { url: 'https://epgshare01.online/epgshare01/epg_ripper_FR1.xml.gz', isGz: true }
    ];

    try {
        for (const source of sources) {
            try {
                const parsedEpg = await fetchAndParseEPG(source.url, source.isGz);
                for (const channelId in parsedEpg) {
                    if (!tempEpgData[channelId] && parsedEpg[channelId].length > 0) tempEpgData[channelId] = parsedEpg[channelId];
                }
                if (Object.keys(tempEpgData).length > 100) break;
            } catch (err) {}
        }
        if (Object.keys(tempEpgData).length > 10) {
            epgData = tempEpgData;
            lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
        }
    } finally { isUpdatingEPG = false; }
}

async function fetchAddonCatalog(providerUrl) {
    let allMetas = [];
    try {
        let cleanUrl = providerUrl.trim();
        if (!cleanUrl.endsWith('manifest.json')) cleanUrl = cleanUrl.replace(/\/$/, '') + '/manifest.json';
        const base = cleanUrl.replace(/\/manifest\.json$/, '');

        const manifestRes = await axios.get(cleanUrl, { timeout: 4000 });
        const catalogs = manifestRes.data.catalogs || [];
        
        const catalogPromises = catalogs.map(async (catalog) => {
            let catMetas = []; let skip = 0; let hasMore = true; let pageCount = 0;
            while (hasMore && pageCount < 4) {
                pageCount++;
                try {
                    let url = skip > 0 ? `${base}/catalog/${catalog.type}/${catalog.id}/skip=${skip}.json` : `${base}/catalog/${catalog.type}/${catalog.id}.json`;
                    let res = await axios.get(url, { timeout: 4000 });
                    if (res.data && res.data.metas && res.data.metas.length > 0) {
                        catMetas.push(...res.data.metas); skip += res.data.metas.length;
                    } else { hasMore = false; }
                } catch (e) { hasMore = false; }
            }
            return catMetas;
        });

        const results = await Promise.all(catalogPromises);
        let seenIds = new Set();
        results.flat().forEach(m => {
            if (m && m.id && !seenIds.has(m.id)) {
                seenIds.add(m.id);
                allMetas.push({ ...m, _providerBase: base });
            }
        });
    } catch (err) {}
    return allMetas;
}

async function getChannelsForSources(sourcesList) {
    const cacheKey = sourcesList.join('|');
    if (channelsCache[cacheKey] && (Date.now() - channelsCache[cacheKey].timestamp < 3600000)) return channelsCache[cacheKey].data;

    let tempChannelsMap = {};
    for (let i = 0; i < sourcesList.length; i++) {
        const providerUrl = sourcesList[i].trim();
        if (!providerUrl) continue;
        
        const metas = await fetchAddonCatalog(providerUrl);
        let cleanUrl = providerUrl.trim();
        if (!cleanUrl.endsWith('manifest.json')) cleanUrl = cleanUrl.replace(/\/$/, '') + '/manifest.json';
        const base = cleanUrl.replace(/\/manifest\.json$/, '');

        metas.forEach(meta => {
            let channelInfo = getChannelData(meta.name || '');
            if (!channelInfo) return; // Blacklist ou Rejet

            const id = channelInfo.id;

            if (!tempChannelsMap[id]) {
                tempChannelsMap[id] = { 
                    id: id, 
                    name: channelInfo.name, 
                    displayName: channelInfo.name, 
                    category: channelInfo.category,
                    sortIndex: channelInfo.index,
                    sources: [], 
                    poster: meta.poster || DEFAULT_POSTER 
                };
            } else if (meta.poster && tempChannelsMap[id].poster === DEFAULT_POSTER) {
                tempChannelsMap[id].poster = meta.poster; 
            }
            
            const sourceExists = tempChannelsMap[id].sources.find(s => s.metaId === meta.id && s.providerBase === base);
            if (!sourceExists) {
                tempChannelsMap[id].sources.push({ type: 'addon', metaId: meta.id, providerBase: base, sourceIndex: i });
            }
        });
    }

    // Le filtre ultime : Si une chaîne n'a aucune source, elle n'est pas affichée (ça élimine DAZN 9 s'il est vide)
    let tempChannelsData = Object.values(tempChannelsMap).filter(ch => ch.sources.length > 0);
    tempChannelsData.sort((a, b) => {
        if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
        return a.displayName.localeCompare(b.displayName);
    });

    channelsCache[cacheKey] = { data: tempChannelsData, timestamp: Date.now() };
    return tempChannelsData;
}

app.get('/', async (req, res) => {
    let sourcesParam = req.query.sources;
    let sourcesList = sourcesParam ? sourcesParam.split(',') : ['', ''];
    let epgCount = Object.keys(epgData).length;
    let epgStatus = epgCount > 0 ? `✅ Programme téléchargé pour <b>${epgCount}</b> chaînes` : `⏳ Programme TV en cours de chargement...`;

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>HybridTV</title>
        <style>
            body { font-family: -apple-system, sans-serif; background: #141414; color: #fff; text-align: center; padding: 40px 20px; }
            .container { max-width: 650px; margin: 0 auto; background: #1f1f1f; padding: 40px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-top: 4px solid #e50914; }
            h1 { color: #fff; font-size: 32px; margin-bottom: 10px; }
            .intro-desc { font-size: 14px; color: #bbb; margin-bottom: 25px; line-height: 1.6; background: #111; padding: 15px; border-radius: 6px; border: 1px solid #333; text-align: left; }
            .section { background: #111; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #333; text-align: left; }
            .source-row { display: flex; gap: 6px; margin-bottom: 10px; align-items: center; }
            .source-num { font-size: 13px; font-weight: bold; color: #e50914; min-width: 24px; text-align: center; }
            .source-row input { flex: 1; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px; font-size: 13px; }
            .btn { display: inline-block; background: #e50914; color: #fff; padding: 12px 24px; text-decoration: none; font-size: 14px; font-weight: bold; border-radius: 8px; margin: 5px; cursor: pointer; border: none; transition: 0.2s; }
            .btn:hover { background: #f40612; transform: scale(1.02); }
            .btn-secondary { background: #333; }
            .btn-secondary:hover { background: #444; }
            .btn-small { background: #444; padding: 8px 10px; font-size: 12px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .btn-small:hover { background: #555; }
            .btn-danger { background: #800; padding: 8px 10px; font-size: 12px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .btn-danger:hover { background: #a00; }
            .stats { margin-top: 25px; font-size: 14px; color: #888; background: #111; padding: 15px; border-radius: 6px; line-height: 1.8; text-align: left; }
            input[type="text"].main-link { width: 100%; padding: 12px; margin-top: 15px; background: #111; color: #fff; border: 1px solid #444; border-radius: 6px; text-align: center; font-size: 14px; box-sizing: border-box; }
            textarea.export-box { width: 100%; height: 60px; padding: 8px; background: #222; border: 1px solid #444; color: #aaa; border-radius: 6px; font-size: 12px; box-sizing: border-box; resize: none; margin-top: 5px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📺 HybridTV</h1>
            <div class="intro-desc">
                <b>HybridTV</b> centralise vos sources de flux en une véritable bibliothèque francophone thématisée et triée sur le volet. Fini le désordre : tout est classé par catégories logiques (TNT, Sport, Cinéma, etc.) avec une sélection automatique de la meilleure qualité et des sources les plus stables selon vos priorités.
            </div>
            
            <div class="section">
                <label style="font-size: 14px; color: #ccc; font-weight: bold;">Sources de flux (manifest.json) :</label><br>
                <span style="font-size: 11px; color: #777; display: block; margin-bottom: 12px;">L'ordre de priorité s'effectue du haut vers le bas (la source n°1 est interrogée en premier).</span>
                <div id="sourcesContainer"></div>
                <button type="button" onclick="addSourceField()" class="btn btn-small">+ Ajouter une source</button>
            </div>

            <div class="section">
                <label style="font-size: 14px; color: #ccc; font-weight: bold;">🔑 Code de Sauvegarde / Partage :</label><br>
                <span style="font-size: 12px; color: #777;">Copiez ce code pour sauvegarder vos sources, ou collez un code reçu pour l'importer :</span>
                <textarea id="exportTokenBox" class="export-box" placeholder="Code de configuration..."></textarea>
                <button type="button" onclick="importToken()" class="btn btn-small" style="margin-top: 5px;">📥 Importer le code</button>
            </div>

            <div class="section" style="text-align: center;">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="epgToggle" checked style="width: 18px; height: 18px; cursor: pointer;">
                    <b style="font-size: 15px;">Activer le Programme TV</b>
                </label>
            </div>
            
            <button type="button" onclick="generateLink()" class="btn">⚡ Générer le lien de l'Add-on</button>
            <br>
            <input type="text" id="manifestLink" class="main-link" placeholder="Cliquez sur 'Générer' pour afficher le lien..." readonly>
            <br>
            <button type="button" onclick="copyLink()" class="btn btn-secondary" style="margin-top: 10px;">📋 Copier le lien</button>
            
            <div class="stats">
                <b>État du service :</b><br>
                ✅ Serveur actif et opérationnel<br>
                ${epgStatus}<br>
                🕒 Dernière synchronisation : ${lastUpdate}
            </div>
        </div>

        <script>
            let sources = ${JSON.stringify(sourcesList)};

            function renderSources() {
                const container = document.getElementById('sourcesContainer');
                container.innerHTML = '';
                sources.forEach((src, index) => {
                    if (index >= 5) return;
                    const div = document.createElement('div');
                    div.className = 'source-row';
                    div.innerHTML = \`
                        <span class="source-num">#\${index + 1}</span>
                        <input type="text" id="src_\${index}" value="\${src}" placeholder="https://votre-source.com/manifest.json">
                        \${index > 0 ? '<button type="button" onclick="moveSource(' + index + ', -1)" class="btn-small">▲</button>' : ''}
                        \${index < sources.length - 1 ? '<button type="button" onclick="moveSource(' + index + ', 1)" class="btn-small">▼</button>' : ''}
                        \${sources.length > 1 ? '<button type="button" onclick="removeSource(' + index + ')" class="btn-danger">✕</button>' : ''}
                    \`;
                    container.appendChild(div);
                });
                updateExportToken();
            }

            function moveSource(index, direction) {
                saveInputs();
                const newIndex = index + direction;
                if (newIndex < 0 || newIndex >= sources.length) return;
                const temp = sources[index];
                sources[index] = sources[newIndex];
                sources[newIndex] = temp;
                renderSources();
            }
            function addSourceField() { if (sources.length < 5) { saveInputs(); sources.push(''); renderSources(); } }
            function removeSource(index) { saveInputs(); sources.splice(index, 1); renderSources(); }
            function saveInputs() {
                sources.forEach((_, index) => { const el = document.getElementById('src_' + index); if (el) sources[index] = el.value.trim(); });
                localStorage.setItem('hybrid_sources', JSON.stringify(sources));
                updateExportToken();
            }
            function updateExportToken() {
                const validSources = sources.filter(s => s.length > 0);
                const isEpg = document.getElementById("epgToggle").checked;
                const configObj = { sources: validSources, epg: isEpg };
                document.getElementById('exportTokenBox').value = btoa(JSON.stringify(configObj));
            }
            function importToken() {
                try {
                    const jsonStr = atob(document.getElementById('exportTokenBox').value.trim());
                    const config = JSON.parse(jsonStr);
                    if (config.sources && Array.isArray(config.sources)) {
                        sources = config.sources; if (sources.length === 0) sources = ['', ''];
                        if (config.epg !== undefined) document.getElementById("epgToggle").checked = config.epg;
                        renderSources(); alert("Configuration importée avec succès !");
                    } else alert("Code invalide.");
                } catch(e) { alert("Erreur : Ce code est corrompu."); }
            }
            function generateLink() {
                saveInputs();
                const validSources = sources.filter(s => s.length > 0);
                if (validSources.length === 0) return alert("Veuillez entrer au moins un lien de source !");
                const token = document.getElementById('exportTokenBox').value;
                document.getElementById("manifestLink").value = window.location.protocol + "//" + window.location.host + "/" + token + "/manifest.json";
                alert("Lien généré avec succès !");
            }

            let savedSources = localStorage.getItem('hybrid_sources');
            if (savedSources && !${sourcesParam ? 'true' : 'false'}) sources = JSON.parse(savedSources);
            renderSources();

            function copyLink() {
                var copyText = document.getElementById("manifestLink");
                if (!copyText.value) return alert("Veuillez d'abord générer le lien !");
                copyText.select(); document.execCommand("copy"); alert("Lien copié dans le presse-papier !");
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.get('/:config/manifest.json', (req, res) => {
    const config = parseConfig(req.params.config);
    const confName = config.epg ? 'epg-on' : 'epg-off';
    
    res.setHeader('Cache-Control', 'max-age=86400, public'); 
    res.json({
        id: 'org.hybridtv.meta.' + confName, 
        version: '1.3.0',
        name: config.epg ? 'HybridTV' : 'HybridTV (Sans Programme TV)',
        description: 'L\'expérience IPTV ultime. Édition Meta-Addon dynamique.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            { type: 'tv', id: 'tnt', name: '📺 TNT' },
            { type: 'tv', id: 'info', name: '📰 Information' },
            { type: 'tv', id: 'jeunesse', name: '👶 Jeunesse' },
            { type: 'tv', id: 'decouverte', name: '🔬 Découverte & Docu' },
            { type: 'tv', id: 'cinema', name: '🍿 Cinéma & Séries' },
            { type: 'tv', id: 'musique', name: '🎵 Musique' },
            { type: 'tv', id: 'canal', name: '🎟️ Bouquet Canal' },
            { type: 'tv', id: 'sports', name: '⚽ Sports' },
            { type: 'tv', id: 'autres', name: '📂 Autres' }
        ]
    });
});

app.get(['/:config/catalog/tv/:id.json', '/:config/catalog/tv/:id/:extra'], async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ metas: [] });
    
    let channelsData = await getChannelsForSources(config.sources);
    if (channelsData.length === 0) { res.setHeader('Cache-Control', 'no-cache'); return res.json({ metas: [] }); }
    
    res.setHeader('Cache-Control', 'max-age=14400, public'); 
    const requestedCatalog = req.params.id; 
    let skip = 0;
    if (req.params.extra) {
        const match = req.params.extra.match(/skip=(\d+)/);
        if (match) skip = parseInt(match[1], 10);
    }

    const validCatalogs = ['tnt', 'info', 'jeunesse', 'decouverte', 'cinema', 'musique', 'canal', 'sports', 'autres'];
    if (!validCatalogs.includes(requestedCatalog)) return res.json({ metas: [] });
    
    const filteredChannels = channelsData.filter(ch => ch.category === requestedCatalog);
    const paginatedMetas = filteredChannels.slice(skip, skip + 100).map(ch => ({
        id: ch.id, type: 'tv', name: ch.displayName, poster: ch.poster, posterShape: 'square'
    }));
    res.json({ metas: paginatedMetas });
});

app.get('/:config/meta/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ meta: {} });
    
    let channelsData = await getChannelsForSources(config.sources);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); 
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });
    
    let descriptionText = `▶ Diffusion en cours sur ${channel.displayName}...`;
    
    if (config.epg) {
        if (Object.keys(epgData).length === 0) {
            descriptionText = `▶ Le Programme TV est en cours de chargement...`;
        } else {
            const epgList = epgData[channel.id]; 
            if (epgList && epgList.length > 0) {
                const now = Date.now();
                epgList.sort((a, b) => a.start - b.start);
                
                const currentIndex = epgList.findIndex(p => now >= p.start && now <= p.stop);
                
                if (currentIndex !== -1) {
                    const currentProg = epgList[currentIndex];
                    const sTime = formatTime(currentProg.start);
                    const eTime = formatTime(currentProg.stop);
                    
                    descriptionText = `🔴 EN DIRECT (${sTime} - ${eTime}) : ${currentProg.title}`;
                    
                    const rawUpcoming = epgList.slice(currentIndex + 1);
                    let filteredUpcoming = [];
                    let seenTimes = new Set();
                    seenTimes.add(sTime); 
                    
                    for (let p of rawUpcoming) {
                        const uTime = formatTime(p.start);
                        if (!seenTimes.has(uTime)) {
                            seenTimes.add(uTime);
                            filteredUpcoming.push(`${uTime} ${p.title}`);
                        }
                        if (filteredUpcoming.length === 4) break; 
                    }
                    
                    if (filteredUpcoming.length > 0) {
                        descriptionText += `\n📺 À SUIVRE :\n`;
                        descriptionText += filteredUpcoming.join('  |  ');
                    }
                }
            }
        }
    }

    res.json({
        meta: { id: channel.id, type: 'tv', name: channel.displayName, poster: channel.poster, posterShape: 'square', description: descriptionText }
    });
});

app.get('/:config/stream/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ streams: [] });
    
    let channelsData = await getChannelsForSources(config.sources);
    res.setHeader('Cache-Control', 'max-age=1800, public'); 
    const rawIp = req.headers['x-forwarded-for'];
    const clientIp = rawIp ? rawIp.split(',')[0].trim() : req.socket.remoteAddress;

    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });
    
    try {
        let streamPromises = channel.sources.map(async (source) => {
            try {
                const streamRes = await axios.get(`${source.providerBase}/stream/tv/${source.metaId}.json`, {
                    headers: { 'X-Forwarded-For': clientIp }, timeout: 4000 
                });
                if (streamRes.data && streamRes.data.streams) {
                    return streamRes.data.streams.map(s => {
                        let qual = "Qualité Standard (SD)";
                        let score = 0;
                        let up = (s.title || '').toUpperCase() + ' ' + (s.name || '').toUpperCase();
                        
                        // Notation de la Qualité Vidéo
                        if (up.includes('4K') || up.includes('2160') || up.includes('UHD')) { qual = "Ultra Haute Qualité (4K)"; score += 800; } 
                        else if (up.includes('FHD') || up.includes('1080')) { qual = "Haute Qualité (FHD)"; score += 600; } 
                        else if (up.includes('HD') || up.includes('720')) { qual = "Haute Qualité (HD)"; score += 400; } 
                        else { score += 200; }

                        // LA PRIORITÉ ABSOLUE AU FRANÇAIS (On booste ce qu'on veut voir !)
                        if (up.match(/\bFR\b/) || up.match(/\bVF\b/) || up.includes('FRENCH') || up.includes('FRANCE')) {
                            score += 5000;
                        }
                        
                        // MALUS SÉVÈRE : La très basse qualité (illisible)
                        if (up.includes('360P') || up.includes('480P') || up.includes('LQ')) {
                            score -= 4000;
                        }

                        // MALUS SÉVÈRE : Les flux morts ou de secours
                        if (up.includes('BACKUP') || up.includes('SECOURS') || up.includes('ALT') || up.includes('TEST')) {
                            score -= 3000;
                        }
                        
                        // Bonus lié à l'ordre des sources configuré par l'utilisateur
                        score += (10 - source.sourceIndex) * 10;

                        return { ...s, _qualText: qual, _score: score };
                    });
                }
            } catch (err) {}
            return [];
        });

        let results = await Promise.all(streamPromises);
        let allStreams = [].concat(...results);

        // Tri mathématique absolu par score
        allStreams.sort((a, b) => b._score - a._score);
        
        // Coupe stricte aux 8 meilleurs flux
        const limitedStreams = allStreams.slice(0, 8);

        const finalStreams = limitedStreams.map((s, idx) => ({
            url: s.url, name: `▶ Source ${idx + 1}`, title: s._qualText
        }));
        
        res.json({ streams: finalStreams });
    } catch (err) { res.json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`HybridTV Server démarré sur le port ${PORT}`);
    updateEPG(); 
    setInterval(updateEPG, 3600000); 
});
