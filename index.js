/**
 * HybridTV - IPTV Meta-Addon
 * Version: 1.5.0 (Pure Passthrough & Dedicated Live Sport Input)
 * Core Engine: Synchronous Health Check (TV Only), Fast-Track Sport, Cross-Search.
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

const serverStats = {
    startTime: Date.now(),
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    channelClicks: {},
    activeIps: new Map()
};

// --- MIDDLEWARE: Metrics Tracker ---
app.use((req, res, next) => {
    if (req.path.includes('.json')) {
        serverStats.totalRequests++;
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (ip) {
            const cleanIp = ip.split(',')[0].trim();
            serverStats.activeIps.set(cleanIp, Date.now());
        }
    }
    next();
});

// Nettoyage des vieilles IPs en tâche de fond
setInterval(() => {
    const now = Date.now();
    for (let [key, time] of serverStats.activeIps.entries()) {
        if (now - time > 5 * 60 * 1000) serverStats.activeIps.delete(key);
    }
}, 60000);

// --- ASSETS & CONFIG ---
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';
const EVENT_POSTER = 'https://cdn-icons-png.flaticon.com/512/861/861512.png';

const BLACKLIST = [
    'ALACARTE', 'DISNEYPLUS', 'NETFLIX', 'PRIMEVIDEO', 'APPLETV',
    'TEST', 'MIRROR', 'BACKUPCHANNEL', 'BOXOFFICE1', 'BOXOFFICE2', 'CANALPLAY', 'AFRIQUE', 'DEUTSCH', 'GERMAN'
];

function parseConfig(encodedConfig) {
    try {
        if (!encodedConfig || encodedConfig === 'manifest.json') return { sources: [], liveSport: '', qualities: ['1080p', '720p', '4K', 'SD'] };
        const jsonStr = Buffer.from(encodedConfig, 'base64').toString('utf8');
        let parsed = JSON.parse(jsonStr);
        if (!parsed.qualities || !Array.isArray(parsed.qualities)) parsed.qualities = ['1080p', '720p', '4K', 'SD'];
        if (typeof parsed.liveSport !== 'string') parsed.liveSport = '';
        return parsed;
    } catch (e) {
        return { sources: [], liveSport: '', qualities: ['1080p', '720p', '4K', 'SD'] };
    }
}

// --- LIVE SPORTS BACKGROUND SCANNER (PURE PASSTHROUGH) ---
let liveSportsCache = [];
let nuvioCatalogsCache = {}; // Stocke les catalogues natifs de Nuvio par URL
let isScanningSports = false;
let activeNuvioSources = new Set();

async function runLiveSportsScanner() {
    if (isScanningSports || activeNuvioSources.size === 0) return;
    isScanningSports = true;
    
    let tempSports = [];
    try {
        for (let cleanUrl of activeNuvioSources) {
            try {
                let manifestRes = await axios.get(cleanUrl + '/manifest.json', { timeout: 30000 });
                let rawCatalogs = manifestRes.data.catalogs || [];
                
                // PASSTHROUGH ABSOLU : On sauvegarde les catalogues Nuvio tels quels
                nuvioCatalogsCache[cleanUrl] = rawCatalogs;
                
                for (let catalog of rawCatalogs) {
                    let catId = catalog.id;
                    let hasMore = true;
                    let skip = 0;
                    
                    while (hasMore && skip < 5000) { 
                        try {
                            let url = skip > 0 ? `${cleanUrl}/catalog/${catalog.type}/${encodeURIComponent(catId)}/skip=${skip}.json` : `${cleanUrl}/catalog/${catalog.type}/${encodeURIComponent(catId)}.json`;
                            let res = await axios.get(url, { timeout: 30000 });
                            
                            if (res.data && res.data.metas && res.data.metas.length > 0) {
                                res.data.metas.forEach(m => {
                                    let up = (m.name || '').toUpperCase();
                                    if (up.includes('U19') || up.includes('U21') || up.includes('RESERVE') || up.includes('WOMEN') || up.includes('YOUTH')) return;
                                    
                                    tempSports.push({
                                        id: m.id,
                                        type: 'tv',
                                        name: m.name,
                                        displayName: m.name,
                                        poster: m.poster || EVENT_POSTER,
                                        posterShape: 'square',
                                        categories: [catId], // Catégorie native stricte
                                        _providerBase: cleanUrl,
                                        _isDirectStream: false
                                    });
                                });
                                skip += res.data.metas.length;
                                
                                let seenProgressive = new Set();
                                liveSportsCache = tempSports.filter(s => {
                                    if (seenProgressive.has(s.id)) return false;
                                    seenProgressive.add(s.id);
                                    return true;
                                });

                                await new Promise(r => setTimeout(r, 400)); 
                            } else {
                                hasMore = false;
                            }
                        } catch (e) {
                            hasMore = false;
                        }
                    }
                }
            } catch (e) {
                // Ignore et passe à la source suivante
            }
        }
    } finally {
        isScanningSports = false;
    }
}
setInterval(runLiveSportsScanner, 300 * 1000); 

// --- ORIGINAL SEMANTIC ROUTING (POUR LA TV UNIQUEMENT) ---
function getChannelData(rawName) {
    if (!rawName) return null;

    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
    n = n.replace(/^(?:FR|BE|CH|CA|VIP|VAVOO)\s*[:|/-]+\s*/i, '');
    n = n.replace(/DURING EVENT ONLY/g, '').replace(/EVENT ONLY/g, '');
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'DIRECT', 'RAW', 'ACCESS'];
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'gi'), ''); });

    if (n.includes('LFL') || n.includes('LEAGUE OF LEGENDS')) return { id: 'hyb_esport_lfl', name: 'LFL (eSport)', categories: ['autres'], index: 10 };
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

    let c = n.replace(/[^A-Z0-9]/g, '');
    if (!c || c.length < 2) return null;
    if (BLACKLIST.some(b => c.includes(b))) return null;

    if (c.includes('JURAS') || c.includes('TOP14') || c.includes('LCENTRE') || c.includes('LIGA') || c === 'CANALPLUSL' || c === 'CPLUSL' || c === 'CPLUSSPORT') {
        let pretty = rawName.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\b(?:FHD|HD|SD|4K|1080P|720P)\b/gi, '').trim();
        return { id: 'hyb_aut_' + c.substring(0, 15), name: pretty, categories: ['autres'], index: 200 };
    }

    if (c.startsWith('FRANCE24')) return { id: 'hyb_info_06', name: 'France 24', categories: ['info'], index: 6 };
    if (c.startsWith('FRANCEINFO')) return { id: 'hyb_info_07', name: 'France Info', categories: ['info'], index: 7 };
    if (c === 'BFMTV' || c === 'BFM') return { id: 'hyb_info_01', name: 'BFMTV', categories: ['info'], index: 1 };
    if (c.includes('CNEWS')) return { id: 'hyb_info_03', name: 'CNews', categories: ['info'], index: 3 };
    if (c === 'LCI') return { id: 'hyb_info_04', name: 'LCI', categories: ['info'], index: 4 };

    if (c.includes('CANAL') || c.includes('CPLUS')) {
        if (c.includes('LIVE')) {
            let m = c.match(/LIVE(\d+)/); let num = m ? m[1] : '1';
            return { id: 'hyb_canal_live_' + num, name: 'Canal+ Live ' + num, categories: ['canal'], index: 200 + parseInt(num, 10) };
        }
        if (c.includes('SPORT')) return { id: 'hyb_canal_sport', name: 'Canal+ Sport', categories: ['canal', 'sports'], index: 94 };
        if (c.includes('CINEMA') || c.includes('CNEMA')) return { id: 'hyb_canal_cinema', name: 'Canal+ Cinéma', categories: ['canal', 'cinema'], index: 2 };
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
    if (c.includes('LEQUIPE')) return { id: 'hyb_sport_lequipe', name: "L'Équipe", categories: ['sports', 'tnt'], index: 98 };

    if (c.includes('CINE') || c.includes('CINA')) {
        if (c.includes('ACTION')) return { id: 'hyb_cine_action', name: 'Action', categories: ['cinema'], index: 30 };
        return { id: 'hyb_cine_plus', name: 'Ciné+', categories: ['cinema', 'canal'], index: 19 };
    }
    
    if (c.startsWith('TF1')) return { id: 'hyb_tnt_1', name: 'TF1', categories: ['tnt'], index: 1 };
    if (c.startsWith('FRANCE2') || c === 'FR2') return { id: 'hyb_tnt_2', name: 'France 2', categories: ['tnt'], index: 2 };
    if (c.startsWith('FRANCE3') || c === 'FR3') return { id: 'hyb_tnt_3', name: 'France 3', categories: ['tnt'], index: 3 };
    if (c.startsWith('M6')) return { id: 'hyb_tnt_6', name: 'M6', categories: ['tnt'], index: 6 };
    if (c.startsWith('ARTE')) return { id: 'hyb_tnt_7', name: 'Arte', categories: ['tnt'], index: 7 };
    if (c.startsWith('C8')) return { id: 'hyb_tnt_8', name: 'C8', categories: ['tnt'], index: 8 };
    if (c.startsWith('W9')) return { id: 'hyb_tnt_9', name: 'W9', categories: ['tnt'], index: 9 };
    if (c.startsWith('TMC')) return { id: 'hyb_tnt_10', name: 'TMC', categories: ['tnt'], index: 10 };

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
            const maxSkip = 50000; 
            const batchSize = 3;   
            let seenIds = new Set(); 

            while (hasMore && skip < maxSkip) {
                let requests = [];
                for (let i = 0; i < batchSize; i++) {
                    let currentSkip = skip + (i * 100);
                    let encodedCatId = encodeURIComponent(catalog.id);
                    let url = currentSkip > 0 ? `${base}/catalog/${catalog.type}/${encodedCatId}/skip=${currentSkip}.json` : `${base}/catalog/${catalog.type}/${encodedCatId}.json`;
                    requests.push(axios.get(url, { timeout: 6000 }).catch(e => null));
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
    } catch (err) {}

    return metas;
}

// --- SYNC ORCHESTRATOR ---
async function getChannelsForSources(sourcesList, liveSportUrl) {
    const cacheKey = sourcesList.join('|') + '|' + (liveSportUrl || '');

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

            // 1. Traitement de la source Live Sport dédiée
            if (liveSportUrl && liveSportUrl.trim() !== '') {
                let cleanSportUrl = liveSportUrl.replace(/\/manifest\.json$/, '').trim();
                activeNuvioSources.add(cleanSportUrl);
                
                sourceReport['live_sport_addon'] = { 
                    url: cleanSportUrl,
                    count: liveSportsCache.length, 
                    status: liveSportsCache.length > 0 ? `✅ Actif (${liveSportsCache.length} flux)` : `⏳ En attente de scan...` 
                };
                
                if (liveSportsCache.length === 0 && !isScanningSports) {
                    runLiveSportsScanner(); 
                }
            }

            // 2. Traitement des sources IPTV Classiques
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
// APP ROUTES & DASHBOARD
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
        totalChannels: totalChannels > 1 ? totalChannels : 0,
        sourceReport: sourceReport
    });
});

app.get('/', async (req, res) => {
    let parsedConf = parseConfig(req.query.config);
    let sourcesList = req.query.sources ? req.query.sources.split(',') : ['', ''];
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
            .source-num { font-size: 13px; font-weight: bold; color: var(--text-muted); min-width: 20px; text-align: center; }
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
            
            .status-ok { color: #4caf50; }
            .status-warn { color: #ff9800; }
            .status-err { color: #f44336; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>📺 HybridTV Dashboard</h1>
                <p class="subtitle">Version 1.5.0 - Passerelle Pure & Fast-Track Sport</p>
            </div>

            <div class="tabs">
                <button class="tab-btn active" onclick="switchTab('config', this)">⚙️ Configurer</button>
                <button class="tab-btn" onclick="switchTab('metrics', this)">📊 Métriques</button>
            </div>

            <div id="config" class="tab-content active">
                
                <div class="section">
                    <h3 class="section-title">Encart : Add-on Live Sport</h3>
                    <p class="subtitle" style="margin-bottom: 10px; font-size: 12px;">Collez ici le lien de votre Add-on Sport. Fast-Track et Recherche Croisée seront activés. Passthrough absolu des catégories (Top Match, Vos Équipes...).</p>
                    <input type="text" id="liveSportBox" placeholder="URL Add-on Live Sport (ex: https://.../manifest.json)" style="width: 100%; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px; box-sizing: border-box;">
                </div>

                <div class="section">
                    <h3 class="section-title">Sources Classiques (TV / VOD)</h3>
                    <div id="sourcesContainer"></div>
                    <button type="button" onclick="addSourceField()" class="btn btn-small" style="margin-top: 10px;">+ Ajouter une source</button>
                </div>

                <div class="section">
                    <h3 class="section-title">Priorité de Qualité</h3>
                    <div id="qualityList" style="display: flex; flex-direction: column; gap: 8px;"></div>
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
                    <div class="metric-card">
                        <div class="metric-label">Uptime</div>
                        <div class="metric-value" id="m-uptime">--</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Requêtes</div>
                        <div class="metric-value" id="m-req">--</div>
                    </div>
                </div>

                <div class="section">
                    <h3 class="section-title">Rapport des Sources</h3>
                    <ul class="report-list" id="sourceReportList">
                        <li><i>Chargement...</i></li>
                    </ul>
                </div>
            </div>
        </div>

        <script>
            let sources = ${JSON.stringify(sourcesList)};
            let qualities = ${defaultQualities};
            let loadedLiveSport = \`${parsedConf.liveSport || ''}\`;
            
            document.getElementById('liveSportBox').value = loadedLiveSport;

            function switchTab(tabId, btn) {
                document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
                document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
                document.getElementById(tabId).classList.add('active');
                if(tabId === 'metrics') fetchMetrics();
            }

            function renderSources() {
                const container = document.getElementById('sourcesContainer');
                if (!container) return;
                container.innerHTML = '';
                sources.forEach((src, index) => {
                    if (index >= 8) return; // Limite à 8 pour la TV classique
                    const div = document.createElement('div');
                    div.className = 'source-row';
                    div.innerHTML = \`
                        <span class="source-num">#\${index + 1}</span>
                        <input type="text" id="src_\${index}" value="\${src}" placeholder="URL manifest.json ou .m3u">
                        \${index > 0 ? '<button type="button" onclick="moveSource(' + index + ', -1)" class="btn-small">▲</button>' : '<div style="width: 28px;"></div>'}
                        \${index < sources.length - 1 ? '<button type="button" onclick="moveSource(' + index + ', 1)" class="btn-small">▼</button>' : '<div style="width: 28px;"></div>'}
                        \${sources.length > 1 ? '<button type="button" onclick="removeSource(' + index + ')" class="btn-danger">✕</button>' : ''}
                    \`;
                    container.appendChild(div);
                });
                updateExportToken();
            }

            function renderQualities() {
                const container = document.getElementById('qualityList');
                if (!container) return;
                container.innerHTML = '';
                qualities.forEach((q, index) => {
                    let badge = q === '4K' ? ' <span style="font-size:10px;color:#ff9800;">(Instable)</span>' : '';
                    container.innerHTML += \`
                        <div style="display: flex; align-items: center; background: #222; border: 1px solid #444; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px;">
                            <span style="font-size: 14px; font-weight: bold; color: #e50914; min-width: 25px;">\${index + 1}.</span>
                            <span style="flex: 1; font-size: 13px;">\${q}\${badge}</span>
                            \${index > 0 ? '<button type="button" onclick="moveQuality(' + index + ', -1)" class="btn-small" style="padding: 4px 8px; margin-right: 5px;">▲</button>' : '<div style="width: 28px; margin-right: 5px;"></div>'}
                            \${index < qualities.length - 1 ? '<button type="button" onclick="moveQuality(' + index + ', 1)" class="btn-small" style="padding: 4px 8px;">▼</button>' : '<div style="width: 28px;"></div>'}
                        </div>
                    \`;
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

            function moveQuality(index, direction) {
                const newIndex = index + direction;
                if (newIndex < 0 || newIndex >= qualities.length) return;
                const temp = qualities[index];
                qualities[index] = qualities[newIndex];
                qualities[newIndex] = temp;
                localStorage.setItem('hybrid_qualities', JSON.stringify(qualities));
                renderQualities();
            }

            function addSourceField() { if (sources.length < 8) { saveInputs(); sources.push(''); renderSources(); } }
            function removeSource(index) { saveInputs(); sources.splice(index, 1); renderSources(); }
            
            function saveInputs() {
                sources.forEach((_, index) => { const el = document.getElementById('src_' + index); if (el) sources[index] = el.value.trim(); });
                localStorage.setItem('hybrid_sources', JSON.stringify(sources));
                updateExportToken();
            }

            function updateExportToken() {
                const validSources = sources.filter(s => s.length > 0);
                const lsUrl = document.getElementById('liveSportBox').value.trim();
                const configObj = { sources: validSources, qualities: qualities, liveSport: lsUrl }; 
                const tokenBox = document.getElementById('exportTokenBox');
                if (tokenBox) tokenBox.value = btoa(JSON.stringify(configObj));
            }

            function importToken() {
                let inputCode = prompt("Collez le code de sauvegarde ici :");
                if (!inputCode) return;
                try {
                    const jsonStr = atob(inputCode.trim());
                    const config = JSON.parse(jsonStr);
                    if (config.sources && Array.isArray(config.sources)) {
                        sources = config.sources; if (sources.length === 0) sources = ['', ''];
                        if (config.qualities) { qualities = config.qualities; localStorage.setItem('hybrid_qualities', JSON.stringify(qualities)); }
                        if (config.liveSport) { document.getElementById('liveSportBox').value = config.liveSport; }
                        renderSources(); renderQualities(); alert("Configuration importée avec succès !");
                    } else alert("Code invalide.");
                } catch(e) { alert("Erreur : Ce code est corrompu."); }
            }

            function generateLink() {
                saveInputs();
                const validSources = sources.filter(s => s.length > 0);
                const ls = document.getElementById('liveSportBox').value.trim();
                if (validSources.length === 0 && !ls) return alert("Veuillez entrer au moins une source !");
                const token = document.getElementById('exportTokenBox').value;
                const linkField = document.getElementById("manifestLink");
                if (linkField) linkField.value = window.location.protocol + "//" + window.location.host + "/" + token + "/manifest.json";
                alert("Lien généré. Veuillez désinstaller l'ancienne version dans Stremio avant d'ajouter celle-ci !");
            }

            function copyLink() {
                var copyText = document.getElementById("manifestLink");
                if (!copyText || !copyText.value) return alert("Générez le lien d'abord !");
                copyText.select(); document.execCommand("copy"); alert("Copié !");
            }

            document.getElementById('liveSportBox').addEventListener('input', updateExportToken);

            async function fetchMetrics() {
                try {
                    let res = await fetch('/api/metrics');
                    let data = await res.json();
                    
                    document.getElementById('m-uptime').innerText = data.uptime;
                    document.getElementById('m-req').innerText = data.totalRequests;
                    
                    let htmlList = '';
                    
                    if (data.sourceReport['live_sport_addon']) {
                        let ls = data.sourceReport['live_sport_addon'];
                        htmlList += \`<li style="background: #2a1111; padding: 10px; border-radius: 5px;"><span><strong>⚽ Live Sport</strong></span> <b class="\${ls.count > 0 ? 'status-ok' : 'status-warn'}">\${ls.status}</b></li>\`;
                    }

                    sources.forEach(src => {
                        if (!src) return;
                        let cleanSrc = src.replace(/\\/manifest\\.json$/, '').trim();
                        let displaySrc = cleanSrc.length > 35 ? cleanSrc.substring(0, 32) + '...' : cleanSrc;
                        let r = data.sourceReport[cleanSrc];
                        
                        if (!r || r.status === 'fetching') htmlList += \`<li><span>\${displaySrc}</span> <b class="status-warn">⏳ En attente</b></li>\`;
                        else if (r.status === 'ok') htmlList += \`<li><span>\${displaySrc}</span> <b class="status-ok">✅ \${r.count} flux</b></li>\`;
                        else if (r.status === 'empty') htmlList += \`<li><span>\${displaySrc}</span> <b class="status-warn">⚠️ 0 flux</b></li>\`;
                        else htmlList += \`<li><span>\${displaySrc}</span> <b class="status-err">❌ Hors Ligne</b></li>\`;
                    });
                    
                    const sourceReportList = document.getElementById('sourceReportList');
                    if (sourceReportList) sourceReportList.innerHTML = htmlList || '<li><i>Aucune source configurée</i></li>';
                } catch(e) {}
            }

            let savedSources = localStorage.getItem('hybrid_sources');
            if (savedSources && !${req.query.config ? 'true' : 'false'}) sources = JSON.parse(savedSources);
            
            let savedQualities = localStorage.getItem('hybrid_qualities');
            if (savedQualities && !${req.query.config ? 'true' : 'false'}) {
                try { qualities = JSON.parse(savedQualities); } catch(e){}
            }

            renderSources(); renderQualities();
            setInterval(() => { if(document.getElementById('metrics').classList.contains('active')) fetchMetrics(); }, 5000);
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// --- MANIFEST BUILDER ---
app.get('/:config/manifest.json', (req, res) => {
    const config = parseConfig(req.params.config);
    res.setHeader('Cache-Control', 'max-age=86400, public'); 

    // Les catalogues TV de base
    let baseCatalogs = [
        { type: 'tv', id: 'tnt', name: '📺 TNT' },
        { type: 'tv', id: 'info', name: '📰 Information' },
        { type: 'tv', id: 'jeunesse', name: '👶 Jeunesse' },
        { type: 'tv', id: 'decouverte', name: '🔬 Découverte & Docu' },
        { type: 'tv', id: 'cinema', name: '🍿 Cinéma & Séries' },
        { type: 'tv', id: 'musique', name: '🎵 Musique' },
        { type: 'tv', id: 'canal', name: '🎟️ Bouquet Canal' },
        { type: 'tv', id: 'sports', name: '⚽ Sports TV' },
        { type: 'tv', id: 'autres', name: '📂 Autres TV' }
    ];

    // Extraction dynamique des catalogues Nuvio en cours (Passthrough)
    let liveCatalogs = [];
    if (config.liveSport) {
        let cleanUrl = config.liveSport.replace(/\/manifest\.json$/, '').trim();
        if (nuvioCatalogsCache[cleanUrl]) {
            // On prend les catalogues natifs et on ajoute juste "Live Sport - " au titre
            liveCatalogs = nuvioCatalogsCache[cleanUrl].map(c => ({
                type: 'tv',
                id: c.id,
                name: c.name ? `⚽ Live Sport - ${c.name}` : `⚽ Live Sport - ${c.id}`
            }));
        }
    }
    
    let finalCatalogs = baseCatalogs.concat(liveCatalogs);

    // Rendre TOUS les catalogues recherchables (Recherche Croisée)
    finalCatalogs.forEach(c => c.extra = [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }]);

    res.json({
        id: 'org.hybridtv.meta', 
        version: '1.5.0',
        name: 'HybridTV',
        description: 'Meta-Addon IPTV v1.5.0 (Pure Passthrough & Fast-Track Sport).',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: finalCatalogs,
        behaviorHints: { configurable: true, configurationRequired: false }
    });
});

app.get(['/:config/catalog/tv/:id.json', '/:config/catalog/tv/:id/:extra'], async (req, res) => {
    const config = parseConfig(req.params.config);
    if ((!config.sources || config.sources.length === 0) && !config.liveSport) return res.json({ metas: [] });
    
    let channelsData = await getChannelsForSources(config.sources, config.liveSport);
    
    res.setHeader('Cache-Control', 'max-age=14400, public'); 
    const requestedCatalog = req.params.id; 
    let skip = 0;
    let searchQuery = "";
    
    if (req.params.extra) {
        const skipMatch = req.params.extra.match(/skip=(\d+)/);
        if (skipMatch) skip = parseInt(skipMatch[1], 10);
        
        const searchMatch = req.params.extra.match(/search=([^&]+)/);
        if (searchMatch) searchQuery = decodeURIComponent(searchMatch[1]).toLowerCase();
    }

    let allChannels = channelsData.concat(liveSportsCache);
    let filteredChannels = [];
    
    if (searchQuery) {
        filteredChannels = allChannels.filter(ch => {
            const name = ch.displayName || ch.name || '';
            // Recherche croisée (Cache Nuvio + Guide TV en cours)
            let matchTitle = name.toLowerCase().includes(searchQuery);
            let matchEPG = false;
            
            if (!matchTitle && epgData[ch.id]) {
                const now = Date.now();
                const currentProg = epgData[ch.id].find(p => now >= p.start && now <= p.stop);
                if (currentProg && currentProg.title.toLowerCase().includes(searchQuery)) {
                    matchEPG = true;
                }
            }
            return matchTitle || matchEPG;
        });
    } else {
        filteredChannels = allChannels.filter(ch => ch.categories && ch.categories.includes(requestedCatalog));
    }
    
    const paginatedMetas = filteredChannels.slice(skip, skip + 100).map(ch => ({
        id: ch.id, type: 'tv', name: ch.displayName || ch.name, poster: ch.poster, posterShape: 'square'
    }));
    res.json({ metas: paginatedMetas });
});

app.get('/:config/meta/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if ((!config.sources || config.sources.length === 0) && !config.liveSport) return res.json({ meta: {} });
    
    let channelsData = await getChannelsForSources(config.sources, config.liveSport);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); 
    
    let channel = channelsData.find(c => c.id === req.params.id) || liveSportsCache.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });
    
    let displayName = channel.displayName || channel.name;
    let descriptionText = `▶ Diffusion en cours sur ${displayName}...`;
    
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

    res.json({ meta: { id: channel.id, type: 'tv', name: displayName, poster: channel.poster, posterShape: 'square', description: descriptionText } });
});

app.get('/:config/stream/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if ((!config.sources || config.sources.length === 0) && !config.liveSport) return res.json({ streams: [] });

    const cacheKey = req.params.id + '|' + config.sources.join(',') + '|' + config.liveSport;
    if (streamCache.has(cacheKey)) { return res.json({ streams: streamCache.get(cacheKey) }); }

    let channelsData = await getChannelsForSources(config.sources, config.liveSport);
    res.setHeader('Cache-Control', 'max-age=45, public'); 

    // Détection : C'est une chaîne TV ou un Live Sport ?
    let isLiveSport = false;
    let channel = channelsData.find(c => c.id === req.params.id);
    
    if (!channel) {
        const liveSportChannel = liveSportsCache.find(c => c.id === req.params.id);
        if (liveSportChannel) {
            isLiveSport = true;
            channel = {
                id: liveSportChannel.id,
                displayName: liveSportChannel.name,
                sources: [{ type: 'addon', metaId: liveSportChannel.id, providerBase: liveSportChannel._providerBase, sourceIndex: 0, originalName: liveSportChannel.name }]
            };
        }
    }
    
    if (!channel) return res.json({ streams: [] });
    
    try {
        let streamPromises = channel.sources.map(async (source) => {
            if (source.type === 'm3u') {
                return [{
                    url: source.directUrl,
                    name: `▶ Full HD (1080p)`,
                    title: source.originalName || "Source M3U",
                    _score: 1500,
                    behaviorHints: { proxyHeaders: { request: { 'User-Agent': 'Mozilla/5.0' } } }
                }];
            }

            try {
                let targetUrl = `${source.providerBase}/stream/tv/${encodeURIComponent(source.metaId)}.json`;
                const streamRes = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
                
                if (streamRes.data && streamRes.data.streams) {
                    return streamRes.data.streams.map((s, idx) => {
                        let outStream = { ...s };
                        outStream._score = 1000 - idx; // Tri de base très simple
                        
                        if (outStream.url && outStream.url.startsWith('//')) outStream.url = 'https:' + outStream.url;
                        
                        if (!outStream.behaviorHints) outStream.behaviorHints = {};
                        if (!outStream.behaviorHints.notWebReady) outStream.behaviorHints.notWebReady = true;

                        outStream.name = s.name || source.originalName || "Source Add-on";
                        return outStream;
                    });
                }
            } catch (err) {}
            return [];
        });

        let results = await Promise.all(streamPromises);
        let allStreams = [].concat(...results);
        allStreams.sort((a, b) => b._score - a._score);
        let limitedStreams = allStreams.slice(0, 15);

        // --- HEALTH CHECK CONDITIONNEL (Uniquement pour la TV classique) ---
        if (limitedStreams.length > 0 && !isLiveSport) {
            await Promise.all(limitedStreams.map(async (s) => {
                if (!s.url) return;
                try {
                    const r = await axios.get(s.url, { responseType: 'stream', timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                    if(r.data && typeof r.data.destroy === 'function') r.data.destroy();
                } catch (err) {
                    if (err.response && [403, 503, 520, 521, 522, 523, 524, 525].includes(err.response.status)) {
                        s.title = `🛡️ Protégé\n` + (s.title || '');
                    } else {
                        s._score -= 100000; 
                        s.title = `❌ HS\n` + (s.title || '');
                    }
                }
            }));
            limitedStreams.sort((a, b) => b._score - a._score);
        }

        const finalStreams = limitedStreams.map(s => { let obj = { ...s }; delete obj._score; return obj; });
        streamCache.set(cacheKey, finalStreams);
        setTimeout(() => streamCache.delete(cacheKey), 45000); 

        res.json({ streams: finalStreams });
    } catch (err) { res.json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`[INFO] Server started on port ${PORT}`);
    updateEPG(); setInterval(updateEPG, 3600000); 
});
