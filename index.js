/**
 * HybridTV - IPTV Meta-Addon
 * Version: 1.2.13 (Restored Full EPG, Complete Channel Map, RAM Metrics & Table Debugger)
 * Core Engine: Synchronous Health Check (6.5s), Smart Cache, Strict Category Separation, HLS Proxy Relay.
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');
const urlModule = require('url');

const app = express();
app.use(cors());

// --- TELEMETRY & CACHING STATE ---
let isUpdatingEPG = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let epgData = {}; 
let channelsCache = {}; 
let streamCache = new Map(); 

const serverStats = {
    startTime: Date.now(),
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    channelClicks: {},
    activeIps: new Map()
};

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

const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';
const EVENT_POSTER = 'https://cdn-icons-png.flaticon.com/512/861/861512.png';

const BLACKLIST = [
    'ALACARTE', 'DISNEYPLUS', 'NETFLIX', 'PRIMEVIDEO', 'APPLETV',
    'TEST', 'MIRROR', 'BACKUPCHANNEL', 'BOXOFFICE1', 'BOXOFFICE2', 'CANALPLAY', 'AFRIQUE', 'DEUTSCH', 'GERMAN'
];

function parseConfig(encodedConfig) {
    try {
        if (!encodedConfig || encodedConfig === 'manifest.json') {
            return { sources: [], qualities: ['1080p', '720p', '4K', 'SD'], languages: ['fr', 'en', 'es', 'other'] };
        }
        const jsonStr = Buffer.from(encodedConfig, 'base64').toString('utf8');
        let parsed = JSON.parse(jsonStr);
        if (!parsed.qualities || !Array.isArray(parsed.qualities)) parsed.qualities = ['1080p', '720p', '4K', 'SD'];
        if (!parsed.languages || !Array.isArray(parsed.languages)) parsed.languages = ['fr', 'en', 'es', 'other'];
        return parsed;
    } catch (e) {
        return { sources: [], qualities: ['1080p', '720p', '4K', 'SD'], languages: ['fr', 'en', 'es', 'other'] };
    }
}

// --- DÉTECTION STRICTE DES ÉVÉNEMENTS ---
function extractMatchEvent(rawName) {
    if (!rawName) return null;
    let s = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();

    let isMatch = false;
    let eventName = '';

    if (s.includes('MATCH TIME') || s.includes('MATCHTIME') || s.includes('[LIVE]') || s.includes('🔴') || s.includes('VS')) {
        let cleanName = s.replace(/^(?:FR|BE|CH|VIP|LIVE|DIRECT|EVENT|MATCH|LIGUE\s*1|DAZN|BEIN|RMC|CANAL\+?|MULTI|MULTIPLEX|\[LIVE\]|🔴)\s*[:|-|\|]*\s*/gi, '')
                         .replace(/\d{1,2}[hH:]\d{2}/g, '')
                         .replace(/\b(?:FHD|HD|SD|4K|1080P|720P|MATCH\s*TIME|MATCHTIME)\b/gi, '')
                         .replace(/[^A-Z0-9\s-]/g, '').trim();
        if (cleanName.length < 3) cleanName = "Événement En Direct";
        return { id: 'hyb_ev_' + toSyncId(cleanName), name: '🔴 ' + cleanName, categories: ['events'], index: 5, customPoster: EVENT_POSTER };
    }

    let vsMatch = s.match(/([A-Z0-9\s]{3,20})\s+(?:VS\.?|CONTRE|\bV\b|\bVERSUS\b|-)\s+([A-Z0-9\s]{3,20})/i);
    if (vsMatch) {
        isMatch = true; 
        eventName = `${vsMatch[1].trim()} vs ${vsMatch[2].trim()}`;
    }

    if (isMatch) {
        const cleanTeam = (str) => {
            return str.replace(/^(?:FR|BE|CH|VIP|1080P|720P|4K|HD|SD|LIVE|DIRECT|EVENT|MATCH)\s*[:|-|\|]*/gi, '')
                      .replace(/\b(?:FHD|HD|SD|4K|1080P|720P|LIVE|DIRECT)\b/gi, '')
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
    return null;
}

// --- CATALOGUE DES CHAÎNES COMPLET ET RESTAURÉ ---
function getChannelData(rawName, catalogHint = '') {
    if (!rawName) return null;
    
    if (catalogHint === 'events' || catalogHint === 'sports') {
        let eventData = extractMatchEvent(rawName);
        if (eventData) return eventData;
    }

    let eventData = extractMatchEvent(rawName);
    if (eventData && (rawName.includes('vs') || rawName.includes('VS') || rawName.includes('🔴') || rawName.includes('LIVE'))) {
        return eventData;
    }

    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
    n = n.replace(/^(?:FR|BE|CH|CA|VIP|VAVOO)\s*[:|/-]+\s*/i, '');
    n = n.replace(/DURING EVENT ONLY/g, '').replace(/EVENT ONLY/g, '');
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'DIRECT', 'RAW', 'ACCESS'];
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'gi'), ''); });

    if (n.includes('LFL') || n.includes('LEAGUE OF LEGENDS') || n.includes('LOL LFL')) {
        return { id: 'hyb_esport_lfl', name: 'LFL (eSport)', categories: ['autres'], index: 10 };
    }

    n = n.replace(/\+/g, 'PLUS');

    if ((n.includes('DAZN') || n.includes('DAZONE')) && (n.includes('RISE') || n.includes('WOMEN') || n.includes('FEMME'))) {
        return { id: 'hyb_sport_dazn_rise', name: 'DAZN Rise', categories: ['sports'], index: 999 };
    }

    if (n.includes('LIGUE 1') || n.includes('LIGUE1') || n.match(/\bL1\b/) || n.includes('LEAGUE 1') || (n.includes('DAZN') && n.includes('LIVE'))) {
        let m = n.match(/(?:LIVE|PLUS|LIGUE\s*1|L1|LIGUE1)[^\d]*([1-9]|1[0-8])/i);
        let num = m ? m[1] : '1';
        return { id: 'hyb_sport_ligue1plus_' + num, name: num === '1' ? 'Ligue 1+' : 'Ligue 1+ ' + num, categories: ['sports'], index: 10 + parseInt(num, 10) };
    }

    if (n.includes('DAZN') || n.includes('DAZONE')) {
        let m = n.match(/(?:DAZN|DAZONE)[^\d]*([1-9]|1[0-8])/i);
        let num = m ? m[1] : '1';
        return { id: 'hyb_sport_dazn_'+num, name: 'DAZN '+num, categories: ['sports'], index: 30 + parseInt(num, 10) };
    }

    let c = n.replace(/[^A-Z0-9]/g, '');
    if (!c || c.length < 2) return null;
    if (BLACKLIST.some(b => c.includes(b))) return null;

    if (c.includes('BEINSPORT') || c.includes('BEIN')) {
        let isMax = c.includes('MAX'); let m = c.match(/BEIN(?:SPORT|MAX)?S?(\d+)/); let num = (m && m[1]) ? m[1] : '1';
        return { id: 'hyb_sport_bein_' + (isMax?'max':'') + num, name: isMax ? 'beIN SPORTS MAX '+num : 'beIN SPORTS '+num, categories: ['sports'], index: isMax ? 70 + parseInt(num, 10) : 50 + parseInt(num, 10) };
    }
    
    if (c.includes('EUROSPORT')) {
        let is360 = c.includes('360'); let m = c.match(/EUROSPORT(?:360)?(\d+)/); let num = (m && m[1]) ? m[1] : '1';
        if (is360) return { id: 'hyb_sport_euro360_'+num, name: 'Eurosport 360 - '+num, categories: ['sports'], index: 110 + parseInt(num, 10) };
        return { id: 'hyb_sport_euro_'+num, name: 'Eurosport '+num, categories: ['sports'], index: 90 + parseInt(num, 10) };
    }
    
    if (c.includes('RMCSPORT') || (c.includes('RMC') && c.includes('LIVE'))) {
        let isLive = c.includes('LIVE'); let m = c.match(/RMCSPORT(?:LIVE)?(\d+)/); let num = (m && m[1]) ? m[1] : '1';
        if (isLive) return { id: 'hyb_sport_rmclive_'+num, name: 'RMC Sport Live '+num, categories: ['sports'], index: 150 + parseInt(num, 10) };
        return { id: 'hyb_sport_rmc_'+num, name: 'RMC Sport '+num, categories: ['sports'], index: 130 + parseInt(num, 10) };
    }
    
    if (c.includes('OLTV') || c.includes('OLYMPIQUELYONNAIS')) return { id: 'hyb_sport_oltv', name: 'OL TV', categories: ['sports'], index: 170 };
    
    if (c.includes('SPORTTV')) {
        let m = c.match(/SPORTTV(\d+)/); let num = m ? m[1] : '1';
        return { id: 'hyb_sport_sporttv_' + num, name: 'SPORT TV ' + num, categories: ['sports'], index: 180 + parseInt(num, 10) };
    }
    if (c.includes('EQUIDIA')) return { id: 'hyb_sport_equidia', name: 'Equidia', categories: ['sports'], index: 200 };
    if (c.includes('LEQUIPE')) return { id: 'hyb_sport_lequipe', name: "L'Équipe", categories: ['sports', 'tnt'], index: 210 };

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
        if (c.includes('CANALJ') || c.includes('CJ')) return { id: 'hyb_jeu_canalj', name: 'Canal J', categories: ['jeunesse', 'canal'], index: 100 };
        if (c.includes('KIDS')) return { id: 'hyb_canal_kids', name: 'Canal+ Kids', categories: ['canal', 'jeunesse'], index: 101 };
        if (c.includes('LIVE')) {
            let m = c.match(/LIVE(\d+)/); let num = m ? m[1] : '1';
            return { id: 'hyb_canal_live_' + num, name: 'Canal+ Live ' + num, categories: ['canal', 'sports'], index: 220 + parseInt(num, 10) };
        }
        if (c.includes('SPORT360') || c.includes('360')) return { id: 'hyb_canal_sport360', name: 'Canal+ Sport 360', categories: ['canal', 'sports'], index: 90 };
        if (c.includes('FOOT')) return { id: 'hyb_canal_foot', name: 'Canal+ Foot', categories: ['canal', 'sports'], index: 91 };
        if (c.includes('FORMULA1') || c.includes('F1')) return { id: 'hyb_canal_f1', name: 'Canal+ Formula 1', categories: ['canal', 'sports'], index: 93 };
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
    if (c.includes('GULLI')) return { id: 'hyb_jeu_gulli', name: 'Gulli', categories: ['jeunesse', 'tnt'], index: 18 };
    if (c.includes('CSTAR')) return { id: 'hyb_tnt_17', name: 'CStar', categories: ['tnt', 'musique'], index: 17 };
    if (c.includes('6TER')) return { id: 'hyb_tnt_22', name: '6ter', categories: ['tnt'], index: 22 };
    if (c.includes('RMCSTORY') || c.includes('NUMERO23')) return { id: 'hyb_tnt_23', name: 'RMC Story', categories: ['tnt', 'decouverte'], index: 23 };
    if (c.includes('RMCDECOUVERTE')) return { id: 'hyb_tnt_24', name: 'RMC Découverte', categories: ['tnt', 'decouverte'], index: 24 };
    if (c.includes('CHERIE25') || c === 'CHERIE') return { id: 'hyb_tnt_25', name: 'Chérie 25', categories: ['tnt'], index: 25 };
    if (c.includes('13EMERUE') || c.includes('13RUE')) return { id: 'hyb_tnt_13rue', name: '13ème Rue', categories: ['tnt', 'cinema'], index: 30 };
    if (c.includes('TEVA')) return { id: 'hyb_tnt_teva', name: 'Téva', categories: ['tnt'], index: 31 };
    if (c.includes('RTL9')) return { id: 'hyb_tnt_rtl9', name: 'RTL9', categories: ['tnt', 'cinema'], index: 32 };
    if (c.includes('AB1')) return { id: 'hyb_tnt_ab1', name: 'AB1', categories: ['tnt'], index: 33 };

    if (c.includes('CARTOONITO')) return { id: 'hyb_jeu_cartoonito', name: 'Cartoonito', categories: ['jeunesse'], index: 150 };
    if (c.includes('CARTOON')) return { id: 'hyb_jeu_cartoon', name: 'Cartoon Network', categories: ['jeunesse'], index: 1 };
    if (c.includes('DISNEYXD')) return { id: 'hyb_jeu_disneyxd', name: 'Disney XD', categories: ['jeunesse'], index: 3 };
    if (c.includes('DISNEYJR') || c.includes('DISNEYJUNIOR') || (c.includes('DISNEY') && c.includes('JR'))) return { id: 'hyb_jeu_disneyjr', name: 'Disney Junior', categories: ['jeunesse'], index: 5 };
    if (c.includes('DISNEY') && c.includes('PLUS1')) return { id: 'hyb_jeu_disney_plus1', name: 'Disney Channel +1', categories: ['jeunesse'], index: 50 };
    if (c.includes('DISNEY')) return { id: 'hyb_jeu_disney', name: 'Disney Channel', categories: ['jeunesse'], index: 2 };
    if (c.includes('BOOMERANG')) return { id: 'hyb_jeu_boom', name: 'Boomerang', categories: ['jeunesse'], index: 5 };
    if (c.includes('BOING')) return { id: 'hyb_jeu_boing', name: 'Boing', categories: ['jeunesse'], index: 6 };
    if (c.includes('NICKELODEON') || c.includes('NICK')) return { id: 'hyb_jeu_nick', name: 'Nickelodeon', categories: ['jeunesse'], index: 7 };
    if (c.includes('TIJI')) return { id: 'hyb_jeu_tiji', name: 'Tiji', categories: ['jeunesse'], index: 9 };
    if (c.includes('MANGAS')) return { id: 'hyb_jeu_mangas', name: 'Mangas', categories: ['jeunesse'], index: 10 };
    if (c.includes('GAMEONE') || c.match(/\bG1\b/) || c === 'G1') return { id: 'hyb_jeu_gameone', name: 'Game One', categories: ['jeunesse'], index: 11 };
    if (c.includes('PIWI')) return { id: 'hyb_jeu_piwi', name: 'Piwi+', categories: ['jeunesse'], index: 100 };

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

// --- EPG SYNC ENGINE ---
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

// --- CATALOG ENGINE ---
async function fetchCatalogFromSource(sourceInput) {
    let metas = [];
    let cleanInput = sourceInput.trim();
    if (!cleanInput) return metas;

    if (cleanInput.endsWith('.m3u') || cleanInput.endsWith('.m3u8') || cleanInput.includes('get.php') || cleanInput.includes('/live/')) {
        try {
            const res = await axios.get(cleanInput, { timeout: 10000 });
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
                    if (currentName) {
                        let streamUrl = line;
                        let metaId = Buffer.from(streamUrl).toString('base64');
                        metas.push({ id: metaId, name: currentName, poster: currentLogo, _isDirectStream: true, _directUrl: streamUrl });
                    }
                    currentLogo = DEFAULT_POSTER;
                    currentName = '';
                }
            }
        } catch (e) {}
        return metas;
    }

    if (cleanInput.includes('manifest.json')) {
        try {
            let cleanUrl = cleanInput;
            const base = cleanUrl.replace(/\/manifest\.json$/, '');

            const manifestRes = await axios.get(cleanUrl, { timeout: 8000 });
            const catalogs = manifestRes.data.catalogs || [];
            const isEventAddon = cleanUrl.toLowerCase().includes('sport') || cleanUrl.toLowerCase().includes('live') || cleanUrl.toLowerCase().includes('event') || cleanUrl.toLowerCase().includes('match');

            const catalogPromises = catalogs.map(async (catalog) => {
                let catMetas = []; 
                let hasMore = true; 
                let skip = 0;
                const maxSkip = 100000; 
                const batchSize = 5;
                let seenIds = new Set(); 

                while (hasMore && skip < maxSkip) {
                    let requests = [];
                    for (let i = 0; i < batchSize; i++) {
                        let currentSkip = skip + (i * 100);
                        let encodedCatId = encodeURIComponent(catalog.id);
                        let url = currentSkip > 0 ? `${base}/catalog/${catalog.type}/${encodedCatId}/skip=${currentSkip}.json` : `${base}/catalog/${catalog.type}/${encodedCatId}.json`;
                        requests.push(axios.get(url, { timeout: 10000 }).catch(e => null));
                    }
                    
                    let responses = await Promise.all(requests);
                    let addedInBatch = 0;
                    
                    for (let res of responses) {
                        if (res && res.data && res.data.metas && res.data.metas.length > 0) {
                            res.data.metas.forEach(m => {
                                if (m && m.id && m.name && !seenIds.has(m.id)) {
                                    seenIds.add(m.id);
                                    let metaName = m.name;
                                    if (isEventAddon && !metaName.includes('🔴') && !metaName.includes('[LIVE]')) {
                                        metaName = `🔴 ${metaName}`;
                                    }
                                    catMetas.push({ id: m.id, name: metaName, poster: m.poster || null });
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
            return metas;
        } catch (err) { return metas; }
    }

    return metas;
}

// --- SYNC ORCHESTRATOR ---
async function getChannelsForSources(sourcesList) {
    const cacheKey = sourcesList.join('|');

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
            let originalOrderCounter = 0;

            for (let i = 0; i < sourcesList.length; i++) {
                const sourceInput = sourcesList[i].trim();
                if (!sourceInput) continue;
                
                let cleanUrl = sourceInput.replace(/\/manifest\.json$/, '').trim();
                sourceReport[cleanUrl] = { count: 0, status: 'fetching' };

                try {
                    const metas = await fetchCatalogFromSource(sourceInput);
                    
                    if (metas && metas.length > 0) {
                        sourceReport[cleanUrl] = { count: metas.length, status: 'ok' };
                    } else {
                        sourceReport[cleanUrl] = { count: 0, status: 'empty' };
                    }

                    metas.forEach(meta => {
                        let channelInfo = getChannelData(meta.name || '');
                        if (!channelInfo) return; 

                        const id = channelInfo.id;
                        let finalPoster = meta.poster || DEFAULT_POSTER;

                        if (!tempChannelsMap[id]) {
                            tempChannelsMap[id] = { 
                                id: id, name: channelInfo.name, displayName: channelInfo.name, categories: channelInfo.categories,
                                sortIndex: channelInfo.index, sources: [], poster: finalPoster,
                                originalOrder: originalOrderCounter++
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
                if (a.sortIndex !== 300 || b.sortIndex !== 300) {
                    if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
                }
                return a.originalOrder - b.originalOrder;
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
// HLS PROXY RESOLVER
// ============================================================================

app.get('/proxy/hls', async (req, res) => {
    const targetUrl = req.query.url;
    const customReferer = req.query.referer;
    if (!targetUrl) return res.status(400).send("Paramètre URL manquant");

    try {
        let headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*'
        };

        if (customReferer) {
            headers['Referer'] = customReferer;
            try {
                let u = new URL(customReferer);
                headers['Origin'] = u.origin;
            } catch (e) {}
        } else {
            try {
                let u = new URL(targetUrl);
                headers['Referer'] = u.origin + '/';
                headers['Origin'] = u.origin;
            } catch (e) {}
        }

        const isPlaylist = targetUrl.includes('.m3u8') || req.query.type === 'playlist';

        if (isPlaylist) {
            const response = await axios.get(targetUrl, { headers, timeout: 6000, responseType: 'text' });
            let content = response.data;
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            const serverHost = `${req.protocol}://${req.get('host')}`;

            let rewrittenLines = content.split('\n').map(line => {
                let cleanLine = line.trim();
                if (!cleanLine || cleanLine.startsWith('#')) return line;

                let segmentAbsoluteUrl = cleanLine.startsWith('http') ? cleanLine : urlModule.resolve(baseUrl, cleanLine);
                let proxyUrl = `${serverHost}/proxy/hls?url=${encodeURIComponent(segmentAbsoluteUrl)}`;
                if (customReferer) proxyUrl += `&referer=${encodeURIComponent(customReferer)}`;
                return proxyUrl;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(rewrittenLines.join('\n'));
        } else {
            const response = await axios.get(targetUrl, { headers, timeout: 8000, responseType: 'stream' });
            res.setHeader('Access-Control-Allow-Origin', '*');
            if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
            response.data.pipe(res);
        }
    } catch (err) {
        res.status(502).send("Erreur de relais proxy : " + err.message);
    }
});

// ============================================================================
// APP ROUTES & METRICS / DEBUGGER API
// ============================================================================

app.get('/api/metrics', (req, res) => {
    let totalChannels = 0;
    let sourceReport = {};
    let latestCache = null;
    let latestTime = 0;
    let categoryCounts = { tnt: 0, sports: 0, events: 0, cinema: 0, info: 0, autres: 0 };

    for (const [key, val] of Object.entries(channelsCache)) {
        if (val.timestamp > latestTime) {
            latestTime = val.timestamp;
            latestCache = val;
        }
    }

    if (latestCache && latestCache.data) {
        totalChannels = latestCache.data.length;
        sourceReport = latestCache.sourceReport || {};
        latestCache.data.forEach(ch => {
            ch.categories.forEach(cat => {
                if (categoryCounts[cat] !== undefined) categoryCounts[cat]++;
                else categoryCounts.autres++;
            });
        });
    }

    const uptimeMs = Date.now() - serverStats.startTime;
    const uptimeHours = Math.floor(uptimeMs / 3600000);
    const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);

    const memUsage = process.memoryUsage();
    const ramUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);

    res.json({
        uptime: `${uptimeHours}h ${uptimeMinutes}m`,
        ramUsed: `${ramUsedMB} Mo`,
        activeUsers: serverStats.activeIps.size,
        totalRequests: serverStats.totalRequests,
        totalChannels: totalChannels,
        categoryCounts: categoryCounts,
        epgLastUpdate: lastUpdate,
        sourceReport: sourceReport
    });
});

app.get('/api/channels/list', async (req, res) => {
    let sourcesParam = req.query.sources;
    if (!sourcesParam) return res.json({ channels: [] });
    let sourcesList = sourcesParam.split(',');
    let channelsData = await getChannelsForSources(sourcesList);
    
    let list = channelsData.map(c => ({
        id: c.id,
        name: c.displayName,
        category: c.categories.join(', '),
        sourcesCount: c.sources.length
    }));
    res.json({ channels: list });
});

app.get('/api/debug/test', async (req, res) => {
    let channelId = req.query.channelId;
    let sourcesParam = req.query.sources;
    if (!channelId || !sourcesParam) return res.json({ error: "Paramètres manquants" });

    let sourcesList = sourcesParam.split(',');
    let channelsData = await getChannelsForSources(sourcesList);
    let channel = channelsData.find(c => c.id === channelId);

    if (!channel) return res.json({ error: "Élément introuvable dans le cache" });

    let results = [];
    for (let source of channel.sources) {
        let streamUrl = '';
        let info = { type: source.type, originalName: source.originalName, provider: source.providerBase || 'Direct M3U' };
        
        if (source.type === 'm3u') {
            streamUrl = source.directUrl;
        } else {
            try {
                let targetUrl = `${source.providerBase}/stream/tv/${encodeURIComponent(source.metaId)}.json`;
                const streamRes = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
                if (streamRes.data && streamRes.data.streams && streamRes.data.streams.length > 0) {
                    streamUrl = streamRes.data.streams[0].url;
                    info.title = streamRes.data.streams[0].title || streamRes.data.streams[0].name;
                }
            } catch (e) {
                info.error = e.message;
            }
        }

        info.resolvedUrl = streamUrl;

        if (streamUrl) {
            try {
                const headRes = await axios.get(streamUrl, { responseType: 'stream', timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (headRes.data && typeof headRes.data.destroy === 'function') headRes.data.destroy();
                info.status = 'OK (200)';
                info.healthy = true;
            } catch (err) {
                info.status = err.response ? `Erreur HTTP ${err.response.status}` : err.message;
                info.healthy = false;
            }
        } else {
            info.status = 'URL introuvable';
            info.healthy = false;
        }
        results.push(info);
    }
    res.json({ channelName: channel.displayName, streamsTested: results });
});

app.get('/', async (req, res) => {
    let sourcesParam = req.query.sources;
    let sourcesList = sourcesParam ? sourcesParam.split(',') : ['', ''];

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>HybridTV Dashboard & Debugger Pro</title>
        <style>
            :root { --bg: #141414; --card: #1f1f1f; --card-alt: #111; --primary: #e50914; --text: #fff; --text-muted: #bbb; --border: #333; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); padding: 30px 15px; margin: 0; }
            .container { max-width: 800px; margin: 0 auto; background: var(--card); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden; }
            .header { padding: 25px; text-align: center; border-bottom: 1px solid var(--border); }
            h1 { margin: 0 0 8px 0; font-size: 26px; }
            .subtitle { font-size: 13px; color: var(--text-muted); margin: 0; }
            .tabs { display: flex; border-bottom: 1px solid var(--border); background: #1a1a1a; overflow-x: auto; }
            .tab-btn { flex: 1; padding: 14px; background: none; border: none; color: var(--text-muted); font-size: 13px; font-weight: bold; cursor: pointer; transition: 0.2s; white-space: nowrap; }
            .tab-btn:hover { color: var(--text); background: #222; }
            .tab-btn.active { color: var(--text); border-bottom: 3px solid var(--primary); background: var(--card); }
            .tab-content { display: none; padding: 25px; }
            .tab-content.active { display: block; }
            .section { background: var(--card-alt); padding: 18px; border-radius: 8px; margin-bottom: 18px; border: 1px solid var(--border); }
            .section-title { font-size: 13px; color: #ccc; font-weight: bold; margin-top: 0; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
            .source-row { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
            .source-num { font-size: 13px; font-weight: bold; color: var(--primary); min-width: 20px; text-align: center; }
            .source-row input { flex: 1; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px; font-size: 13px; }
            .btn { display: inline-block; background: var(--primary); color: #fff; padding: 12px 20px; font-size: 14px; font-weight: bold; border-radius: 8px; cursor: pointer; border: none; transition: 0.2s; text-align: center; width: 100%; box-sizing: border-box; }
            .btn:hover { background: #f40612; }
            .btn-secondary { background: #333; margin-top: 10px; }
            .btn-secondary:hover { background: #444; }
            .btn-small { background: #444; padding: 8px 12px; font-size: 12px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .btn-small:hover { background: #555; }
            .btn-danger { background: #800; padding: 8px 10px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .btn-danger:hover { background: #a00; }
            .main-link { width: 100%; padding: 14px; margin-top: 12px; background: #111; color: #fff; border: 1px dashed #666; border-radius: 6px; text-align: center; font-size: 12px; box-sizing: border-box; }
            input[type="text"].export-box { width: 100%; padding: 10px; background: #222; border: 1px solid #444; color: #aaa; border-radius: 6px; font-size: 12px; box-sizing: border-box; }
            .metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 18px; }
            .metric-card { background: #222; padding: 14px; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
            .metric-value { font-size: 20px; font-weight: bold; color: var(--primary); margin: 6px 0 4px 0; }
            .metric-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; }
            ul.report-list { list-style: none; padding: 0; margin: 0; font-size: 13px; }
            ul.report-list li { padding: 8px 0; border-bottom: 1px solid #333; display: flex; justify-content: space-between; }
            ul.report-list li:last-child { border-bottom: none; }
            .status-ok { color: #4caf50; }
            .status-warn { color: #ff9800; }
            .status-err { color: #f44336; }
            input[type="search"] { width: 100%; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px; font-size: 13px; margin-bottom: 10px; box-sizing: border-box; }
            .channel-table-container { max-height: 250px; overflow-y: auto; border: 1px solid #333; border-radius: 6px; margin-bottom: 12px; background: #111; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
            th, td { padding: 8px 10px; border-bottom: 1px solid #222; }
            th { background: #1a1a1a; color: #aaa; position: sticky; top: 0; }
            tr:hover { background: #181818; cursor: pointer; }
            tr.selected { background: #2c1618 !important; border-left: 3px solid var(--primary); }
            pre { background: #111; padding: 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; color: #00ff66; border: 1px solid #333; margin: 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>📺 HybridTV Dashboard</h1>
                <p class="subtitle">Gestionnaire IPTV et Diagnostic Avancé (v1.2.13).</p>
            </div>
            <div class="tabs">
                <button class="tab-btn active" onclick="switchTab('config', this)">⚙️ Configurer</button>
                <button class="tab-btn" onclick="switchTab('metrics', this)">📊 Métriques & RAM</button>
                <button class="tab-btn" onclick="switchTab('debug', this)">🧪 Testeur Global</button>
            </div>
            <div id="config" class="tab-content active">
                <div class="section">
                    <h3 class="section-title">Sources (Add-ons TV, M3U & Sport)</h3>
                    <div id="sourcesContainer"></div>
                    <button type="button" onclick="addSourceField()" class="btn btn-small" style="margin-top: 10px;">+ Ajouter une source</button>
                </div>
                <div class="section">
                    <h3 class="section-title">Code de Sauvegarde</h3>
                    <input type="text" id="exportTokenBox" class="export-box" placeholder="Code de configuration..." readonly>
                    <button type="button" onclick="importToken()" class="btn btn-small" style="margin-top: 8px;">📥 Importer</button>
                </div>
                <button type="button" onclick="generateLink()" class="btn">⚡ Générer l'Add-on</button>
                <input type="text" id="manifestLink" class="main-link" placeholder="Lien généré ici..." readonly>
                <button type="button" onclick="copyLink()" class="btn btn-secondary">📋 Copier le lien d'installation</button>
            </div>
            <div id="metrics" class="tab-content">
                <div class="metrics-grid">
                    <div class="metric-card"><div class="metric-label">Uptime</div><div class="metric-value" id="m-uptime">--</div></div>
                    <div class="metric-card"><div class="metric-label">Mémoire RAM</div><div class="metric-value" id="m-ram">--</div></div>
                    <div class="metric-card"><div class="metric-label">Utilisateurs</div><div class="metric-value" id="m-users">--</div></div>
                    <div class="metric-card"><div class="metric-label">Requêtes</div><div class="metric-value" id="m-req">--</div></div>
                    <div class="metric-card"><div class="metric-label">Total Éléments</div><div class="metric-value" id="m-total">--</div></div>
                    <div class="metric-card"><div class="metric-label">Événements Sport</div><div class="metric-value" id="m-events">--</div></div>
                </div>
                <div class="section">
                    <h3 class="section-title">État des Sources Configurées</h3>
                    <ul class="report-list" id="sourceReportList"><li><i>Chargement...</i></li></ul>
                </div>
            </div>
            <div id="debug" class="tab-content">
                <div class="section">
                    <h3 class="section-title">Rechercher une Chaîne ou un Événement</h3>
                    <input type="search" id="channelSearch" placeholder="Tapez un nom d'équipe, de match ou de chaîne..." oninput="filterChannelTable()">
                    <div class="channel-table-container">
                        <table id="channelTable">
                            <thead>
                                <tr><th>Nom</th><th>Catégorie</th><th>Sources</th></tr>
                            </thead>
                            <tbody id="channelTableBody">
                                <tr><td colspan="3" style="text-align: center; color: #777;">Chargement des flux en cours...</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <button type="button" onclick="testSelectedChannel()" class="btn btn-small">🔍 Lancer le test des liens de cet élément</button>
                </div>
                <div class="section">
                    <h3 class="section-title">Résultat du Diagnostic des Flux</h3>
                    <pre id="debugOutput">Sélectionnez un élément dans le tableau ci-dessus...</pre>
                </div>
            </div>
        </div>
        <script>
            let sources = ${JSON.stringify(sourcesList)};
            let qualities = ['1080p', '720p', '4K', 'SD'];
            let languages = ['fr', 'en', 'es', 'other'];
            let allChannelsData = [];
            let selectedChannelId = null;

            function switchTab(tabId, btn) {
                document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
                document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
                document.getElementById(tabId).classList.add('active');
                btn.classList.add('active');
                if(tabId === 'metrics') fetchMetrics();
                if(tabId === 'debug') loadDebugChannelsTable();
            }

            function renderSources() {
                const container = document.getElementById('sourcesContainer');
                if (!container) return;
                container.innerHTML = '';
                sources.forEach((src, index) => {
                    if (index >= 8) return;
                    const div = document.createElement('div');
                    div.className = 'source-row';
                    div.innerHTML = \`
                        <span class="source-num">#\${index + 1}</span>
                        <input type="text" id="src_\${index}" value="\${src}" placeholder="URL manifest.json ou M3U">
                        \${index > 0 ? '<button type="button" onclick="moveSource(' + index + ', -1)" class="btn-small">▲</button>' : '<div style="width: 28px;"></div>'}
                        \${index < sources.length - 1 ? '<button type="button" onclick="moveSource(' + index + ', 1)" class="btn-small">▼</button>' : '<div style="width: 28px;"></div>'}
                        \${sources.length > 1 ? '<button type="button" onclick="removeSource(' + index + ')" class="btn-danger">✕</button>' : ''}
                    \`;
                    container.appendChild(div);
                });
                updateExportToken();
            }

            function moveSource(index, dir) { saveInputs(); const ni = index + dir; if (ni < 0 || ni >= sources.length) return; const t = sources[index]; sources[index] = sources[ni]; sources[ni] = t; renderSources(); }
            function addSourceField() { if (sources.length < 8) { saveInputs(); sources.push(''); renderSources(); } }
            function removeSource(index) { saveInputs(); sources.splice(index, 1); renderSources(); }
            
            function saveInputs() {
                sources.forEach((_, idx) => { const el = document.getElementById('src_' + idx); if (el) sources[idx] = el.value.trim(); });
                localStorage.setItem('hybrid_sources', JSON.stringify(sources));
                updateExportToken();
            }

            function updateExportToken() {
                const validSources = sources.filter(s => s.length > 0);
                const configObj = { sources: validSources, qualities, languages }; 
                const tokenBox = document.getElementById('exportTokenBox');
                if (tokenBox) tokenBox.value = btoa(JSON.stringify(configObj));
            }

            function importToken() {
                let inputCode = prompt("Collez le code de sauvegarde ici :");
                if (!inputCode) return;
                try {
                    const config = JSON.parse(atob(inputCode.trim()));
                    if (config.sources) {
                        sources = config.sources.length ? config.sources : ['', ''];
                        renderSources(); alert("Importé !");
                    }
                } catch(e) { alert("Code corrompu."); }
            }

            function generateLink() {
                saveInputs();
                const token = document.getElementById('exportTokenBox').value;
                const linkField = document.getElementById("manifestLink");
                if (linkField) linkField.value = window.location.protocol + "//" + window.location.host + "/" + token + "/manifest.json";
                alert("Lien généré !");
            }

            function copyLink() {
                const copyText = document.getElementById("manifestLink");
                if (!copyText || !copyText.value) return alert("Générez d'abord le lien !");
                copyText.select(); document.execCommand("copy"); alert("Copié !");
            }

            async function fetchMetrics() {
                try {
                    let res = await fetch('/api/metrics');
                    let data = await res.json();
                    document.getElementById('m-uptime').innerText = data.uptime;
                    document.getElementById('m-ram').innerText = data.ramUsed;
                    document.getElementById('m-users').innerText = data.activeUsers;
                    document.getElementById('m-req').innerText = data.totalRequests;
                    document.getElementById('m-total').innerText = data.totalChannels;
                    document.getElementById('m-events').innerText = data.categoryCounts.events || 0;
                    
                    let htmlList = '';
                    sources.forEach(src => {
                        if (!src) return;
                        let cleanSrc = src.replace(/\\/manifest\\.json$/, '').trim(); 
                        let displaySrc = cleanSrc.length > 35 ? cleanSrc.substring(0, 32) + '...' : cleanSrc;
                        let r = data.sourceReport[cleanSrc];
                        if (!r || r.status === 'fetching') htmlList += \`<li><span>\${displaySrc}</span> <b class="status-warn">⏳ Synchronisation en cours...</b></li>\`;
                        else if (r.status === 'ok') htmlList += \`<li><span>\${displaySrc}</span> <b class="status-ok">✅ \${r.count} éléments</b></li>\`;
                        else if (r.status === 'empty') htmlList += \`<li><span>\${displaySrc}</span> <b class="status-warn">⚠️ 0 élément trouvé</b></li>\`;
                        else htmlList += \`<li><span>\${displaySrc}</span> <b class="status-err">❌ Erreur connexion</b></li>\`;
                    });
                    document.getElementById('sourceReportList').innerHTML = htmlList || '<li><i>Aucune source configurée</i></li>';
                } catch(e) {}
            }

            async function loadDebugChannelsTable() {
                saveInputs();
                const tbody = document.getElementById('channelTableBody');
                tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #aaa;">Chargement complet des flux (veuillez patienter)...</td></tr>';
                try {
                    let validSources = sources.filter(s => s.length > 0).join(',');
                    let res = await fetch(\`/api/channels/list?sources=\${encodeURIComponent(validSources)}\`);
                    let data = await res.json();
                    allChannelsData = data.channels || [];
                    renderChannelTable(allChannelsData);
                } catch(e) {
                    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #f44336;">Erreur de chargement des flux.</td></tr>';
                }
            }

            function renderChannelTable(items) {
                const tbody = document.getElementById('channelTableBody');
                if(items.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #777;">Aucun élément trouvé.</td></tr>';
                    return;
                }
                tbody.innerHTML = '';
                items.forEach(item => {
                    const tr = document.createElement('tr');
                    tr.onclick = () => selectChannel(item.id, tr);
                    tr.innerHTML = \`<td>\${item.name}</td><td>\${item.category}</td><td>\${item.sourcesCount}</td>\`;
                    tbody.appendChild(tr);
                });
            }

            function filterChannelTable() {
                const query = document.getElementById('channelSearch').value.toLowerCase();
                const filtered = allChannelsData.filter(i => i.name.toLowerCase().includes(query) || i.category.toLowerCase().includes(query));
                renderChannelTable(filtered);
            }

            function selectChannel(id, trElement) {
                document.querySelectorAll('#channelTableBody tr').forEach(tr => tr.classList.remove('selected'));
                trElement.classList.add('selected');
                selectedChannelId = id;
            }

            async function testSelectedChannel() {
                if (!selectedChannelId) return alert("Sélectionnez d'abord un élément dans le tableau !");
                const output = document.getElementById('debugOutput');
                output.innerText = "Test des liens et des serveurs en cours...";
                
                let validSources = sources.filter(s => s.length > 0).join(',');
                try {
                    let res = await fetch(\`/api/debug/test?channelId=\${encodeURIComponent(selectedChannelId)}&sources=\${encodeURIComponent(validSources)}\`);
                    let data = await res.json();
                    output.innerText = JSON.stringify(data, null, 2);
                } catch(e) {
                    output.innerText = "Erreur lors du test : " + e.message;
                }
            }

            let savedSources = localStorage.getItem('hybrid_sources');
            if (savedSources && !${sourcesParam ? 'true' : 'false'}) sources = JSON.parse(savedSources);
            renderSources();
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.get('/:config/configure', (req, res) => {
    res.redirect('/' + req.params.config);
});

// --- MANIFEST BUILDER ---
app.get('/:config/manifest.json', (req, res) => {
    res.setHeader('Cache-Control', 'max-age=86400, public'); 
    let baseCatalogs = [
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
    ];

    res.json({
        id: 'org.hybridtv.meta', 
        version: '1.2.13',
        name: 'HybridTV',
        description: 'Meta-Addon IPTV (v1.2.13) - Full EPG & Complete Categories.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: baseCatalogs,
        behaviorHints: { configurable: true, configurationRequired: false }
    });
});

app.get(['/:config/catalog/tv/:id.json', '/:config/catalog/tv/:id/:extra'], async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ metas: [] });
    
    let channelsData = await getChannelsForSources(config.sources);
    res.setHeader('Cache-Control', 'max-age=14400, public'); 
    const requestedCatalog = req.params.id; 
    let skip = 0;
    
    if (req.params.extra) {
        const skipMatch = req.params.extra.match(/skip=(\d+)/);
        if (skipMatch) skip = parseInt(skipMatch[1], 10);
    }

    const validCatalogs = ['tnt', 'info', 'jeunesse', 'decouverte', 'cinema', 'musique', 'canal', 'sports', 'events', 'autres'];
    if (!validCatalogs.includes(requestedCatalog)) return res.json({ metas: [] });
    
    let filteredChannels = channelsData.filter(ch => ch.categories.includes(requestedCatalog));
    
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
    
    if (Object.keys(epgData).length > 0) {
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
            }
        }
    }

    res.json({ meta: { id: channel.id, type: 'tv', name: channel.displayName, poster: channel.poster, posterShape: 'square', description: descriptionText } });
});

app.get('/:config/stream/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ streams: [] });
    
    const serverHost = `${req.protocol}://${req.get('host')}`;
    serverStats.channelClicks[req.params.id] = (serverStats.channelClicks[req.params.id] || 0) + 1;

    let channelsData = await getChannelsForSources(config.sources);
    res.setHeader('Cache-Control', 'max-age=45, public'); 

    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });
    
    try {
        let streamPromises = channel.sources.map(async (source) => {
            if (source.type === 'm3u') {
                return [{
                    url: source.directUrl,
                    name: `▶ Full HD (1080p)`,
                    title: source.originalName || "Source M3U",
                    _score: 1500
                }];
            }

            try {
                let targetUrl = `${source.providerBase}/stream/tv/${encodeURIComponent(source.metaId)}.json`;
                const streamRes = await axios.get(targetUrl, { timeout: 4500 });
                
                if (streamRes.data && streamRes.data.streams) {
                    return streamRes.data.streams.map((s, idx) => {
                        let outStream = { ...s };
                        if (outStream.url && (outStream.url.includes('.m3u8') || outStream.url.includes('vavoo'))) {
                            outStream.url = `${serverHost}/proxy/hls?url=${encodeURIComponent(outStream.url)}`;
                        }
                        outStream._score = 1000 - idx;
                        return outStream;
                    });
                }
            } catch (err) {}
            return [];
        });

        let results = await Promise.all(streamPromises);
        let allStreams = [].concat(...results);
        allStreams.sort((a, b) => b._score - a._score);

        const finalStreams = allStreams.map(s => { let o = {...s}; delete o._score; return o; });
        res.json({ streams: finalStreams });
    } catch (err) { res.json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`[INFO] Server started on port ${PORT}`);
    updateEPG(); 
    setInterval(updateEPG, 3600000); 
});
