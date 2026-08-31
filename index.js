/**
 * HybridTV
 * Version: 1.0.9 (Sémantique Intégrale, Anti-Rate Limiting TVMio & Background Warm Cache)
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');

const app = express();
app.use(cors());

// --- TELEMETRY & CACHING STATE ---
let isUpdatingEPG = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let epgData = {}; 
let channelsCache = {}; 
let streamCache = new Map(); 
let streamResponseCache = new Map(); 
let sourceBlocklist = new Map(); // Circuit Breaker anti-rate limiting (TVMio / autres)

const serverStats = {
    startTime: Date.now(),
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    channelClicks: {},
    activeIps: new Map()
};

// --- SECURITY: SSRF Protection for URLs ---
function isValidHttpUrl(string) {
    try {
        const url = new URL(string);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        const hostname = url.hostname.toLowerCase();
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '0.0.0.0' ||
            hostname.startsWith('10.') ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('169.254.')
        ) {
            return false;
        }
        return true;
    } catch (_) {
        return false;
    }
}

// --- MIDDLEWARE: Metrics Tracker ---
app.use((req, res, next) => {
    if (req.path.includes('.json')) {
        serverStats.totalRequests++;
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (ip) {
            const cleanIp = ip.split(',')[0].trim();
            serverStats.activeIps.set(cleanIp, Date.now());
        }
        const now = Date.now();
        for (let [key, time] of serverStats.activeIps.entries()) {
            if (now - time > 5 * 60 * 1000) serverStats.activeIps.delete(key);
        }
    }
    next();
});

// --- ASSETS & CONFIG ---
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';
const EVENT_POSTER = 'https://cdn-icons-png.flaticon.com/512/861/861512.png';

const BLACKLIST = [
    'ALACARTE', 'DISNEYPLUS', 'NETFLIX', 'PRIMEVIDEO', 'APPLETV',
    'TEST', 'MIRROR', 'BACKUPCHANNEL', 'BOXOFFICE1', 'BOXOFFICE2', 'CANALPLAY', 'AFRIQUE', 'DEUTSCH', 'GERMAN'
];

function parseConfig(encodedConfig) {
    try {
        if (!encodedConfig || encodedConfig === 'manifest.json') return { sources: [], qualities: ['1080p', '720p', '4K', 'SD'] };
        const jsonStr = Buffer.from(encodedConfig, 'base64').toString('utf8');
        let parsed = JSON.parse(jsonStr);
        if (!parsed.qualities || !Array.isArray(parsed.qualities)) {
            parsed.qualities = ['1080p', '720p', '4K', 'SD'];
        }
        if (parsed.sources && Array.isArray(parsed.sources)) {
            parsed.sources = parsed.sources.filter(s => typeof s === 'string' && isValidHttpUrl(s.trim()));
        } else {
            parsed.sources = [];
        }
        return parsed;
    } catch (e) {
        return { sources: [], qualities: ['1080p', '720p', '4K', 'SD'] };
    }
}

// --- LIVE EVENTS PARSER ---
function extractMatchEvent(rawName) {
    if (!rawName) return null;
    let s = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();

    let isMatch = false;
    let eventName = '';

    if (s.includes('MATCH TIME') || s.includes('MATCHTIME')) {
        let cleanName = s.replace(/^(?:FR|BE|CH|VIP|LIVE|DIRECT|EVENT|MATCH|LIGUE\s*1|DAZN|BEIN|RMC|CANAL\+?|MULTI|MULTIPLEX)\s*[:|-|\|]*\s*/gi, '')
                 .replace(/\d{1,2}[hH:]\d{2}/g, '')
                 .replace(/\b(?:FHD|HD|SD|4K|1080P|720P|MATCH\s*TIME|MATCHTIME)\b/gi, '')
                 .replace(/[^A-Z0-9\s-]/g, '').trim();
        if (cleanName.length < 3) cleanName = "Événement Sportif";
        return { id: 'hyb_ev_' + toSyncId(cleanName), name: '🔴 ' + cleanName, categories: ['events'], index: 5, customPoster: EVENT_POSTER };
    }

    let vsMatch = s.match(/([A-Z0-9\s]{3,20})\s+(?:VS\.?|CONTRE|\bV\b|\bVERSUS\b)\s+([A-Z0-9\s]{3,20})/i);
    if (vsMatch) {
        isMatch = true; 
        eventName = `${vsMatch[1].trim()} vs ${vsMatch[2].trim()}`;
    } else if (/(?:LIGUE\s*1|UCL|LDC|EURO|PREMIER LEAGUE|MATCH|EVENT).+?\b([A-Z][A-Z0-9\s]{2,20})\s*[-/]\s*([A-Z][A-Z0-9\s]{2,20})\b/i.test(s)) {
        let dashMatch = s.match(/\b([A-Z][A-Z0-9\s]{2,20})\s*[-/]\s*([A-Z][A-Z0-9\s]{2,20})\b/i);
        if (dashMatch) {
            let inv = ['CANAL', 'CINE', 'SPORT', 'BEIN', 'RMC', 'EUROSPORT', 'TF1', 'FRANCE', 'M6', 'DAZN', '1080P', '720P', 'UHD', '4K', 'FHD', 'HD', 'SD', 'PLUS'];
            if (!inv.includes(dashMatch[1].trim()) && !inv.includes(dashMatch[2].trim())) {
                isMatch = true; 
                eventName = `${dashMatch[1].trim()} vs ${dashMatch[2].trim()}`;
            }
        }
    }

    if (isMatch) {
        const cleanTeam = (str) => {
            return str.replace(/^(?:FR|BE|CH|VIP|1080P|720P|4K|HD|SD|LIVE|DIRECT|EVENT|MATCH|LIGUE\s*1|DAZN|BEIN|RMC|CANAL\+?|MULTI)\s*[:|-|\|]*/gi, '')
                      .replace(/\b(?:FHD|HD|SD|4K|1080P|720P|LIVE|DIRECT|RAW)\b/gi, '')
                      .replace(/[^A-Z0-9\s]/g, '').trim();
        };
        let parts = eventName.split(' vs ');
        let cleanT1 = cleanTeam(parts[0]);
        let cleanT2 = cleanTeam(parts[1]);

        if (cleanT1.length >= 2 && cleanT2.length >= 2 && cleanT1 !== cleanT2) {
            let canonicalKey = [toSyncId(cleanT1), toSyncId(cleanT2)].sort().join('_');
            return { id: 'hyb_ev_' + canonicalKey, name: `⚽ ${cleanT1} vs ${cleanT2}`, categories: ['events'], index: 5, customPoster: EVENT_POSTER };
        }
    }

    if (s.includes('MULTIPLEX') && !s.includes('CANAL')) {
        return { id: 'hyb_ev_multi', name: '🔴 MULTIPLEX EN DIRECT', categories: ['events'], index: 1, customPoster: EVENT_POSTER };
    }
    return null;
}

// --- TABLE DE ROUTAGE SÉMANTIQUE INTÉGRALE (AVEC GESTION FINES DES PREMIÈRE LIGUE & EXCEPTIONS) ---
function getChannelData(rawName) {
    if (!rawName) return null;
    let eventData = extractMatchEvent(rawName);
    if (eventData) return eventData;

    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
    n = n.replace(/^(?:FR|BE|CH|CA|VIP|VAVOO)\s*[:|/-]+\s*/i, '');
    n = n.replace(/DURING EVENT ONLY/g, '').replace(/EVENT ONLY/g, '');
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'DIRECT', 'RAW', 'ACCESS'];
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'gi'), ''); });

    let cCheck = n.replace(/[^A-Z0-9]/g, '');

    // --- EXCEPTIONS SÉMANTIQUES STRICTES (ISOLATION PRÉVENTIVE) ---
    if (cCheck.includes('CANALJ') || cCheck === 'CJ') return { id: 'hyb_jeu_canalj', name: 'Canal J', categories: ['jeunesse'], index: 6 };
    if (cCheck.includes('CANALSAVOIR') || cCheck.includes('SAVOIR')) return { id: 'hyb_dec_savoir', name: 'Canal Savoir', categories: ['decouverte'], index: 40 };
    if (cCheck.includes('CANALALPHA') || cCheck.includes('ALPHA')) return { id: 'hyb_aut_canalalpha', name: 'Canal Alpha', categories: ['autres'], index: 150 };
    if (cCheck.includes('MOTOGP') || cCheck.includes('MOTO GP')) return { id: 'hyb_sport_motogp', name: 'Canal+ MotoGP', categories: ['sports', 'canal'], index: 92 };
    if (cCheck.includes('FORMULA1') || cCheck.includes('F1')) return { id: 'hyb_sport_f1', name: 'Canal+ Formula 1', categories: ['sports', 'canal'], index: 93 };
    
    // --- GESTION PRÉCISE DES PREMIER / PREMIÈRE LIGUE / HD ---
    if (cCheck.includes('PREMIERLEAGUE') || cCheck === 'PREMIER' || cCheck.includes('PREMIERELIGUE') || cCheck.includes('PREMIERLIGUE')) {
        return { id: 'hyb_sport_premierleague', name: 'Premier League', categories: ['sports'], index: 95 };
    }

    if (n.includes('LFL') || n.includes('LEAGUE OF LEGENDS') || n.includes('LOL LFL')) {
        return { id: 'hyb_esport_lfl', name: 'LFL (eSport)', categories: ['autres'], index: 10 };
    }

    n = n.replace(/\+/g, 'PLUS');

    if (n.includes('LIGUE 1') || n.includes('LIGUE1') || n.match(/\bL1\b/)) {
        if (!n.includes('DAZN') && !n.includes('BEIN') && !n.includes('RMC')) {
            let m = n.match(/(?:LIGUE\s*1|L1|LIGUE1)(?:.*?PLUS)?[^\d]*([1-9]|1[0-8])/i);
            let num = m ? m[1] : '1';
            return { id: 'hyb_sport_ligue1plus_' + num, name: num === '1' ? 'Ligue 1+' : 'Ligue 1+ ' + num, categories: ['sports'], index: 1 + parseInt(num, 10) };
        }
    }
    
    if (n.includes('DAZN')) {
        if (n.includes('RISE')) return { id: 'hyb_sport_dazn_rise', name: 'DAZN Rise', categories: ['sports'], index: 150 };
        let m = n.match(/DAZN[^\d]*([1-9]|1[0-8])/i); let num = m ? m[1] : '1';
        return { id: 'hyb_sport_dazn_'+num, name: 'DAZN '+num, categories: ['sports'], index: 10 + parseInt(num, 10) };
    }

    let c = cCheck;
    if (!c || c.length < 2) return null;
    if (BLACKLIST.some(b => c.includes(b))) return null;

    if (c.includes('JURAS') || c.includes('TOP14') || c.includes('LCENTRE') || c.includes('LIGA') || c === 'CANALPLUSL' || c === 'CPLUSL' || c === 'CPLUSSPORT') {
        let pretty = rawName.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\b(?:FHD|HD|SD|4K|1080P|720P)\b/gi, '').trim();
        return { id: 'hyb_aut_' + c.substring(0, 15), name: pretty, categories: ['autres'], index: 200 };
    }

    if (c.startsWith('FRANCE24')) return { id: 'hyb_info_06', name: 'France 24', categories: ['info'], index: 6 };
    if (c.startsWith('FRANCEINFO')) return { id: 'hyb_info_07', name: 'France Info', categories: ['info'], index: 7 };
    if (c.includes('METEO')) return { id: 'hyb_info_08', name: 'La Chaîne Météo', categories: ['info'], index: 8 };
    if (c.includes('I24')) return { id: 'hyb_info_09', name: 'i24News', categories: ['info'], index: 9 };
    if (c.includes('TVBREIZH') || c.includes('BREIZH')) return { id: 'hyb_info_breizh', name: 'TV Breizh', categories: ['info'], index: 40 };
    if (c.includes('BFMPARIS')) return { id: 'hyb_info_50', name: 'BFM Paris Île-de-France', categories: ['info'], index: 50 };
    if (c.includes('BFMLYON')) return { id: 'hyb_info_51', name: 'BFM Lyon', categories: ['info'], index: 51 };
    if (c.includes('BFMLILLE') || c.includes('GRANDLILLE')) return { id: 'hyb_info_52', name: 'BFM Grand Lille', categories: ['info'], index: 52 };
    if (c === 'BFMTV' || c === 'BFM') return { id: 'hyb_info_01', name: 'BFMTV', categories: ['info'], index: 1 };
    if (c.includes('BFMBUSINESS')) return { id: 'hyb_info_02', name: 'BFM Business', categories: ['info'], index: 2 };
    if (c.includes('CNEWS')) return { id: 'hyb_info_03', name: 'CNews', categories: ['info'], index: 3 };
    if (c === 'LCI') return { id: 'hyb_info_04', name: 'LCI', categories: ['info'], index: 4 };

    if (c.includes('COMEDYCENTRAL')) return { id: 'hyb_aut_comedycentral', name: 'Comedy Central', categories: ['autres'], index: 11 };
    if (c.includes('COMEDIE') || c.includes('COMEDY')) return { id: 'hyb_canal_comedie', name: 'Comédie+', categories: ['canal', 'autres'], index: 10 };

    if (c.includes('CANAL') || c.includes('CPLUS')) {
        if (c.includes('ELLES') || c.includes('LCENTRE') || c.includes('CENTRE') || c === 'CANALL' || c.includes('REGIONAL') || c.includes('LOCAL') || c.includes('OUTREMER')) {
            return { id: 'hyb_aut_canal_elles', name: 'Canal+ Elles', categories: ['autres'], index: 1000 };
        }

        if (c.includes('KIDS')) return { id: 'hyb_canal_kids', name: 'Canal+ Kids', categories: ['canal', 'jeunesse'], index: 101 };
        
        if (c.includes('LIVE')) {
            let m = c.match(/LIVE(\d+)/); let num = m ? m[1] : '1';
            return { id: 'hyb_canal_live_' + num, name: 'Canal+ Live ' + num, categories: ['canal'], index: 200 + parseInt(num, 10) };
        }

        if (c.includes('SPORT360') || c.includes('360')) return { id: 'hyb_canal_sport360', name: 'Canal+ Sport 360', categories: ['canal', 'sports'], index: 90 };
        if (c.includes('FOOT')) return { id: 'hyb_canal_foot', name: 'Canal+ Foot', categories: ['canal', 'sports'], index: 91 };
        if (c.includes('SPORT')) return { id: 'hyb_canal_sport', name: 'Canal+ Sport', categories: ['canal', 'sports'], index: 94 };
        
        if (c.includes('CINEMA') || c.includes('CNEMA')) return { id: 'hyb_canal_cinema', name: 'Canal+ Cinéma', categories: ['canal', 'cinema'], index: 2 };
        if (c.includes('GRANDECRAN') || c.includes('ECRAN')) return { id: 'hyb_canal_grandecran', name: 'Canal+ Grand Écran', categories: ['canal', 'cinema'], index: 3 };
        if (c.includes('SERIES') || c.includes('SERIE')) return { id: 'hyb_canal_series', name: 'Canal+ Séries', categories: ['canal', 'cinema'], index: 4 };
        if (c.includes('BOXOFFICE') || c.includes('BOX')) return { id: 'hyb_canal_boxoffice', name: 'Canal+ Box Office', categories: ['canal', 'cinema'], index: 5 };
        if (c.includes('DOC')) return { id: 'hyb_canal_docs', name: 'Canal+ Docs', categories: ['canal', 'decouverte'], index: 6 };
        if (c.includes('DECALE')) return { id: 'hyb_canal_decale', name: 'Canal+ Décalé', categories: ['canal'], index: 14 };
        if (c.includes('FAMILY')) return { id: 'hyb_canal_family', name: 'Canal+ Family', categories: ['canal'], index: 15 };
        
        return { id: 'hyb_canal_cplus', name: 'Canal+', categories: ['canal'], index: 1 };
    }

    if (c.includes('BEINSPORT') || c.includes('BEIN')) {
        let isMax = c.includes('MAX'); let m = c.match(/BEIN(?:SPORT|MAX)?S?(\d+)/); let num = (m && m[1]) ? m[1] : '1';
        return { id: 'hyb_sport_bein_' + (isMax?'max':'') + num, name: isMax ? 'beIN SPORTS MAX '+num : 'beIN SPORTS '+num, categories: ['sports'], index: isMax ? 40 + parseInt(num, 10) : 30 + parseInt(num, 10) };
    }
    if (c.includes('EUROSPORT')) {
        let is360 = c.includes('360'); let m = c.match(/EUROSPORT(?:360)?(\d+)/); let num = (m && m[1]) ? m[1] : '1';
        if (is360) return { id: 'hyb_sport_euro360_'+num, name: 'Eurosport 360 - '+num, categories: ['sports'], index: 60 + parseInt(num, 10) };
        return { id: 'hyb_sport_euro_'+num, name: 'Eurosport '+num, categories: ['sports'], index: 50 + parseInt(num, 10) };
    }
    if (c.includes('RMCSPORT')) {
        let isLive = c.includes('LIVE'); let m = c.match(/RMCSPORT(?:LIVE)?(\d+)/); let num = (m && m[1]) ? m[1] : '1';
        if (isLive) return { id: 'hyb_sport_rmclive_'+num, name: 'RMC Sport Live '+num, categories: ['sports'], index: 80 + parseInt(num, 10) };
        return { id: 'hyb_sport_rmc_'+num, name: 'RMC Sport '+num, categories: ['sports'], index: 70 + parseInt(num, 10) };
    }
    if (c.includes('EQUIDIA')) return { id: 'hyb_sport_equidia', name: 'Equidia', categories: ['sports'], index: 96 };
    if (c.includes('OLTV') || c.includes('OLYMPIQUELYONNAIS')) return { id: 'hyb_sport_oltv', name: 'OL TV', categories: ['sports'], index: 97 };
    if (c.includes('LEQUIPE')) return { id: 'hyb_sport_lequipe', name: "L'Équipe", categories: ['sports', 'tnt'], index: 98 };

    if (c.includes('CINE') || c.includes('CINA')) {
        if (c.includes('PREMIER')) return { id: 'hyb_cine_premier', name: 'Ciné+ Premier', categories: ['cinema', 'canal'], index: 11 };
        if (c.includes('FRISSON') || c.includes('ISSON')) return { id: 'hyb_cine_frisson', name: 'Ciné+ Frisson', categories: ['cinema', 'canal'], index: 12 };
        if (c.includes('EMOTION')) return { id: 'hyb_cine_emotion', name: 'Ciné+ Émotion', categories: ['cinema', 'canal'], index: 13 };
        if (c.includes('FAMIZ')) return { id: 'hyb_cine_famiz', name: 'Ciné+ Famiz', categories: ['cinema', 'canal'], index: 14 };
        if (c.includes('CLUB') && !c.includes('SERIE')) return { id: 'hyb_cine_club', name: 'Ciné+ Club', categories: ['cinema', 'canal'], index: 15 };
        if (c.includes('CLASSIC')) return { id: 'hyb_cine_classic', name: 'Ciné+ Classic', categories: ['cinema', 'canal'], index: 16 };
        if (c.includes('ACTION')) return { id: 'hyb_cine_action', name: 'Action', categories: ['cinema'], index: 30 };
        return { id: 'hyb_cine_plus', name: 'Ciné+', categories: ['cinema', 'canal'], index: 19 };
    }
    
    if (c.includes('OCS')) {
        let m = n.match(/OCS\s*([A-Z]*)/i); let suffix = (m && m[1]) ? ' ' + m[1] : '';
        return { id: 'hyb_cine_ocs_' + suffix.trim().toLowerCase(), name: 'OCS' + suffix, categories: ['cinema'], index: 20 };
    }
    if (c.includes('WARNER')) return { id: 'hyb_cine_warner', name: 'Warner TV', categories: ['cinema'], index: 34 };
    if (c.includes('SYFY') || c.includes('SCIFI')) return { id: 'hyb_cine_syfy', name: 'Syfy', categories: ['cinema'], index: 35 };
    if (c.includes('PARAMOUNT')) return { id: 'hyb_cine_paramount', name: 'Paramount Channel', categories: ['cinema'], index: 32 };

    if (c.startsWith('TF1SERIESFILMS') || c.startsWith('TF1SF') || (c.startsWith('TF1') && (c.includes('SERIE') || c.includes('FILM')))) {
        return { id: 'hyb_tnt_20', name: 'TF1 Séries Films', categories: ['tnt', 'cinema'], index: 20 };
    }
    if (c.startsWith('TF1')) return { id: 'hyb_tnt_1', name: 'TF1', categories: ['tnt'], index: 1 };
    
    if (c.startsWith('FRANCE2') || c === 'FR2') return { id: 'hyb_tnt_2', name: 'France 2', categories: ['tnt'], index: 2 };
    if (c.startsWith('FRANCE3') || c === 'FR3') return { id: 'hyb_tnt_3', name: 'France 3', categories: ['tnt'], index: 3 };
    if (c.startsWith('FRANCE4') || c === 'FR4') return { id: 'hyb_tnt_4', name: 'France 4', categories: ['tnt'], index: 4 };
    if (c.startsWith('FRANCE5') || c === 'FR5') return { id: 'hyb_tnt_5', name: 'France 5', categories: ['tnt'], index: 5 };
    if (c.startsWith('M6MUSIC')) return { id: 'hyb_mus_m6', name: 'M6 Music', categories: ['musique'], index: 1 };
    if (c.startsWith('M6')) return { id: 'hyb_tnt_6', name: 'M6', categories: ['tnt'], index: 6 };
    if (c.startsWith('ARTE')) return { id: 'hyb_tnt_7', name: 'Arte', categories: ['tnt'], index: 7 };
    if (c.startsWith('C8')) return { id: 'hyb_tnt_8', name: 'C8', categories: ['tnt'], index: 8 };
    if (c.startsWith('W9')) return { id: 'hyb_tnt_9', name: 'W9', categories: ['tnt'], index: 9 };
    if (c.startsWith('TMC')) return { id: 'hyb_tnt_10', name: 'TMC', categories: ['tnt'], index: 10 };
    if (c.startsWith('TFX') || c === 'NT1') return { id: 'hyb_tnt_11', name: 'TFX', categories: ['tnt'], index: 11 };
    if (c.startsWith('NRJ12') || c.startsWith('NRJ')) return { id: 'hyb_tnt_12', name: 'NRJ 12', categories: ['tnt'], index: 12 };
    if (c.includes('PUBLICSENAT') || c === 'LCP') return { id: 'hyb_tnt_13', name: 'LCP / Public Sénat', categories: ['tnt', 'info'], index: 13 };
    if (c.includes('CSTAR')) return { id: 'hyb_tnt_17', name: 'CStar', categories: ['tnt', 'musique'], index: 17 };
    if (c.includes('6TER')) return { id: 'hyb_tnt_22', name: '6ter', categories: ['tnt'], index: 22 };
    if (c.includes('RMCSTORY') || c.includes('NUMERO23')) return { id: 'hyb_tnt_23', name: 'RMC Story', categories: ['tnt', 'decouverte'], index: 23 };
    if (c.includes('RMCDECOUVERTE')) return { id: 'hyb_tnt_24', name: 'RMC Découverte', categories: ['tnt', 'decouverte'], index: 24 };
    if (c.includes('CHERIE25') || c === 'CHERIE') return { id: 'hyb_tnt_25', name: 'Chérie 25', categories: ['tnt'], index: 25 };
    if (c.includes('13EMERUE') || c.includes('13RUE')) return { id: 'hyb_tnt_13rue', name: '13ème Rue', categories: ['tnt', 'cinema'], index: 30 };
    if (c.includes('TEVA')) return { id: 'hyb_tnt_teva', name: 'Téva', categories: ['tnt'], index: 31 };
    if (c.includes('RTL9')) return { id: 'hyb_tnt_rtl9', name: 'RTL9', categories: ['tnt', 'cinema'], index: 32 };
    if (c.includes('AB1')) return { id: 'hyb_tnt_ab1', name: 'AB1', categories: ['tnt'], index: 33 };

    // --- CLASSEMENT JEUNESSE ORDONNÉ ---
    if (c.includes('CARTOONNETWORK') || c === 'CARTOON') return { id: 'hyb_jeu_cartoon', name: 'Cartoon Network', categories: ['jeunesse'], index: 1 };
    
    if (c.includes('DISNEY')) {
        if (c.includes('XD')) return { id: 'hyb_jeu_disneyxd', name: 'Disney XD', categories: ['jeunesse'], index: 3 };
        if (c.includes('JR') || c.includes('JUNIOR')) return { id: 'hyb_jeu_disneyjr', name: 'Disney Junior', categories: ['jeunesse'], index: 9 };
        if (c.includes('PLUS1')) return { id: 'hyb_jeu_disney_plus1', name: 'Disney Channel +1', categories: ['jeunesse'], index: 50 };
        return { id: 'hyb_jeu_disney', name: 'Disney Channel', categories: ['jeunesse'], index: 2 };
    }

    if (c.includes('NICKELODEON') || c.includes('NICK')) {
        if (c.includes('TOONS') || c.includes('TOON')) return { id: 'hyb_jeu_nicktoons', name: 'Nicktoons', categories: ['jeunesse'], index: 11 };
        if (c.includes('TEEN')) return { id: 'hyb_jeu_nick_teen', name: 'Nickelodeon Teen', categories: ['jeunesse'], index: 12 };
        if (c.includes('JR') || c.includes('JUNIOR')) return { id: 'hyb_jeu_nick_jr', name: 'Nickelodeon Junior', categories: ['jeunesse'], index: 13 };
        if (c.includes('PLUS1') || c.includes('1H')) return { id: 'hyb_jeu_nick_plus1', name: 'Nickelodeon +1', categories: ['jeunesse'], index: 14 };
        return { id: 'hyb_jeu_nick', name: 'Nickelodeon', categories: ['jeunesse'], index: 4 }; 
    }

    if (c.includes('GULLI')) return { id: 'hyb_jeu_gulli', name: 'Gulli', categories: ['jeunesse', 'tnt'], index: 5 };
    if (c.includes('CANALJ') || c.includes('CJ')) return { id: 'hyb_jeu_canalj', name: 'Canal J', categories: ['jeunesse'], index: 6 };
    if (c.includes('GAMEONE') || c.match(/\bG1\b/) || c === 'G1') return { id: 'hyb_jeu_gameone', name: 'Game One', categories: ['jeunesse'], index: 7 };
    if (c.includes('BOOMERANG')) return { id: 'hyb_jeu_boom', name: 'Boomerang', categories: ['jeunesse'], index: 8 };
    if (c.includes('BOING')) return { id: 'hyb_jeu_boing', name: 'Boing', categories: ['jeunesse'], index: 10 };
    if (c.includes('TIJI')) return { id: 'hyb_jeu_tiji', name: 'Tiji', categories: ['jeunesse'], index: 15 };
    if (c.includes('MANGAS')) return { id: 'hyb_jeu_mangas', name: 'Mangas', categories: ['jeunesse'], index: 16 };
    if (c.includes('PIWI')) return { id: 'hyb_jeu_piwi', name: 'Piwi+', categories: ['jeunesse'], index: 17 };
    if (c.includes('CARTOONITO')) return { id: 'hyb_jeu_cartoonito', name: 'Cartoonito', categories: ['jeunesse'], index: 18 };

    if (c.includes('RFMTV') || c.includes('RFM')) return { id: 'hyb_mus_rfm', name: 'RFM TV', categories: ['musique'], index: 34 }; 
    if (c.includes('MTV')) return { id: 'hyb_mus_mtv', name: 'MTV', categories: ['musique'], index: 10 };
    if (c.includes('MCM')) return { id: 'hyb_mus_mcm', name: 'MCM', categories: ['musique'], index: 20 };
    if (c.includes('TRACE')) {
        let m = n.match(/TRACE\s*([A-Z]*)/i); let suffix = (m && m[1]) ? ' ' + m[1] : '';
        return { id: 'hyb_mus_trace' + suffix.trim(), name: 'Trace' + suffix, categories: ['musique'], index: 30 };
    }
    if (c.includes('NRJHITS') || (c.includes('NRJ') && c.includes('HIT'))) return { id: 'hyb_mus_nrjhits', name: 'NRJ Hits', categories: ['musique'], index: 31 };
    if (c.includes('MELODY')) return { id: 'hyb_mus_melody', name: 'Melody', categories: ['musique'], index: 32 };
    if (c.includes('MEZZO')) return { id: 'hyb_mus_mezzo', name: 'Mezzo', categories: ['musique'], index: 33 };
    if (c.includes('CLUBBING')) return { id: 'hyb_mus_clubbing', name: 'Clubbing TV', categories: ['musique'], index: 35 };

    if (c.includes('INVESTIGATION') || c.includes('IDDISCOVERY')) return { id: 'hyb_dec_investigation', name: 'Investigation Discovery', categories: ['decouverte'], index: 21 };
    if (c.includes('DISCOVERY')) {
        let m = n.match(/DISCOVERY\s*([A-Z]*)/i); 
        let suffix = (m && m[1]) ? m[1].trim() : '';
        if (suffix === 'CHANNEL' || suffix === 'FR' || suffix === 'FRANCE') suffix = ''; 
        return { id: 'hyb_dec_discovery' + (suffix ? '_' + suffix : ''), name: 'Discovery' + (suffix ? ' ' + suffix : ''), categories: ['decouverte'], index: 20 };
    }
    if (c.includes('CRIMEDISTRICT') || c.includes('CRIMED')) return { id: 'hyb_dec_crime', name: 'Crime District', categories: ['decouverte'], index: 1 };
    if (c.includes('NATGEO') || c.includes('NATIONALGEO')) return { id: 'hyb_dec_natgeo', name: 'National Geographic', categories: ['decouverte'], index: 1 };
    if (c.includes('PLANET')) return { id: 'hyb_dec_planete', name: 'Planète+', categories: ['decouverte'], index: 210 };
    if (c.includes('USHUAIA')) return { id: 'hyb_dec_ushuaia', name: 'Ushuaïa TV', categories: ['decouverte'], index: 30 };
    if (c.includes('HISTOIRE')) return { id: 'hyb_dec_histoire', name: 'Histoire TV', categories: ['decouverte'], index: 32 };
    if (c.includes('CHASSE') || c.includes('PECHE')) return { id: 'hyb_dec_chasse', name: 'Chasse et Pêche', categories: ['decouverte'], index: 34 };
    if (c.includes('ANIMAUX')) return { id: 'hyb_dec_animaux', name: 'Animaux', categories: ['decouverte'], index: 35 };

    let cat = 'autres';
    let idx = 300;
    if (c.includes('SPORT') || c.includes('FOOT') || c.includes('GOLF') || c.includes('TENNIS') || c.includes('RUGBY') || c.includes('AUTO') || c.includes('MOTO')) cat = 'sports';
    else if (c.includes('CINE') || c.includes('FILM') || c.includes('SERIE') || c.includes('ACTION') || c.includes('PARAMOUNT')) cat = 'cinema';
    else if (c.includes('INFO') || c.includes('NEWS') || c.includes('METEO')) cat = 'info';
    else if (c.includes('DOC') || c.includes('NATURE') || c.includes('HISTOIRE') || c.includes('CRIME') || c.includes('ANIMAUX') || c.includes('PLANET') || c.includes('CHASSE') || c.includes('SCIENC')) cat = 'decouverte';
    else if (c.includes('KIDS') || c.includes('JUNIOR') || c.includes('TOON') || c.includes('NICKELODEON') || c.includes('DISNEY')) cat = 'jeunesse';
    else if (c.includes('MUSIC') || c.includes('HIT') || c.includes('POP') || c.includes('ROCK') || c.includes('TRACE') || c.includes('MELODY') || c.includes('MTV') || c.includes('MCM')) cat = 'musique';

    let prettyName = rawName.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\b(?:FHD|HD|SD|4K|1080P|720P)\b/gi, '').trim();
    prettyName = prettyName.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
    return { id: 'hyb_id_' + c, name: prettyName, categories: [cat], index: idx };
}

function toSyncId(rawName) {
    if (!rawName) return '';
    return rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]/g, ''); 
}

function parseXmltvDate(str) {
    if (!str || str.length < 14) return 0;
    const y = str.substring(0,4), m = str.substring(4,6), d = str.substring(6,8);
    const h = str.substring(8,10), min = str.substring(10,12), s = str.substring(12,14);
    let offset = str.substring(15).trim() || '+0200';
    if (!offset.includes(':') && offset.length >= 5) offset = offset.slice(0,3) + ':' + offset.slice(3);
    else if (offset.length < 5) offset = '+02:00';
    return new Date(`${y}-${m}-${d}T${h}:${min}:${s}${offset}`).getTime() || 0;
}

function formatTime(timestamp) {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)).replace(':', 'h');
}

// --- EPG SYNC ---
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
                    if (!tempEpgData[channelId]) tempEpgData[channelId] = [];
                    tempEpgData[channelId] = tempEpgData[channelId].concat(parsedEpg[channelId]);
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

// --- CATALOG ENGINE UNIVERSEL ---
async function fetchCatalogFromSource(sourceInput) {
    let metas = [];
    let cleanInput = sourceInput.trim();
    if (!cleanInput || !isValidHttpUrl(cleanInput)) return metas;

    // Protection Circuit Breaker : Si la source est en échec 403/429 récent, on évite de la spammer
    if (sourceBlocklist.has(cleanInput) && Date.now() < sourceBlocklist.get(cleanInput)) {
        return metas;
    }

    if (cleanInput.endsWith('.m3u') || cleanInput.endsWith('.m3u8') || cleanInput.includes('get.php') || cleanInput.includes('/live/')) {
        try {
            const res = await axios.get(cleanInput, { timeout: 10000, headers: { 'User-Agent': 'VLC/3.0.18' } });
            sourceBlocklist.delete(cleanInput); // Succès -> efface du blocage
            const lines = res.data.split('\n');
            let currentLogo = DEFAULT_POSTER;
            let currentName = '';

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                if (line.startsWith('#EXTINF:')) {
                    let logoMatch = line.match(/tvg-logo="([^"]+)"/);
                    if (logoMatch) currentLogo = logoMatch[1];
                    let parts = line.split(',');
                    if (parts.length > 1) currentName = parts[parts.length - 1].trim();
                } else if (line && !line.startsWith('#')) {
                    if (currentName && isValidHttpUrl(line)) {
                        let streamUrl = line;
                        let metaId = Buffer.from(streamUrl).toString('base64');
                        metas.push({ id: metaId, name: currentName, poster: currentLogo, _isDirectStream: true, _directUrl: streamUrl });
                    }
                    currentLogo = DEFAULT_POSTER;
                    currentName = '';
                }
            }
        } catch (e) {
            if (e.response && (e.response.status === 403 || e.response.status === 429)) {
                sourceBlocklist.set(cleanInput, Date.now() + 15 * 60 * 1000); // Bloque 15 min en cas de rate limit
            }
        }
        return metas;
    }

    try {
        let cleanUrl = cleanInput;
        if (!cleanUrl.endsWith('manifest.json')) cleanUrl = cleanUrl.replace(/\/$/, '') + '/manifest.json';
        const base = cleanUrl.replace(/\/manifest\.json$/, '');

        const manifestRes = await axios.get(cleanUrl, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        sourceBlocklist.delete(cleanInput);
        const catalogs = manifestRes.data.catalogs || [];
        
        const catalogPromises = catalogs.map(async (catalog) => {
            let catMetas = []; 
            let hasMore = true; 
            let skip = 0;
            const maxSkip = 50000; 
            const batchSize = 3;   
            let seenIds = new Set(); 

            while (hasMore && skip < maxSkip) {
                let requests = [];
                for (let i = 0; i < batchSize; i++) {
                    let currentSkip = skip + (i * 100);
                    let encodedCatId = encodeURIComponent(catalog.id);
                    let url = currentSkip > 0 ? `${base}/catalog/${catalog.type}/${encodedCatId}/skip=${currentSkip}.json` : `${base}/catalog/${catalog.type}/${encodedCatId}.json`;
                    if (isValidHttpUrl(url)) {
                        requests.push(axios.get(url, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(e => null));
                    }
                }
                
                let responses = await Promise.all(requests);
                let addedInBatch = 0;
                
                for (let res of responses) {
                    if (res && res.data && res.data.metas && res.data.metas.length > 0) {
                        res.data.metas.forEach(m => {
                            if (m && m.id && m.name && !seenIds.has(m.id)) {
                                seenIds.add(m.id);
                                catMetas.push({ id: m.id, name: m.name, poster: m.poster || null });
                                addedInBatch++;
                            }
                        });
                    }
                }
                if (addedInBatch === 0) hasMore = false; 
                skip += (batchSize * 100);
            }
            return catMetas;
        });

        const results = await Promise.all(catalogPromises);
        results.flat().forEach(m => {
            if (m && m.id) metas.push({ ...m, _providerBase: base, _isDirectStream: false });
        });
    } catch (err) {
        if (err.response && (err.response.status === 403 || err.response.status === 429)) {
            sourceBlocklist.set(cleanInput, Date.now() + 15 * 60 * 1000);
        }
    }

    return metas;
}

// --- SYNC ORCHESTRATOR & BACKGROUND WARM-UP ---
async function getChannelsForSources(sourcesList) {
    const validSources = sourcesList.filter(s => typeof s === 'string' && isValidHttpUrl(s.trim()));
    const cacheKey = validSources.join('|');

    if (!channelsCache[cacheKey]) {
        channelsCache[cacheKey] = { status: 'idle', data: [], sourceReport: {}, timestamp: 0 };
    }

    let cacheObj = channelsCache[cacheKey];

    if (cacheObj.status === 'done' && (Date.now() - cacheObj.timestamp < 6 * 3600 * 1000)) {
        return cacheObj.data;
    }

    if (cacheObj.status === 'syncing') {
        while (channelsCache[cacheKey] && channelsCache[cacheKey].status === 'syncing') {
            await new Promise(r => setTimeout(r, 400));
        }
        return channelsCache[cacheKey] ? channelsCache[cacheKey].data : [];
    }

    cacheObj.status = 'syncing';

    (async () => {
        try {
            let tempChannelsMap = {};
            let sourceReport = {};

            for (let i = 0; i < validSources.length; i++) {
                const sourceInput = validSources[i].trim();
                let cleanUrl = sourceInput.replace(/\/manifest\.json$/, '').trim();
                sourceReport[cleanUrl] = { count: 0, status: 'fetching' };

                try {
                    const metas = await fetchCatalogFromSource(sourceInput);
                    
                    if (metas && metas.length > 0) {
                        sourceReport[cleanUrl] = { count: metas.length, status: 'ok' };
                    } else {
                        sourceReport[cleanUrl] = { count: 0, status: sourceBlocklist.has(cleanInput) ? 'blocked (rate-limit)' : 'empty' };
                    }

                    metas.forEach(meta => {
                        let channelInfo = getChannelData(meta.name || '');
                        if (!channelInfo) return; 

                        const id = channelInfo.id;
                        let finalPoster = meta.poster || DEFAULT_POSTER;

                        if (!tempChannelsMap[id]) {
                            tempChannelsMap[id] = { 
                                id: id, name: channelInfo.name, displayName: channelInfo.name, categories: channelInfo.categories,
                                sortIndex: channelInfo.index, sources: [], poster: finalPoster 
                            };
                        }
                        
                        if (meta._isDirectStream) {
                            const sourceExists = tempChannelsMap[id].sources.find(s => s.directUrl === meta._directUrl);
                            if (!sourceExists) tempChannelsMap[id].sources.push({ type: 'm3u', directUrl: meta._directUrl, sourceIndex: i, originalName: meta.name });
                        } else {
                            const sourceExists = tempChannelsMap[id].sources.find(s => s.metaId === meta.id && s.providerBase === cleanUrl);
                            if (!sourceExists) tempChannelsMap[id].sources.push({ type: 'addon', metaId: meta.id, providerBase: cleanUrl, sourceIndex: i, originalName: meta.name });
                        }
                    });
                } catch (e) {
                    sourceReport[cleanUrl] = { count: 0, status: 'error' };
                }
            }

            let tempChannelsData = Object.values(tempChannelsMap).filter(ch => ch.sources.length > 0);
            tempChannelsData.sort((a, b) => {
                if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
                return a.displayName.localeCompare(b.displayName);
            });

            cacheObj.data = tempChannelsData;
            cacheObj.sourceReport = sourceReport;
            cacheObj.status = 'done';
            cacheObj.timestamp = Date.now();
        } catch (e) {
            cacheObj.status = 'idle';
        }
    })();

    while (cacheObj.status === 'syncing') {
        await new Promise(r => setTimeout(r, 400));
    }
    return cacheObj.data;
}

// ============================================================================
// APP ROUTES & DASHBOARD COMPLET RESTORÉ
// ============================================================================

app.get('/api/metrics', (req, res) => {
    let totalChannels = 0;
    let sourceReport = {};
    let latestCache = null;
    let latestTime = 0;

    for (const [key, val] of Object.entries(channelsCache)) {
        if (val.timestamp > latestTime) {
            latestTime = val.timestamp;
            latestCache = val;
        }
    }

    if (latestCache && latestCache.data) {
        totalChannels = latestCache.data.length;
        sourceReport = latestCache.sourceReport || {};
    }

    let sortedChannels = Object.entries(serverStats.channelClicks)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => ({ id: id.replace('hyb_', ''), count }));

    const uptimeMs = Date.now() - serverStats.startTime;
    const uptimeHours = Math.floor(uptimeMs / 3600000);
    const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);

    const totalCache = serverStats.cacheHits + serverStats.cacheMisses;
    const cacheRate = totalCache > 0 ? Math.round((serverStats.cacheHits / totalCache) * 100) + '%' : 'N/A';

    res.json({
        uptime: `${uptimeHours}h ${uptimeMinutes}m`,
        activeUsers: serverStats.activeIps.size,
        totalRequests: serverStats.totalRequests,
        cacheRate: cacheRate,
        epgCount: Object.keys(epgData).length,
        epgLastUpdate: lastUpdate,
        totalChannels: totalChannels > 1 ? totalChannels : 0,
        topChannels: sortedChannels,
        sourceReport: sourceReport
    });
});

app.get('/api/debug/inspect/:query', async (req, res) => {
    let q = req.params.query.toLowerCase();
    let latestCache = null;
    let latestTime = 0;
    for (const [key, val] of Object.entries(channelsCache)) {
        if (val.timestamp > latestTime) { latestTime = val.timestamp; latestCache = val; }
    }
    if (!latestCache || !latestCache.data) return res.json({ error: "Cache vide. Ouvrez d'abord l'add-on dans Stremio/NuVio." });

    const channel = latestCache.data.find(c => c.id.toLowerCase().includes(q) || c.displayName.toLowerCase().includes(q));
    if (!channel) return res.json({ error: `Chaîne "${q}" introuvable dans le cache actuel.` });

    let inspectionResults = [];
    for (const source of channel.sources) {
        if (source.type === 'm3u') {
            let testRes = { source: source.providerBase || 'M3U Local', type: 'm3u', url: source.directUrl };
            try {
                const r = await axios.get(source.directUrl, { responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4500 });
                if(r.data && typeof r.data.destroy === 'function') r.data.destroy();
                testRes.httpStatus = `✅ En ligne (HTTP ${r.status})`;
            } catch(e) {
                testRes.httpStatus = `❌ Erreur: ${e.response ? 'HTTP ' + e.response.status : e.message}`;
            }
            inspectionResults.push(testRes);
        } else {
            try {
                let targetUrl = `${source.providerBase}/stream/tv/${encodeURIComponent(source.metaId)}.json`;
                if (!isValidHttpUrl(targetUrl)) continue;
                let r = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
                inspectionResults.push({ provider: source.providerBase, metaId: source.metaId, rawResponse: r.data });
            } catch(e) {
                inspectionResults.push({ provider: source.providerBase, error: e.message });
            }
        }
    }
    res.json({ channelName: channel.displayName, channelId: channel.id, inspectionResults });
});

app.get('/', async (req, res) => {
    let sourcesParam = req.query.sources;
    let sourcesList = sourcesParam ? sourcesParam.split(',').map(s => s.trim()).filter(isValidHttpUrl) : ['', ''];
    let defaultQualities = "['1080p', '720p', '4K', 'SD']";

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>HybridTV Dashboard</title>
        <style>
            :root { --bg: #141414; --card: #1f1f1f; --card-alt: #111; --primary: #e50914; --text: #fff; --text-muted: #bbb; --border: #333; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); padding: 40px 20px; margin: 0; }
            .container { max-width: 700px; margin: 0 auto; background: var(--card); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden; }
            .header { padding: 30px; text-align: center; border-bottom: 1px solid var(--border); }
            h1 { margin: 0 0 10px 0; font-size: 28px; }
            .subtitle { font-size: 14px; color: var(--text-muted); margin: 0; }
            .tabs { display: flex; border-bottom: 1px solid var(--border); background: #1a1a1a; overflow-x: auto; }
            .tab-btn { flex: 1; padding: 15px; background: none; border: none; color: var(--text-muted); font-size: 15px; font-weight: bold; cursor: pointer; transition: 0.2s; white-space: nowrap; }
            .tab-btn:hover { color: var(--text); background: #222; }
            .tab-btn.active { color: var(--text); border-bottom: 3px solid var(--primary); background: var(--card); }
            .tab-content { display: none; padding: 30px; }
            .tab-content.active { display: block; }
            .section { background: var(--card-alt); padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid var(--border); }
            .section-title { font-size: 14px; color: #ccc; font-weight: bold; margin-top: 0; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 1px; }
            .source-row { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
            .source-num { font-size: 13px; font-weight: bold; color: var(--primary); min-width: 20px; text-align: center; }
            .source-row input { flex: 1; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px; font-size: 13px; }
            .btn { display: inline-block; background: var(--primary); color: #fff; padding: 12px 24px; font-size: 14px; font-weight: bold; border-radius: 8px; cursor: pointer; border: none; transition: 0.2s; text-align: center; width: 100%; box-sizing: border-box; }
            .btn:hover { background: #f40612; }
            .btn-secondary { background: #333; margin-top: 10px; }
            .btn-secondary:hover { background: #444; }
            .btn-small { background: #444; padding: 8px 10px; font-size: 12px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .btn-small:hover { background: #555; }
            .btn-danger { background: #800; padding: 8px 10px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .btn-danger:hover { background: #a00; }
            .main-link { width: 100%; padding: 15px; margin-top: 15px; background: #111; color: #fff; border: 1px dashed #666; border-radius: 6px; text-align: center; font-size: 14px; box-sizing: border-box; }
            input[type="text"].export-box { width: 100%; padding: 10px; background: #222; border: 1px solid #444; color: #aaa; border-radius: 6px; font-size: 12px; box-sizing: border-box; }
            .metrics-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
            .metric-card { background: #222; padding: 15px; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
            .metric-value { font-size: 24px; font-weight: bold; color: var(--primary); margin: 10px 0 5px 0; }
            .metric-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; }
            ul.report-list { list-style: none; padding: 0; margin: 0; font-size: 13px; }
            ul.report-list li { padding: 8px 0; border-bottom: 1px solid #333; display: flex; justify-content: space-between; }
            ul.report-list li:last-child { border-bottom: none; }
            .status-ok { color: #4caf50; } .status-warn { color: #ff9800; } .status-err { color: #f44336; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>📺 HybridTV Dashboard</h1>
                <p class="subtitle">L'expérience IPTV centralisée, synchrone et optimisée (v1.0.9)</p>
            </div>
            <div class="tabs">
                <button class="tab-btn active" onclick="switchTab('config', this)">⚙️ Configurer</button>
                <button class="tab-btn" onclick="switchTab('metrics', this)">📊 Métriques</button>
                <button class="tab-btn" onclick="switchTab('debug', this)">🔍 Debug Flux</button>
            </div>
            <div id="config" class="tab-content active">
                <div class="section">
                    <h3 class="section-title">Sources (Add-ons ou M3U)</h3>
                    <div id="sourcesContainer"></div>
                    <button type="button" onclick="addSourceField()" class="btn btn-small" style="margin-top: 10px;">+ Ajouter une source</button>
                </div>
                <div class="section">
                    <h3 class="section-title">Priorité de Qualité</h3>
                    <div id="qualityList" style="display: flex; flex-direction: column; gap: 8px;"></div>
                </div>
                <div class="section">
                    <h3 class="section-title">Code de Sauvegarde</h3>
                    <input type="text" id="exportTokenBox" class="export-box" readonly>
                    <button type="button" onclick="importToken()" class="btn btn-small" style="margin-top: 8px;">📥 Importer</button>
                </div>
                <button type="button" onclick="generateLink()" class="btn">⚡ Générer l'Add-on</button>
                <input type="text" id="manifestLink" class="main-link" readonly>
                <button type="button" onclick="copyLink()" class="btn btn-secondary">📋 Copier le lien</button>
            </div>
            <div id="metrics" class="tab-content">
                <div class="metrics-grid">
                    <div class="metric-card"><div class="metric-label">Uptime</div><div class="metric-value" id="m-uptime">--</div></div>
                    <div class="metric-card"><div class="metric-label">Utilisateurs Actifs (5m)</div><div class="metric-value" id="m-users">--</div></div>
                    <div class="metric-card"><div class="metric-label">Requêtes Totales</div><div class="metric-value" id="m-req">--</div></div>
                    <div class="metric-card"><div class="metric-label">Performance Cache</div><div class="metric-value" id="m-cache">--</div></div>
                </div>
                <div class="section">
                    <h3 class="section-title">Rapport des Sources</h3>
                    <ul class="report-list" id="sourceReportList"><li><i>Chargement...</i></li></ul>
                </div>
            </div>
            <div id="debug" class="tab-content">
                <div class="section">
                    <h3 class="section-title">🔍 Inspecteur & Testeur de Flux</h3>
                    <div style="display: flex; gap: 8px; margin-bottom: 15px;">
                        <input type="text" id="debugQuery" placeholder="Nom de la chaîne..." style="flex: 1; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px;">
                        <button type="button" onclick="runDebug()" class="btn-small" style="padding: 10px 15px; font-weight: bold;">Tester les flux</button>
                    </div>
                    <pre id="debugOutput" style="background: #111; padding: 12px; border-radius: 6px; font-size: 11px; color: #00ffcc; max-height: 400px; overflow-y: auto;">En attente de test...</pre>
                </div>
            </div>
        </div>
        <script>
            let sources = ${JSON.stringify(sourcesList)};
            let qualities = ${defaultQualities};
            function switchTab(tabId, btn) {
                document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
                document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
                document.getElementById(tabId).classList.add('active');
                btn.classList.add('active');
                if(tabId === 'metrics') fetchMetrics();
            }
            async function runDebug() {
                let q = document.getElementById('debugQuery').value.trim();
                if(!q) return alert("Entrez un nom de chaîne !");
                document.getElementById('debugOutput').innerText = "Test en cours...";
                try {
                    let res = await fetch('/api/debug/inspect/' + encodeURIComponent(q));
                    let data = await res.json();
                    document.getElementById('debugOutput').innerText = JSON.stringify(data, null, 2);
                } catch(e) { document.getElementById('debugOutput').innerText = "Erreur : " + e.message; }
            }
            function renderSources() {
                const container = document.getElementById('sourcesContainer');
                if (!container) return;
                container.innerHTML = '';
                sources.forEach((src, index) => {
                    if (index >= 5) return;
                    const div = document.createElement('div');
                    div.className = 'source-row';
                    div.innerHTML = \`<span class="source-num">#\${index + 1}</span><input type="text" id="src_\${index}" value="\${src}" placeholder="URL manifest.json ou .m3u">\`;
                    container.appendChild(div);
                });
                updateExportToken();
            }
            function renderQualities() {
                const container = document.getElementById('qualityList');
                if (!container) return;
                container.innerHTML = '';
                qualities.forEach((q, index) => {
                    container.innerHTML += \`<div style="display: flex; align-items: center; background: #222; border: 1px solid #444; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px;"><span style="flex:1;">\${q}</span></div>\`;
                });
                updateExportToken();
            }
            function addSourceField() { if (sources.length < 5) { sources.push(''); renderSources(); } }
            function updateExportToken() {
                sources.forEach((_, index) => { const el = document.getElementById('src_' + index); if (el) sources[index] = el.value.trim(); });
                const valid = sources.filter(s => s.length > 0);
                document.getElementById('exportTokenBox').value = btoa(JSON.stringify({ sources: valid, qualities: qualities }));
            }
            function importToken() {
                let code = prompt("Code de sauvegarde :");
                if (!code) return;
                try {
                    const cfg = JSON.parse(atob(code.trim()));
                    if (cfg.sources) { sources = cfg.sources; renderSources(); alert("Importé !"); }
                } catch(e) { alert("Invalide."); }
            }
            function generateLink() {
                updateExportToken();
                const token = document.getElementById('exportTokenBox').value;
                document.getElementById("manifestLink").value = window.location.protocol + "//" + window.location.host + "/" + token + "/manifest.json";
                alert("Lien généré !");
            }
            function copyLink() { document.getElementById("manifestLink").select(); document.execCommand("copy"); alert("Copié !"); }
            async function fetchMetrics() {
                try {
                    let res = await fetch('/api/metrics');
                    let data = await res.json();
                    document.getElementById('m-uptime').innerText = data.uptime;
                    document.getElementById('m-users').innerText = data.activeUsers;
                    document.getElementById('m-req').innerText = data.totalRequests;
                    document.getElementById('m-cache').innerText = data.cacheRate;
                    let htmlList = '';
                    for(let [k, v] of Object.entries(data.sourceReport)) {
                        htmlList += \`<li><span>\${k}</span> <b class="status-\${v.status === 'ok' ? 'ok' : 'warn'}">\${v.status} (\${v.count})</b></li>\`;
                    }
                    document.getElementById('sourceReportList').innerHTML = htmlList || '<li>Aucune source</li>';
                } catch(e){}
            }
            renderSources(); renderQualities();
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.get('/:config/manifest.json', (req, res) => {
    res.setHeader('Cache-Control', 'max-age=86400, public');
    res.json({
        id: 'org.hybridtv.meta', 
        version: '1.0.9',
        name: 'HybridTV',
        description: 'Meta-Addon IPTV Universel (v1.0.9)',
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
            { type: 'tv', id: 'events', name: '🔴 Événements & Lives' },
            { type: 'tv', id: 'autres', name: '📂 Autres' }
        ],
        behaviorHints: { configurable: true }
    });
});

app.get(['/:config/catalog/tv/:id.json', '/:config/catalog/tv/:id/:extra'], async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ metas: [] });
    let channelsData = await getChannelsForSources(config.sources);
    res.setHeader('Cache-Control', 'max-age=14400, public');
    let skip = 0;
    if (req.params.extra) {
        const skipMatch = req.params.extra.match(/skip=(\d+)/);
        if (skipMatch) skip = parseInt(skipMatch[1], 10);
    }
    const filtered = channelsData.filter(ch => ch.categories.includes(req.params.id));
    res.json({ metas: filtered.slice(skip, skip + 100).map(ch => ({ id: ch.id, type: 'tv', name: ch.displayName, poster: ch.poster, posterShape: 'square' })) });
});

app.get('/:config/meta/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    let channelsData = await getChannelsForSources(config.sources);
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });
    res.json({ meta: { id: channel.id, type: 'tv', name: channel.displayName, poster: channel.poster, posterShape: 'square', description: `Diffusion en direct sur ${channel.displayName}` } });
});

// --- ROUTE STREAM OPTIMISÉE (SANS TIMEOUT CRITIQUE & PROTECTION RATE LIMITING) ---
app.get('/:config/stream/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ streams: [] });
    
    serverStats.channelClicks[req.params.id] = (serverStats.channelClicks[req.params.id] || 0) + 1;
    const cacheKey = req.params.id + '|' + config.sources.join(',');

    if (streamResponseCache.has(cacheKey)) {
        serverStats.cacheHits++;
        return res.json({ streams: streamResponseCache.get(cacheKey) });
    }
    if (streamCache.has(cacheKey)) {
        serverStats.cacheHits++;
        return res.json({ streams: streamCache.get(cacheKey) });
    }
    serverStats.cacheMisses++;

    let channelsData = await getChannelsForSources(config.sources);
    res.setHeader('Cache-Control', 'max-age=45, public'); 

    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });
    
    try {
        let streamPromises = channel.sources.map(async (source) => {
            let isBeluchon = source.providerBase && source.providerBase.toLowerCase().includes('beluchon');

            if (source.type === 'm3u') {
                if (!source.directUrl || !isValidHttpUrl(source.directUrl)) return [];
                return [{
                    url: source.directUrl,
                    name: isBeluchon ? `▶ Source Officielle (HD)` : `▶ Full HD (1080p)`,
                    title: source.originalName || "Source M3U",
                    _score: isBeluchon ? 4500 : 1500,
                    behaviorHints: { proxyHeaders: { request: { 'User-Agent': 'Mozilla/5.0', 'Referer': source.providerBase || 'https://vavoo.to/' } } }
                }];
            }

            try {
                let targetUrl = `${source.providerBase}/stream/tv/${encodeURIComponent(source.metaId)}.json`;
                if (!isValidHttpUrl(targetUrl)) return [];

                const streamRes = await axios.get(targetUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, 
                    timeout: 3500 // Augmenté à 3500ms pour éviter les faux timeouts sous NuVio
                });
                
                if (streamRes.data && streamRes.data.streams) {
                    return streamRes.data.streams.map((s, idx) => {
                        if (!s.url || !isValidHttpUrl(s.url)) return null;

                        let score = 0;
                        let rawName = s.name || '';
                        let rawTitle = s.title || '';
                        let originalTitle = (rawName !== rawTitle) ? `${rawName} ${rawTitle}` : rawName || rawTitle;
                        originalTitle = originalTitle.replace(/http\S+/g, '').trim() || `Source Add-on ${idx + 1}`;

                        let up = originalTitle.toUpperCase();
                        let nStream = up.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\+/g, 'PLUS').replace(/[^A-Z0-9]/g, '');

                        let penalty = 0;
                        if (channel.id.startsWith('hyb_canal_') && !channel.id.includes('live') && channel.id !== 'hyb_aut_canal_elles') {
                            let isBaseCanal = (channel.id === 'hyb_canal_cplus');
                            if (isBaseCanal) {
                                if (nStream.match(/(SPORT|FOOT|CINE|CNEMA|DECALE|KIDS|DOC|BOX|GRAND|SERIE|PREMIER|FRISSON|EMOTION|FAMIZ|CLUB|CLASSIC|COMEDIE|F1|MOTO|360|FAMILY|LIGUE1|DAZN|BEIN|MULTI|ELLES)/)) penalty += 5000;
                            }
                        }

                        let detectedQual = 'SD';
                        if (up.includes('4K') || up.includes('2160') || up.includes('UHD')) detectedQual = '4K';
                        else if (up.includes('FHD') || up.includes('1080')) detectedQual = '1080p';
                        else if (up.includes('HD') || up.includes('720')) detectedQual = '720p';

                        let priorityIndex = config.qualities.indexOf(detectedQual);
                        if (priorityIndex === -1) priorityIndex = 3; 
                        let qScore = (4 - priorityIndex) * 1000; 
                        let qualStr = detectedQual === '4K' ? "4K (UHD)" : detectedQual === '1080p' ? "Full HD (1080p)" : detectedQual === '720p' ? "HD (720p)" : "SD";

                        if (isBeluchon) { qualStr = "Source Officielle Légale (HD)"; qScore = 5000; }

                        score += qScore;
                        score -= penalty;
                        score -= idx; 
                        score += (10 - source.sourceIndex) * 50;

                        let outStream = { ...s };
                        let rawUrl = outStream.url.trim();
                        if (rawUrl.startsWith('//')) outStream.url = 'https:' + rawUrl;
                        else if (rawUrl.startsWith('/')) {
                            try { let baseObj = new URL(source.providerBase); outStream.url = baseObj.origin + rawUrl; } catch(e){}
                        }

                        if (!outStream.behaviorHints) outStream.behaviorHints = {};
                        if (!outStream.behaviorHints.notWebReady) outStream.behaviorHints.notWebReady = true;

                        outStream.name = s.name ? s.name : (source.originalName || "Source Add-on");
                        outStream.title = (s.title || s.description || "") ? `${s.title || s.description}\n▶ ${qualStr}` : `▶ ${qualStr}`;
                        outStream._score = score;
                        return outStream;
                    }).filter(Boolean);
                }
            } catch (err) {}
            return [];
        });

        let results = await Promise.allSettled(streamPromises);
        let allStreams = [];
        results.forEach(r => { if (r.status === 'fulfilled' && Array.isArray(r.value)) allStreams.push(...r.value); });

        allStreams.sort((a, b) => b._score - a._score);
        let limitedStreams = allStreams.slice(0, 15).map((s) => {
            let streamObj = { ...s };
            delete streamObj._score; 
            return streamObj;
        });
        
        if (limitedStreams.length > 0) {
            streamCache.set(cacheKey, limitedStreams);
            streamResponseCache.set(cacheKey, limitedStreams);
            setTimeout(() => streamResponseCache.delete(cacheKey), 60000);
            setTimeout(() => streamCache.delete(cacheKey), 45000); 
        }

        res.json({ streams: limitedStreams });
    } catch (err) { res.json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`[INFO] Server started on port ${PORT} (HybridTV v1.0.9 STABLE)`);
    updateEPG(); 
    setInterval(updateEPG, 3600000); 
});
