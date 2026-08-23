/**
 * HybridTV - IPTV Meta-Addon for Stremio
 * Core logic: Stream aggregation, semantic routing, and EPG mapping.
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');

const app = express();
app.use(cors());

// Global state & Caching
let isUpdatingEPG = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let epgData = {}; 
let channelsCache = {}; 
let streamCache = new Map(); 

// Assets
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';
const EVENT_POSTER = 'https://cdn-icons-png.flaticon.com/512/861/861512.png';
const LOADING_POSTER = 'https://cdn-icons-png.flaticon.com/512/3039/3039401.png'; 

const BLACKLIST = [
    'ALACARTE', 'DISNEYPLUS', 'NETFLIX', 'PRIMEVIDEO', 'APPLETV',
    'TEST', 'MIRROR', 'BACKUPCHANNEL', 'BOXOFFICE1', 'BOXOFFICE2', 'CANALPLAY', 'AFRIQUE', 'DEUTSCH', 'GERMAN'
];

// Static logo mapping
const LOGOS = {
    'hyb_tnt_1': 'https://upload.wikimedia.org/wikipedia/commons/c/cc/TF1_2013_logo.svg',
    'hyb_tnt_2': 'https://upload.wikimedia.org/wikipedia/commons/9/91/France_2_logo_2018.svg',
    'hyb_tnt_3': 'https://upload.wikimedia.org/wikipedia/commons/d/d1/France_3_logo_2018.svg',
    'hyb_tnt_4': 'https://upload.wikimedia.org/wikipedia/commons/7/7b/France_4_logo_2018.svg',
    'hyb_tnt_5': 'https://upload.wikimedia.org/wikipedia/commons/6/67/France_5_logo_2018.svg',
    'hyb_tnt_6': 'https://upload.wikimedia.org/wikipedia/commons/8/8c/M6_logo_2020.svg',
    'hyb_tnt_7': 'https://upload.wikimedia.org/wikipedia/commons/4/4b/Arte_logo_2017.svg',
    'hyb_tnt_8': 'https://upload.wikimedia.org/wikipedia/commons/0/07/C8_t%C3%A9l%C3%A9.png',
    'hyb_tnt_9': 'https://upload.wikimedia.org/wikipedia/commons/6/62/W9-Logo.svg',
    'hyb_tnt_10': 'https://upload.wikimedia.org/wikipedia/fr/a/a8/TMC_logo_2016.svg',
    'hyb_tnt_11': 'https://upload.wikimedia.org/wikipedia/fr/8/83/TFX_logo_2018.svg',
    'hyb_tnt_12': 'https://upload.wikimedia.org/wikipedia/fr/4/44/NRJ12-Logo.png',
    'hyb_tnt_13': 'https://upload.wikimedia.org/wikipedia/fr/b/b3/LCP_Assemblée_Nationale_logo_2018.svg',
    'hyb_tnt_17': 'https://upload.wikimedia.org/wikipedia/commons/c/c0/Logo_CStar_2016.svg',
    'hyb_jeu_gulli': 'https://focus.telerama.fr/500x500/0000/00/01/clear-43.png',
    'hyb_tnt_20': 'https://upload.wikimedia.org/wikipedia/fr/4/4b/TF1_Séries_Films_logo_2020.svg',
    'hyb_tnt_22': 'https://upload.wikimedia.org/wikipedia/fr/a/a9/6ter_2012.png',
    'hyb_tnt_23': 'https://upload.wikimedia.org/wikipedia/fr/8/8a/RMC_Story_logo_2018.svg',
    'hyb_tnt_24': 'https://upload.wikimedia.org/wikipedia/fr/c/c6/RMC_Découverte_logo_2018.svg',
    'hyb_tnt_25': 'https://logowik.com/content/uploads/images/cherie-255806.logowik.com.webp',
    'hyb_tnt_rtl9': 'https://www.rtl9.com/upload/media/logo-rtl9-rvb-64784327dd675.png',
    'hyb_tnt_13rue': 'https://www.lyngsat.com/logo/tv/num/13eme_rue_fr.png',
    'hyb_tnt_teva': 'https://focus.telerama.fr/500x500/0000/00/01/clear-197.png',
    'hyb_tnt_ab1': 'https://upload.wikimedia.org/wikipedia/fr/9/9a/Logo_AB1_2021.png',
    
    'hyb_info_1': 'https://upload.wikimedia.org/wikipedia/commons/4/40/BFM_TV_logo.png',
    'hyb_info_biz': 'https://upload.wikimedia.org/wikipedia/fr/c/ca/BFM_Business_logo_2019.svg',
    'hyb_info_2': 'https://upload.wikimedia.org/wikipedia/commons/5/5a/CNews_logo_2017.svg',
    'hyb_info_3': 'https://upload.wikimedia.org/wikipedia/fr/b/b4/LCI_logo_%282016%29.png',
    'hyb_info_4': 'https://upload.wikimedia.org/wikipedia/fr/c/c2/Franceinfo_logo_2016.svg',
    'hyb_info_5': 'https://i.postimg.cc/TPwp9d9B/640px-France24.png',
    'hyb_info_meteo': 'https://focus.telerama.fr/500x500/0000/00/01/clear-158.png',
    'hyb_info_vosges': 'https://upload.wikimedia.org/wikipedia/fr/f/f0/Vosges_Télé_logo_2020.svg',
    'hyb_info_tlm': 'https://upload.wikimedia.org/wikipedia/fr/0/0a/TLM_logo.png',
    'hyb_info_paris': 'https://upload.wikimedia.org/wikipedia/fr/8/8c/BFM_Paris_Île-de-France_logo_2022.svg',
    'hyb_info_lyon': 'https://upload.wikimedia.org/wikipedia/fr/f/f7/BFM_Lyon_logo_2022.svg',
    'hyb_info_lille': 'https://upload.wikimedia.org/wikipedia/fr/1/15/BFM_Grand_Lille_logo_2022.svg',
    'hyb_info_breizh': 'https://upload.wikimedia.org/wikipedia/fr/5/58/TV_Breizh_logo_2023.png',
    
    'hyb_canal_cplus': 'https://upload.wikimedia.org/wikipedia/commons/3/39/Canal%2B_Film_HD.png',
    'hyb_canal_cinema': 'https://upload.wikimedia.org/wikipedia/fr/e/eb/C%2B_Cin%C3%A9ma%28s%29.png',
    'hyb_canal_grandecran': 'https://upload.wikimedia.org/wikipedia/fr/d/da/C%2B_Grand_%C3%89cran.png',
    'hyb_canal_series': 'https://upload.wikimedia.org/wikipedia/fr/e/e3/C%2B_S%C3%A9ries.png',
    'hyb_canal_kids': 'https://upload.wikimedia.org/wikipedia/commons/0/0c/Canal%2B_Kids.png',
    'hyb_canal_docs': 'https://upload.wikimedia.org/wikipedia/commons/2/27/Canal%2B_Docs.png',
    'hyb_canal_boxoffice': 'https://upload.wikimedia.org/wikipedia/fr/5/55/C%2B_Box_Office.png',
    'hyb_canal_comedie': 'https://upload.wikimedia.org/wikipedia/commons/3/3e/Com%C3%A9die%2B_logo_%C3%A0_l%27antenne.png',
    'hyb_canal_decale': 'https://www.staderochelais.com/sites/stade-rochelais/files/logos/canal-decale-1622622027.png',
    
    'hyb_sport_ligue1plus': 'https://focus.telerama.fr/500x500/0000/00/01/clear-1845.png',
    'hyb_canal_sport': 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Canal%2B_Sport_2015.png',
    'hyb_canal_foot': 'https://upload.wikimedia.org/wikipedia/commons/e/eb/Canal%2BFoot.png',
    'hyb_canal_sport360': 'https://upload.wikimedia.org/wikipedia/commons/6/64/Canal%2BSport_360.png',
    'hyb_sport_bein_1': 'https://c0.klipartz.com/pngpicture/320/259/gratis-png-bein-sports-1-logo-bein-taquilla-bein-media-group-canal-de-television.png',
    'hyb_sport_rmc_1': 'https://upload.wikimedia.org/wikipedia/commons/3/3b/Logo_RMC_Sport_1_2018.svg',
    'hyb_sport_euro_1': 'https://upload.wikimedia.org/wikipedia/commons/d/d0/Eurosport_1_Logo_2015.svg',
    'hyb_sport_lequipe': 'https://focus.telerama.fr/500x500/0000/00/01/clear-46.png',
    'hyb_sport_equidia': 'https://upload.wikimedia.org/wikipedia/fr/4/4c/Equidia_logo_2017.png',
    'hyb_sport_oltv': 'https://upload.wikimedia.org/wikipedia/fr/a/a2/Logo_OL_TV_2019.png',
    'dazn_generic': 'https://upload.wikimedia.org/wikipedia/commons/0/06/DAZN_Logo_Master.svg',
    'hyb_esport_lfl': 'https://upload.wikimedia.org/wikipedia/fr/3/3f/Ligue_Fran%C3%A7aise_de_League_of_Legends_logo.svg',

    'hyb_cine_premier': 'https://upload.wikimedia.org/wikipedia/commons/7/73/Canalplus_fr_cine_plus_premier_hd.png',
    'hyb_cine_frisson': 'https://focus.telerama.fr/500x500/0000/00/01/clear-147.png',
    'hyb_cine_emotion': 'https://thumb.canalplus.pro/http/unsafe/epg.canal-plus.com/mycanal/img/CHN43FN/PNG/213X160/CHN43FB_396.PNG',
    'hyb_cine_club': 'https://upload.wikimedia.org/wikipedia/fr/7/77/Cin%C3%A9Cin%C3%A9ma_Club_logo_2008.png',
    'hyb_cine_classic': 'https://upload.wikimedia.org/wikipedia/fr/f/f3/Cin%C3%A9_Cin%C3%A9ma_Classic.png',
    'hyb_cine_action': 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRPdxSas0cWbgadzbAuhDjqLEd_Y4iMG0odsUoZy8ch1NJYK3ZVez_yrHCoAA&s',
    'hyb_cine_paramount': 'https://upload.wikimedia.org/wikipedia/fr/5/59/Paramount_Channel.svg.png',
    'hyb_cine_warner': 'https://upload.wikimedia.org/wikipedia/fr/e/eb/Warner_TV_France_logo.png',
    'hyb_cine_syfy': 'https://upload.wikimedia.org/wikipedia/commons/4/4e/Syfy_2017_logo.svg',
    'hyb_cine_ocs': 'https://upload.wikimedia.org/wikipedia/fr/8/87/OCS_Logo_2023.svg',

    'hyb_dec_crime': 'https://www.lyngsat.com/logo/tv/cc/crime_district_fr.png',
    'hyb_dec_natgeo': 'https://focus.telerama.fr/500x500/0000/00/01/clear-243.png',
    'hyb_dec_discovery': 'https://upload.wikimedia.org/wikipedia/commons/2/27/Discovery_Channel_-_Logo_2019.svg',
    'hyb_dec_planete': 'https://focus.telerama.fr/500x500/0000/00/01/clear-147.png',
    'hyb_dec_histoire': 'https://upload.wikimedia.org/wikipedia/fr/5/5c/Histoire_TV_logo_2019.svg',
    
    'hyb_jeu_cartoon': 'https://upload.wikimedia.org/wikipedia/commons/f/fe/CARTOON_NETWORK_logo.png',
    'hyb_jeu_disney': 'https://upload.wikimedia.org/wikipedia/commons/7/78/Disney_Channel_Germany_Logo_2014.png',
    'hyb_jeu_disneyxd': 'https://upload.wikimedia.org/wikipedia/commons/0/00/Disney_XD_logo.svg',
    'hyb_jeu_nick': 'https://upload.wikimedia.org/wikipedia/commons/f/fa/Nickelodeon_logo_2009.png',
    'hyb_jeu_canalj': 'https://upload.wikimedia.org/wikipedia/fr/6/69/Logo_canal_J.png',
    'hyb_jeu_gameone': 'https://upload.wikimedia.org/wikipedia/fr/a/a0/Game_One_%281998%29_Logo.svg',
    'hyb_jeu_boom': 'https://focus.telerama.fr/500x500/0000/00/01/clear-321.png',
    'hyb_jeu_boing': 'https://upload.wikimedia.org/wikipedia/commons/9/91/Boing_logo_2016_%28France%29.svg',
    'hyb_jeu_disneyjr': 'https://upload.wikimedia.org/wikipedia/fr/3/36/Disney_Junior_2011.png',
    'hyb_jeu_tiji': 'https://focus.telerama.fr/500x500/0000/00/01/clear-229.png',
    'hyb_jeu_piwi': 'https://focus.telerama.fr/500x500/0000/00/01/clear-344.png',
    'hyb_jeu_mangas': 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQrBITj8D4ehy326isxvvHDFUivw37wiREtViWbndOOtqIoq8ykrTbVbQQADg&s',

    'hyb_mus_mtv': 'https://upload.wikimedia.org/wikipedia/commons/0/0d/MTV-2021.svg',
    'hyb_mus_mcm': 'https://upload.wikimedia.org/wikipedia/fr/a/ab/MCM_logo_2017.svg',
    'hyb_mus_trace': 'https://upload.wikimedia.org/wikipedia/fr/9/98/Trace_Urban_logo.svg',
    'hyb_mus_nrjhits': 'https://upload.wikimedia.org/wikipedia/fr/1/1a/NRJ_Hits_logo.png',
    'hyb_mus_melody': 'https://upload.wikimedia.org/wikipedia/fr/4/44/Melody_logo_2018.png',
    'hyb_mus_mezzo': 'https://upload.wikimedia.org/wikipedia/commons/e/ec/Mezzo_TV_logo.svg',
    'hyb_mus_rfm': 'https://upload.wikimedia.org/wikipedia/fr/5/52/Logo_RFM_TV.png'
};

/**
 * Decode base64 configuration object
 */
function parseConfig(encodedConfig) {
    try {
        if (!encodedConfig || encodedConfig === 'manifest.json') return { sources: [], epg: true, logos: false };
        const jsonStr = Buffer.from(encodedConfig, 'base64').toString('utf8');
        let parsed = JSON.parse(jsonStr);
        parsed.logos = false; // Enforcement of static native logos logic
        return parsed;
    } catch (e) {
        return { sources: [], epg: true, logos: false };
    }
}

// ============================================================================
// LIVE EVENT PARSER
// Extracts temporary sporting events and routes them away from linear channels.
// ============================================================================
function extractMatchEvent(rawName) {
    if (!rawName) return null;
    let s = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // Clean structural brackets prior to regex matching
    s = s.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();

    let isMatch = false;
    let eventName = '';

    // Condition 1: Explicit "Match Time" keyword
    if (s.includes('MATCH TIME') || s.includes('MATCHTIME')) {
        let cleanName = s.replace(/^(?:FR|BE|CH|VIP|LIVE|DIRECT|EVENT|MATCH|LIGUE\s*1|DAZN|BEIN|RMC|CANAL\+?|MULTI|MULTIPLEX)\s*[:|-|\|]*\s*/gi, '')
                 .replace(/\d{1,2}[hH:]\d{2}/g, '')
                 .replace(/\b(?:FHD|HD|SD|4K|1080P|720P|MATCH\s*TIME|MATCHTIME)\b/gi, '')
                 .replace(/[^A-Z0-9\s-]/g, '').trim();
        if (cleanName.length < 3) cleanName = "Événement Sportif";
        return { id: 'hyb_ev_' + toSyncId(cleanName), name: '🔴 ' + cleanName, categories: ['events'], index: 5, customPoster: EVENT_POSTER };
    }

    // Condition 2: Explicit "VS" formatting
    let vsMatch = s.match(/([A-Z0-9\s]{3,20})\s+(?:VS\.?|CONTRE|\bV\b|\bVERSUS\b)\s+([A-Z0-9\s]{3,20})/i);
    if (vsMatch) {
        isMatch = true; 
        eventName = `${vsMatch[1].trim()} vs ${vsMatch[2].trim()}`;
    } 
    // Condition 3: Hyphenated formatting within a known live sports context
    else if (/(?:LIGUE\s*1|UCL|LDC|EURO|PREMIER LEAGUE|MATCH|EVENT).+?\b([A-Z][A-Z0-9\s]{2,20})\s*[-/]\s*([A-Z][A-Z0-9\s]{2,20})\b/i.test(s)) {
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

    // Condition 4: Generic Multiplex
    if (s.includes('MULTIPLEX') && !s.includes('CANAL')) {
        return { id: 'hyb_ev_multi', name: '🔴 MULTIPLEX EN DIRECT', categories: ['events'], index: 1, customPoster: EVENT_POSTER };
    }
    return null;
}

// ============================================================================
// SEMANTIC CHANNEL ROUTER
// Assigns channel ID, category, and sorting index based on parsed string data.
// ============================================================================
function getChannelData(rawName) {
    if (!rawName) return null;
    
    // Evaluate event extraction first
    let eventData = extractMatchEvent(rawName);
    if (eventData) return eventData;

    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // Sanitize string (remove tags, parentheses)
    n = n.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
    n = n.replace(/^(?:FR|BE|CH|CA|VIP|VAVOO)\s*[:|/-]+\s*/i, '');
    n = n.replace(/DURING EVENT ONLY/g, '').replace(/EVENT ONLY/g, '');
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'DIRECT', 'RAW', 'ACCESS'];
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'gi'), ''); });

    if (n.includes('LFL') || n.includes('LEAGUE OF LEGENDS') || n.includes('LOL LFL')) {
        return { id: 'hyb_esport_lfl', name: 'LFL (eSport)', categories: ['autres'], index: 10 };
    }

    n = n.replace(/\+/g, 'PLUS');

    // --- SPORTS: LIGUE 1+ ---
    if (n.includes('LIGUE 1') || n.includes('LIGUE1') || n.match(/\bL1\b/)) {
        if (!n.includes('DAZN') && !n.includes('BEIN') && !n.includes('RMC')) {
            let m = n.match(/(?:LIGUE\s*1|L1|LIGUE1)(?:.*?PLUS)?[^\d]*([1-9]|1[0-8])/i);
            let num = m ? m[1] : '1';
            if (num === '1') {
                return { id: 'hyb_sport_ligue1plus_1', name: 'Ligue 1+', categories: ['sports'], index: 1 };
            } else {
                return { id: 'hyb_sport_ligue1plus_' + num, name: 'Ligue 1+ ' + num, categories: ['sports'], index: 1 + parseInt(num, 10) };
            }
        }
    }
    
    // --- SPORTS: DAZN ---
    if (n.includes('DAZN')) {
        if (n.includes('RISE')) return { id: 'hyb_sport_dazn_rise', name: 'DAZN Rise', categories: ['sports'], index: 150 };
        let m = n.match(/DAZN[^\d]*([1-9]|1[0-8])/i); let num = m ? m[1] : '1';
        return { id: 'hyb_sport_dazn_'+num, name: 'DAZN '+num, categories: ['sports'], index: 10 + parseInt(num, 10) };
    }

    let c = n.replace(/[^A-Z0-9]/g, '');
    if (!c || c.length < 2) return null;
    if (BLACKLIST.some(b => c.includes(b))) return null;

    // --- OTHER: CANAL+ FALSE FRIENDS ---
    if (c.includes('JURAS') || c.includes('TOP14') || c.includes('LCENTRE') || c.includes('LIGA') || c === 'CANALPLUSL' || c === 'CPLUSL' || c === 'CPLUSSPORT') {
        let pretty = rawName.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\b(?:FHD|HD|SD|4K|1080P|720P)\b/gi, '').trim();
        return { id: 'hyb_aut_' + c.substring(0, 15), name: pretty, categories: ['autres'], index: 200 };
    }

    // --- INFO ---
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

    // --- COMEDY ---
    if (c.includes('COMEDYCENTRAL')) return { id: 'hyb_aut_comedycentral', name: 'Comedy Central', categories: ['autres'], index: 11 };
    if (c.includes('COMEDIE') || c.includes('COMEDY')) return { id: 'hyb_canal_comedie', name: 'Comédie+', categories: ['canal', 'autres'], index: 10 };

    // --- CANAL+ BUNDLE ---
    if (c.includes('CANAL') || c.includes('CPLUS')) {
        if (c.includes('CANALJ') || c.includes('CJ')) return { id: 'hyb_jeu_canalj', name: 'Canal J', categories: ['jeunesse', 'canal'], index: 100 };
        if (c.includes('KIDS')) return { id: 'hyb_canal_kids', name: 'Canal+ Kids', categories: ['canal', 'jeunesse'], index: 101 };
        
        if (c.includes('LIVE')) {
            let m = c.match(/LIVE(\d+)/); let num = m ? m[1] : '1';
            return { id: 'hyb_canal_live_' + num, name: 'Canal+ Live ' + num, categories: ['canal'], index: 200 + parseInt(num, 10) };
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

    // --- SPORTS ---
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

    // --- CINEMA ---
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

    // --- TNT ---
    if (c.startsWith('TF1SERIESFILMS') || c.startsWith('TF1SF')) return { id: 'hyb_tnt_20', name: 'TF1 Séries Films', categories: ['tnt', 'cinema'], index: 20 };
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

    // --- KIDS (Strict Order) ---
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

    // --- MUSIC (Order critical logic) ---
    if (c.includes('RFMTV') || c.includes('RFM')) return { id: 'hyb_mus_rfm', name: 'RFM TV', categories: ['musique'], index: 34 }; // Processed before MTV to avoid overlap
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

    // --- DOCS ---
    if (c.includes('DISCOVERY')) {
        let m = n.match(/DISCOVERY\s*([A-Z]*)/i); let suffix = (m && m[1]) ? ' ' + m[1] : '';
        return { id: 'hyb_dec_discovery' + suffix.trim().replace(/\s/g, '_'), name: 'Discovery' + suffix, categories: ['decouverte'], index: 20 };
    }
    if (c.includes('CRIMEDISTRICT') || c.includes('CRIMED')) return { id: 'hyb_dec_crime', name: 'Crime District', categories: ['decouverte'], index: 1 };
    if (c.includes('NATGEO') || c.includes('NATIONALGEO')) return { id: 'hyb_dec_natgeo', name: 'National Geographic', categories: ['decouverte'], index: 1 };
    if (c.includes('PLANET')) return { id: 'hyb_dec_planete', name: 'Planète+', categories: ['decouverte'], index: 210 };
    if (c.includes('USHUAIA')) return { id: 'hyb_dec_ushuaia', name: 'Ushuaïa TV', categories: ['decouverte'], index: 30 };
    if (c.includes('HISTOIRE')) return { id: 'hyb_dec_histoire', name: 'Histoire TV', categories: ['decouverte'], index: 32 };
    if (c.includes('CHASSE') || c.includes('PECHE')) return { id: 'hyb_dec_chasse', name: 'Chasse et Pêche', categories: ['decouverte'], index: 34 };
    if (c.includes('ANIMAUX')) return { id: 'hyb_dec_animaux', name: 'Animaux', categories: ['decouverte'], index: 35 };

    // --- FALLBACK (Generic parsing) ---
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

/**
 * EPG Downloader and Parser
 */
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

/**
 * Fetch Catalog
 * Scrapes metadata from Stremio add-ons or M3U files concurrently.
 */
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
                        metas.push({
                            id: metaId,
                            name: currentName,
                            poster: currentLogo,
                            _isDirectStream: true,
                            _directUrl: streamUrl
                        });
                    }
                    currentLogo = DEFAULT_POSTER;
                    currentName = '';
                }
            }
        } catch (e) {
            console.error("[M3U Parsing Error]", e.message);
        }
        return metas;
    }

    try {
        let cleanUrl = cleanInput;
        if (!cleanUrl.endsWith('manifest.json')) cleanUrl = cleanUrl.replace(/\/$/, '') + '/manifest.json';
        const base = cleanUrl.replace(/\/manifest\.json$/, '');

        const manifestRes = await axios.get(cleanUrl, { timeout: 6000 });
        const catalogs = manifestRes.data.catalogs || [];
        
        const catalogPromises = catalogs.map(async (catalog) => {
            let catMetas = []; 
            let hasMore = true; 
            let skip = 0;
            const maxSkip = 50000; // Limit raised to 500 pages. Ensure full dataset extraction.
            const batchSize = 5;   // Parallel requests

            while (hasMore && skip < maxSkip) {
                let requests = [];
                for (let i = 0; i < batchSize; i++) {
                    let currentSkip = skip + (i * 100);
                    let url = currentSkip > 0 ? `${base}/catalog/${catalog.type}/${catalog.id}/skip=${currentSkip}.json` : `${base}/catalog/${catalog.type}/${catalog.id}.json`;
                    requests.push(axios.get(url, { timeout: 6000 }).catch(e => null));
                }
                
                let responses = await Promise.all(requests);
                let foundAnyInBatch = false;
                
                for (let res of responses) {
                    if (res && res.data && res.data.metas && res.data.metas.length > 0) {
                        catMetas.push(...res.data.metas);
                        foundAnyInBatch = true;
                        if (res.data.metas.length < 100) hasMore = false; 
                    }
                }
                if (!foundAnyInBatch) hasMore = false; 
                skip += (batchSize * 100);
            }
            return catMetas;
        });

        const results = await Promise.all(catalogPromises);
        results.flat().forEach(m => {
            if (m && m.id) metas.push({ ...m, _providerBase: base, _isDirectStream: false });
        });
    } catch (err) {}

    return metas;
}

/**
 * Background Sync Implementation
 * Prevents Stremio catalog timeout on massive provider databases.
 */
async function getChannelsForSources(sourcesList) {
    const cacheKey = sourcesList.join('|');

    if (!channelsCache[cacheKey]) {
        channelsCache[cacheKey] = { status: 'idle', data: [], timestamp: 0 };
    }

    let cacheObj = channelsCache[cacheKey];

    if (cacheObj.status === 'done' && (Date.now() - cacheObj.timestamp < 6 * 3600 * 1000)) {
        return cacheObj.data;
    }

    if (cacheObj.status === 'syncing') {
        if (cacheObj.data.length > 0) return cacheObj.data; 
        return [{ 
            id: 'hyb_loading', 
            displayName: 'Synchronisation... (Patientez 1 min et rechargez)', 
            categories: ['tnt','info','sports','cinema','jeunesse','musique','decouverte','canal','autres','events'], 
            poster: LOADING_POSTER, 
            sources: [] 
        }];
    }

    cacheObj.status = 'syncing';

    // Async extraction
    (async () => {
        try {
            let tempChannelsMap = {};
            for (let i = 0; i < sourcesList.length; i++) {
                const sourceInput = sourcesList[i].trim();
                if (!sourceInput) continue;
                
                const metas = await fetchCatalogFromSource(sourceInput);
                let cleanUrl = sourceInput.replace(/\/manifest\.json$/, '').trim();

                metas.forEach(meta => {
                    let channelInfo = getChannelData(meta.name || '');
                    if (!channelInfo) return; 

                    const id = channelInfo.id;
                    let finalPoster = meta.poster || DEFAULT_POSTER;

                    if (!tempChannelsMap[id]) {
                        tempChannelsMap[id] = { 
                            id: id, 
                            name: channelInfo.name, 
                            displayName: channelInfo.name, 
                            categories: channelInfo.categories,
                            sortIndex: channelInfo.index,
                            sources: [], 
                            poster: finalPoster 
                        };
                    }
                    
                    if (meta._isDirectStream) {
                        const sourceExists = tempChannelsMap[id].sources.find(s => s.directUrl === meta._directUrl);
                        if (!sourceExists) {
                            tempChannelsMap[id].sources.push({ type: 'm3u', directUrl: meta._directUrl, sourceIndex: i, originalName: meta.name });
                        }
                    } else {
                        const sourceExists = tempChannelsMap[id].sources.find(s => s.metaId === meta.id && s.providerBase === cleanUrl);
                        if (!sourceExists) {
                            tempChannelsMap[id].sources.push({ type: 'addon', metaId: meta.id, providerBase: cleanUrl, sourceIndex: i, originalName: meta.name });
                        }
                    }
                });
            }

            let tempChannelsData = Object.values(tempChannelsMap).filter(ch => ch.sources.length > 0);
            tempChannelsData.sort((a, b) => {
                if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
                return a.displayName.localeCompare(b.displayName);
            });

            cacheObj.data = tempChannelsData;
            cacheObj.status = 'done';
            cacheObj.timestamp = Date.now();
        } catch (e) {
            cacheObj.status = 'idle';
        }
    })();

    if (cacheObj.data && cacheObj.data.length > 0) return cacheObj.data;
    
    return [{ 
        id: 'hyb_loading', 
        displayName: 'Base de données en cours d\'analyse... (Patientez 1 min)', 
        categories: ['tnt','info','sports','cinema','jeunesse','musique','decouverte','canal','autres','events'], 
        poster: LOADING_POSTER, 
        sources: [] 
    }];
}

// ============================================================================
// ROUTES
// ============================================================================

app.get('/api/stats', (req, res) => {
    let totalChannels = 0;
    let sourcesCount = {};
    let latestCache = null;
    let latestTime = 0;

    for (const [key, val] of Object.entries(channelsCache)) {
        if (val.timestamp > latestTime) {
            latestTime = val.timestamp;
            latestCache = val.data;
        }
    }

    if (latestCache) {
        totalChannels = latestCache.length;
        latestCache.forEach(ch => {
            if (ch.id === 'hyb_loading') return;
            ch.sources.forEach(src => {
                let base = src.type === 'm3u' ? 'Playlist M3U' : src.providerBase;
                if (base.length > 40) base = base.substring(0, 37) + '...';
                sourcesCount[base] = (sourcesCount[base] || 0) + 1;
            });
        });
    }
    
    res.json({
        epgCount: Object.keys(epgData).length,
        epgLastUpdate: lastUpdate,
        totalChannels: totalChannels > 1 ? totalChannels : 0,
        sourcesCount: sourcesCount
    });
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
                <b>HybridTV</b> centralise vos sources (Add-ons Stremio ou liens de playlists <b>.m3u/.m3u8</b>) en une bibliothèque francophone propre, triée et dotée d'un guide TV.
            </div>
            
            <div class="section">
                <label style="font-size: 14px; color: #ccc; font-weight: bold;">Sources de flux (Add-on manifest.json ou .m3u) :</label><br>
                <div id="sourcesContainer"></div>
                <button type="button" onclick="addSourceField()" class="btn btn-small">+ Ajouter une source</button>
            </div>

            <div class="section" style="text-align: center;">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="epgToggle" checked style="width: 18px; height: 18px; cursor: pointer;">
                    <b style="font-size: 15px;">Activer le Programme TV</b>
                </label>
            </div>

            <div class="section">
                <label style="font-size: 14px; color: #ccc; font-weight: bold;">🔑 Code de Sauvegarde / Partage :</label><br>
                <textarea id="exportTokenBox" class="export-box" placeholder="Code de configuration..."></textarea>
                <button type="button" onclick="importToken()" class="btn btn-small" style="margin-top: 5px;">📥 Importer le code</button>
            </div>
            
            <button type="button" onclick="generateLink()" class="btn">⚡ Générer le lien de l'Add-on</button>
            <br>
            <input type="text" id="manifestLink" class="main-link" placeholder="Cliquez sur 'Générer' pour afficher le lien..." readonly>
            <br>
            <button type="button" onclick="copyLink()" class="btn btn-secondary" style="margin-top: 10px;">📋 Copier le lien</button>
            
            <div class="stats" id="statsBox">
                <b>📊 État du service :</b><br>
                ✅ Serveur actif<br>
                ⏳ Chargement des statistiques...
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
                        <input type="text" id="src_\${index}" value="\${src}" placeholder="https://.../manifest.json ou lien .m3u">
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
                alert("Lien généré avec succès ! VEUILLEZ DÉSINSTALLER ET RÉINSTALLER L'ADD-ON DANS STREMIO POUR METTRE À JOUR LE CATALOGUE !");
            }

            async function fetchStats() {
                try {
                    let res = await fetch('/api/stats');
                    let data = await res.json();
                    let html = '<b>📊 État du service :</b><br>✅ Serveur actif et opérationnel<br><br>';
                    html += \`📅 <b>Guide TV (EPG) :</b> \${data.epgCount} chaînes synchronisées (\${data.epgLastUpdate})<br><br>\`;
                    
                    if (data.totalChannels > 0) {
                        html += \`📡 <b>Flux IPTV :</b> \${data.totalChannels} chaînes uniques validées<br>\`;
                        html += \`<ul style="margin-top:5px; text-align:left; padding-left: 20px;">\`;
                        for (const [source, count] of Object.entries(data.sourcesCount)) {
                            html += \`<li>\${source} : <b>\${count} flux trouvés</b></li>\`;
                        }
                        html += \`</ul>\`;
                    } else {
                        html += \`📡 <b>Flux IPTV :</b> <i>En attente du premier scan (Ouvrez l'add-on dans votre lecteur pour lancer l'analyse)</i>\`;
                    }
                    document.getElementById('statsBox').innerHTML = html;
                } catch(e) {}
            }

            let savedSources = localStorage.getItem('hybrid_sources');
            if (savedSources && !${sourcesParam ? 'true' : 'false'}) sources = JSON.parse(savedSources);
            renderSources();
            fetchStats();
            setInterval(fetchStats, 10000);

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
        version: '4.3.0',
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
            { type: 'tv', id: 'events', name: '🔴 Événements & Lives' },
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

    const validCatalogs = ['tnt', 'info', 'jeunesse', 'decouverte', 'cinema', 'musique', 'canal', 'sports', 'events', 'autres'];
    if (!validCatalogs.includes(requestedCatalog)) return res.json({ metas: [] });
    
    const filteredChannels = channelsData.filter(ch => ch.categories.includes(requestedCatalog));
    const paginatedMetas = filteredChannels.slice(skip, skip + 100).map(ch => ({
        id: ch.id, type: 'tv', name: ch.displayName, poster: ch.poster, posterShape: 'square'
    }));
    res.json({ metas: paginatedMetas });
});

app.get('/:config/meta/tv/:id.json', async (req, res) => {
    // Virtual loading channel response
    if (req.params.id === 'hyb_loading') {
        return res.json({
            meta: { 
                id: 'hyb_loading', 
                type: 'tv', 
                name: 'Connexion aux bases de données...', 
                poster: LOADING_POSTER, 
                posterShape: 'square', 
                description: 'Le serveur analyse l\'intégralité des flux disponibles chez vos fournisseurs. \n\nCette opération garantit que toutes les chaînes seront extraites. Cela prend environ 1 à 2 minutes la première fois. \n\nVeuillez revenir en arrière et patienter avant de recharger la page.' 
            }
        });
    }

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
    if (req.params.id === 'hyb_loading') return res.json({ streams: [] });

    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ streams: [] });
    
    const cacheKey = req.params.id + '|' + config.sources.join(',');
    if (streamCache.has(cacheKey)) {
        return res.json({ streams: streamCache.get(cacheKey) });
    }

    let channelsData = await getChannelsForSources(config.sources);
    res.setHeader('Cache-Control', 'max-age=1800, public'); 
    const rawIp = req.headers['x-forwarded-for'];
    const clientIp = rawIp ? rawIp.split(',')[0].trim() : req.socket.remoteAddress;

    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });
    
    try {
        let streamPromises = channel.sources.map(async (source) => {
            if (source.type === 'm3u') {
                return [{
                    url: source.directUrl,
                    name: `▶ Full HD (1080p)`,
                    title: source.originalName || "Source M3U",
                    _score: 1500,
                    _originalTitle: source.originalName || "Source M3U"
                }];
            }

            try {
                // Request to external provider. Timeout locked at 6s to prevent Stremio load failure.
                const streamRes = await axios.get(`${source.providerBase}/stream/tv/${source.metaId}.json`, {
                    headers: { 'X-Forwarded-For': clientIp }, timeout: 6000 
                });
                
                if (streamRes.data && streamRes.data.streams) {
                    return streamRes.data.streams.map((s, idx) => {
                        let qual = "SD";
                        let score = 0;
                        
                        let rawName = s.name || '';
                        let rawTitle = s.title || '';
                        let originalTitle = (rawName !== rawTitle) ? `${rawName} ${rawTitle}` : rawName || rawTitle;
                        originalTitle = originalTitle.replace(/http\S+/g, '').trim() || `Source Add-on ${idx + 1}`;

                        let up = originalTitle.toUpperCase();
                        
                        // Strict validation string
                        let nStream = up.normalize("NFD")
                            .replace(/[\u0300-\u036f]/g, "")
                            .replace(/\([^)]*\)/g, '')
                            .replace(/\[[^\]]*\]/g, '')
                            .replace(/\+/g, 'PLUS')
                            .replace(/[^A-Z0-9]/g, '');

                        let penalty = 0;
                        
                        // 1. Canal+ isolation
                        if (channel.id.startsWith('hyb_canal_') && !channel.id.includes('live')) {
                            let isBaseCanal = (channel.id === 'hyb_canal_cplus');
                            if (isBaseCanal) {
                                if (nStream.match(/(SPORT|FOOT|CINE|CNEMA|DECALE|KIDS|DOC|BOX|GRAND|SERIE|PREMIER|FRISSON|EMOTION|FAMIZ|CLUB|CLASSIC|COMEDIE|F1|MOTO|360|FAMILY|LIGUE1|DAZN|BEIN|MULTI)/)) {
                                    penalty += 5000;
                                }
                            } else {
                                let target = channel.id.replace('hyb_canal_', '').toUpperCase();
                                if (target.includes('SPORT') || target.includes('FOOT')) {
                                    if (nStream.includes('CINE') || nStream.includes('DOC') || nStream.includes('KIDS') || nStream.includes('SERIE') || nStream.includes('BOX')) penalty += 5000;
                                } else if (target.includes('CINE') || target.includes('SERIE') || target.includes('BOX') || target.includes('GRAND')) {
                                    if (nStream.includes('SPORT') || nStream.includes('FOOT') || nStream.includes('F1') || nStream.includes('MOTO') || nStream.includes('LIGUE1')) penalty += 5000;
                                }
                            }
                        }

                        // 2. Kids channels isolation
                        if (channel.id === 'hyb_jeu_disney') {
                            if (nStream.includes('JR') || nStream.includes('JUNIOR') || nStream.includes('XD') || nStream.includes('PLUS1')) penalty += 5000;
                        }

                        // 3. Sports multiplex strict evaluation
                        if (channel.id.startsWith('hyb_sport_bein')) {
                            let targetNumMatch = channel.id.match(/_(\d+)$/);
                            let targetNum = targetNumMatch ? targetNumMatch[1] : '1';
                            let isTargetMax = channel.id.includes('max');
                            
                            let streamNumMatch = nStream.match(/BEIN(?:SPORT|MAX)?S?(\d+)/i);
                            if (streamNumMatch) {
                                if (streamNumMatch[1] !== targetNum) penalty += 5000;
                            } else if (targetNum !== '1') {
                                penalty += 5000;
                            }
                            if (isTargetMax !== nStream.includes('MAX')) penalty += 5000;
                        }

                        if (channel.id.startsWith('hyb_sport_ligue1plus')) {
                            let targetNumMatch = channel.id.match(/_(\d+)$/);
                            let targetNum = targetNumMatch ? targetNumMatch[1] : '1';
                            let streamNumMatch = nStream.match(/(?:LIGUE1|L1)(?:PLUS)?(\d+)/i);
                            if (streamNumMatch) {
                                if (streamNumMatch[1] !== targetNum) penalty += 5000;
                            } else if (targetNum !== '1') {
                                penalty += 5000; 
                            }
                        }

                        if (channel.id.startsWith('hyb_sport_dazn') && !channel.id.includes('live') && !channel.id.includes('rise')) {
                            let targetNumMatch = channel.id.match(/_(\d+)$/);
                            let targetNum = targetNumMatch ? targetNumMatch[1] : '1';
                            let streamNumMatch = nStream.match(/DAZN(\d+)/i);
                            if (streamNumMatch && streamNumMatch[1] !== targetNum) {
                                penalty += 5000;
                            }
                        }

                        if (channel.id.startsWith('hyb_canal_live')) {
                            let targetNumMatch = channel.id.match(/_(\d+)$/);
                            let targetNum = targetNumMatch ? targetNumMatch[1] : '1';
                            let streamNumMatch = nStream.match(/LIVE(\d+)/i);
                            if (streamNumMatch) {
                                if (streamNumMatch[1] !== targetNum) penalty += 5000;
                            } else {
                                penalty += 5000;
                            }
                        }

                        // 4. Quality scoring configuration
                        if (up.includes('FHD') || up.includes('1080')) { qual = "Full HD (1080p)"; score += 1500; } 
                        else if (up.includes('HD') || up.includes('720')) { qual = "HD (720p)"; score += 1000; } 
                        else if (up.includes('4K') || up.includes('2160') || up.includes('UHD')) { qual = "4K (UHD)"; score += 500; } 
                        else { score += 0; } 

                        if (up.match(/\bFR\b/) || up.match(/\bVF\b/) || up.includes('FRENCH') || up.includes('TRUEFRENCH')) {
                            score += 300; 
                        }
                        
                        if (up.includes('BACKUP') || up.includes('SECOURS') || up.includes('ALT') || up.includes('TEST')) score -= 1000;
                        
                        score -= penalty;
                        score -= idx; 
                        score += (10 - source.sourceIndex) * 10;

                        return { ...s, _qualText: qual, _score: score, _originalTitle: originalTitle };
                    });
                }
            } catch (err) {}
            return [];
        });

        let results = await Promise.all(streamPromises);
        let allStreams = [].concat(...results);

        allStreams.sort((a, b) => b._score - a._score);
        const limitedStreams = allStreams.slice(0, 15);

        // Display formatting: Original string mapped to name, parsing mapped to title
        const finalStreams = limitedStreams.map((s) => ({
            url: s.url, 
            name: s._originalTitle, 
            title: `▶ ${s._qualText}`
        }));
        
        streamCache.set(cacheKey, finalStreams);
        setTimeout(() => streamCache.delete(cacheKey), 300000);

        res.json({ streams: finalStreams });
    } catch (err) { res.json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`[INFO] Server started on port ${PORT}`);
    updateEPG(); 
    setInterval(updateEPG, 3600000); 
});
