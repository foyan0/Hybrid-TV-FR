/**
 * HybridTV
 * Version: 1.0.5 (Dashboard Complet Restoré & Background Stream Warmer)
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
let backgroundStreamCache = new Map(); // Cache proactif asynchrone pour zéro latence de recherche

const serverStats = {
    startTime: Date.now(),
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    channelClicks: {},
    activeIps: new Map()
};

// --- SECURITY: SSRF Protection ---
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

function extractMatchEvent(rawName) {
    if (!rawName) return null;
    let s = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();

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
        let cleanTeam = (str) => str.replace(/[^A-Z0-9\s]/g, '').trim();
        let t1 = cleanTeam(vsMatch[1]);
        let t2 = cleanTeam(vsMatch[2]);
        if (t1.length >= 2 && t2.length >= 2 && t1 !== t2) {
            let canonicalKey = [toSyncId(t1), toSyncId(t2)].sort().join('_');
            return { id: 'hyb_ev_' + canonicalKey, name: `⚽ ${t1} vs ${t2}`, categories: ['events'], index: 5, customPoster: EVENT_POSTER };
        }
    }
    return null;
}

// --- ROUTAGE SÉMANTIQUE CORRIGÉ (ISOLATION STRICTE DE CANAL J, SAVOIR, MOTOGP) ---
function getChannelData(rawName) {
    if (!rawName) return null;
    let eventData = extractMatchEvent(rawName);
    if (eventData) return eventData;

    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
    n = n.replace(/^(?:FR|BE|CH|CA|VIP|VAVOO)\s*[:|/-]+\s*/i, '');
    
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'DIRECT', 'RAW'];
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'gi'), ''); });

    n = n.replace(/\+/g, 'PLUS');
    let c = n.replace(/[^A-Z0-9]/g, '');
    if (!c || c.length < 2) return null;
    if (BLACKLIST.some(b => c.includes(b))) return null;

    // 1. EXCEPTIONS "CANAL" (Chaînes indépendantes)
    if (c.includes('CANALJ') || c === 'CJ') return { id: 'hyb_jeu_canalj', name: 'Canal J', categories: ['jeunesse'], index: 6 };
    if (c.includes('CANALSAVOIR') || c.includes('SAVOIR')) return { id: 'hyb_dec_savoir', name: 'Canal Savoir', categories: ['decouverte'], index: 40 };
    if (c.includes('MOTOGP') || c.includes('MOTO GP')) return { id: 'hyb_sport_motogp', name: 'Canal+ MotoGP', categories: ['sports', 'canal'], index: 92 };
    if (c.includes('FORMULA1') || c.includes('F1')) return { id: 'hyb_sport_f1', name: 'Canal+ Formula 1', categories: ['sports', 'canal'], index: 93 };

    // 2. BOUQUET CANAL+ OFFICIEL
    if (c.includes('CANAL') || c.includes('CPLUS')) {
        if (c.includes('ELLES')) return { id: 'hyb_aut_canal_elles', name: 'Canal+ Elles', categories: ['autres'], index: 1000 };
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

    // 3. AUTRES CHAÎNES PRINCIPALES
    if (c.startsWith('TF1')) return { id: 'hyb_tnt_1', name: 'TF1', categories: ['tnt'], index: 1 };
    if (c.startsWith('FRANCE2') || c === 'FR2') return { id: 'hyb_tnt_2', name: 'France 2', categories: ['tnt'], index: 2 };
    if (c.startsWith('FRANCE3') || c === 'FR3') return { id: 'hyb_tnt_3', name: 'France 3', categories: ['tnt'], index: 3 };
    if (c.startsWith('M6')) return { id: 'hyb_tnt_6', name: 'M6', categories: ['tnt'], index: 6 };
    if (c.startsWith('BFMTV') || c === 'BFM') return { id: 'hyb_info_01', name: 'BFMTV', categories: ['info'], index: 1 };
    if (c.includes('GULLI')) return { id: 'hyb_jeu_gulli', name: 'Gulli', categories: ['jeunesse', 'tnt'], index: 5 };

    if (c.includes('BEIN')) {
        let isMax = c.includes('MAX'); let m = c.match(/BEIN(?:SPORT|MAX)?S?(\d+)/); let num = (m && m[1]) ? m[1] : '1';
        return { id: 'hyb_sport_bein_' + (isMax?'max':'') + num, name: isMax ? 'beIN SPORTS MAX '+num : 'beIN SPORTS '+num, categories: ['sports'], index: isMax ? 40 + parseInt(num, 10) : 30 + parseInt(num, 10) };
    }

    // Fallback catégorisation par mots-clés
    let cat = 'autres';
    let idx = 300;
    if (c.includes('SPORT') || c.includes('FOOT') || c.includes('GOLF') || c.includes('RUGBY')) cat = 'sports';
    else if (c.includes('CINE') || c.includes('FILM') || c.includes('SERIE') || c.includes('ACTION')) cat = 'cinema';
    else if (c.includes('INFO') || c.includes('NEWS')) cat = 'info';
    else if (c.includes('DOC') || c.includes('PLANET') || c.includes('ANIMAUX') || c.includes('NATIONAL')) cat = 'decouverte';
    else if (c.includes('KIDS') || c.includes('JUNIOR') || c.includes('TOON') || c.includes('DISNEY') || c.includes('NICKELODEON')) cat = 'jeunesse';
    else if (c.includes('MUSIC') || c.includes('HIT') || c.includes('MTV')) cat = 'musique';

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
                    if (currentName && isValidHttpUrl(line)) {
                        let metaId = Buffer.from(line).toString('base64');
                        metas.push({ id: metaId, name: currentName, poster: currentLogo, _isDirectStream: true, _directUrl: line });
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
                    if (isValidHttpUrl(url)) {
                        requests.push(axios.get(url, { timeout: 6000 }).catch(e => null));
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
    } catch (err) {}

    return metas;
}

// --- SYNC ORCHESTRATOR ---
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

// --- BACKGROUND STREAM WARMER (RÉSOLUTION ASYNCHRONE) ---
async function backgroundStreamWarmer() {
    for (const [key, cacheObj] of Object.entries(channelsCache)) {
        if (!cacheObj.data) continue;
        for (const channel of cacheObj.data) {
            let streams = [];
            for (const source of channel.sources) {
                if (source.type === 'm3u' && source.directUrl) {
                    streams.push({ url: source.directUrl, name: '▶ Direct HD', title: source.originalName || 'Flux M3U' });
                } else if (source.type === 'addon') {
                    try {
                        let targetUrl = `${source.providerBase}/stream/tv/${encodeURIComponent(source.metaId)}.json`;
                        if (!isValidHttpUrl(targetUrl)) continue;
                        const r = await axios.get(targetUrl, { timeout: 3000 });
                        if (r.data && r.data.streams) {
                            streams.push(...r.data.streams);
                        }
                    } catch (e) {}
                }
            }
            if (streams.length > 0) {
                backgroundStreamCache.set(channel.id, streams);
            }
        }
    }
}
setInterval(backgroundStreamWarmer, 10 * 60 * 1000);

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
    if (!latestCache || !latestCache.data) return res.json({ error: "Cache vide. Ouvrez d'abord l'add-on dans Stremio." });

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
                <p class="subtitle">L'agrégateur IPTV universel et optimisé (v1.0.5)</p>
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
                    <p class="subtitle" style="margin-bottom: 10px; font-size: 12px;">Ajustez l'ordre. Le format placé en haut sera lancé en priorité.</p>
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
                    <div class="metric-card"><div class="metric-label">Uptime</div><div class="metric-value" id="m-uptime">--</div></div>
                    <div class="metric-card"><div class="metric-label">Utilisateurs Actifs (5m)</div><div class="metric-value" id="m-users">--</div></div>
                    <div class="metric-card"><div class="metric-label">Requêtes Totales</div><div class="metric-value" id="m-req">--</div></div>
                    <div class="metric-card"><div class="metric-label">Performance Cache</div><div class="metric-value" id="m-cache">--</div></div>
                </div>

                <div class="section">
                    <h3 class="section-title">Inventaire des Bases</h3>
                    <ul class="report-list" style="margin-bottom: 15px;">
                        <li><span>Chaînes Uniques validées</span> <b id="m-channels" class="status-ok">--</b></li>
                        <li><span>Guide TV synchronisé</span> <b id="m-epg" class="status-ok">--</b></li>
                    </ul>
                    <h3 class="section-title">Rapport des Sources</h3>
                    <ul class="report-list" id="sourceReportList"><li><i>Chargement...</i></li></ul>
                </div>
                
                <div class="section">
                    <h3 class="section-title">Top 5 Chaînes (Session)</h3>
                    <ul class="report-list" id="topChannelsList"><li><i>Aucune donnée</i></li></ul>
                </div>
            </div>

            <div id="debug" class="tab-content">
                <div class="section">
                    <h3 class="section-title">🔍 Inspecteur & Testeur de Flux</h3>
                    <p class="subtitle" style="margin-bottom: 10px; font-size: 12px;">Tapez une chaîne (ex: "ligue", "bein", "tf1") pour tester la santé des liens en direct.</p>
                    <div style="display: flex; gap: 8px; margin-bottom: 15px;">
                        <input type="text" id="debugQuery" placeholder="Nom de la chaîne..." style="flex: 1; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px; font-size: 13px;">
                        <button type="button" onclick="runDebug()" class="btn-small" style="padding: 10px 15px; font-weight: bold;">Tester les flux</button>
                    </div>
                    <pre id="debugOutput" style="background: #111; padding: 12px; border-radius: 6px; font-size: 11px; color: #00ffcc; max-height: 400px; overflow-y: auto; text-align: left; white-space: pre-wrap; word-break: break-all;">En attente de test...</pre>
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
                if(!q) return alert("Veuillez entrer un nom de chaîne !");
                document.getElementById('debugOutput').innerText = "Test des liens et des serveurs en cours...";
                try {
                    let res = await fetch('/api/debug/inspect/' + encodeURIComponent(q));
                    let data = await res.json();
                    document.getElementById('debugOutput').innerText = JSON.stringify(data, null, 2);
                } catch(e) {
                    document.getElementById('debugOutput').innerText = "Erreur de requête : " + e.message;
                }
            }

            function renderSources() {
                const container = document.getElementById('sourcesContainer');
                if (!container) return;
                container.innerHTML = '';
                sources.forEach((src, index) => {
                    if (index >= 5) return;
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

            function addSourceField() { if (sources.length < 5) { saveInputs(); sources.push(''); renderSources(); } }
            function removeSource(index) { saveInputs(); sources.splice(index, 1); renderSources(); }
            
            function saveInputs() {
                sources.forEach((_, index) => { const el = document.getElementById('src_' + index); if (el) sources[index] = el.value.trim(); });
                localStorage.setItem('hybrid_sources', JSON.stringify(sources));
                updateExportToken();
            }

            function updateExportToken() {
                const validSources = sources.filter(s => s.length > 0);
                const configObj = { sources: validSources, qualities: qualities }; 
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
                        renderSources(); renderQualities(); alert("Configuration importée avec succès !");
                    } else alert("Code invalide.");
                } catch(e) { alert("Erreur : Ce code est corrompu."); }
            }

            function generateLink() {
                saveInputs();
                const validSources = sources.filter(s => s.length > 0);
                if (validSources.length === 0) return alert("Veuillez entrer au moins un lien de source !");
                const token = document.getElementById('exportTokenBox').value;
                const linkField = document.getElementById("manifestLink");
                if (linkField) linkField.value = window.location.protocol + "//" + window.location.host + "/" + token + "/manifest.json";
                alert("Lien généré. Veuillez désinstaller l'ancienne version dans Stremio/NuVio avant d'ajouter celle-ci !");
            }

            function copyLink() {
                var copyText = document.getElementById("manifestLink");
                if (!copyText || !copyText.value) return alert("Générez le lien d'abord !");
                copyText.select(); document.execCommand("copy"); alert("Copié !");
            }

            async function fetchMetrics() {
                try {
                    let res = await fetch('/api/metrics');
                    let data = await res.json();
                    
                    document.getElementById('m-uptime').innerText = data.uptime;
                    document.getElementById('m-users').innerText = data.activeUsers;
                    document.getElementById('m-req').innerText = data.totalRequests;
                    document.getElementById('m-cache').innerText = data.cacheRate;
                    document.getElementById('m-channels').innerText = data.totalChannels;
                    document.getElementById('m-epg').innerText = data.epgCount;
                    
                    let htmlList = '';
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
                    document.getElementById('sourceReportList').innerHTML = htmlList || '<li><i>Aucune source configurée</i></li>';

                    let topHtml = '';
                    data.topChannels.forEach(c => {
                        topHtml += \`<li><span>\${c.id.replace(/_/g, ' ').toUpperCase()}</span> <b>\${c.count} vues</b></li>\`;
                    });
                    document.getElementById('topChannelsList').innerHTML = topHtml || '<li><i>Aucune donnée</i></li>';
                } catch(e) {}
            }

            let savedSources = localStorage.getItem('hybrid_sources');
            if (savedSources && !${sourcesParam ? 'true' : 'false'}) sources = JSON.parse(savedSources);
            
            let savedQualities = localStorage.getItem('hybrid_qualities');
            if (savedQualities) { try { qualities = JSON.parse(savedQualities); } catch(e){} }

            renderSources();
            renderQualities();
            setInterval(() => { if(document.getElementById('metrics').classList.contains('active')) fetchMetrics(); }, 5000);
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
        version: '1.0.5',
        name: 'HybridTV',
        description: 'Meta-Addon IPTV Universel (v1.0.5)',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            { type: 'tv', id: 'tnt', name: '📺 TNT' },
            { type: 'tv', id: 'info', name: '📰 Information' },
            { type: 'tv', id: 'jeunesse', name: '👶 Jeunesse' },
            { type: 'tv', id: 'decouverte', name: '🔬 Découverte' },
            { type: 'tv', id: 'cinema', name: '🍿 Cinéma' },
            { type: 'tv', id: 'musique', name: '🎵 Musique' },
            { type: 'tv', id: 'canal', name: '🎟️ Bouquet Canal' },
            { type: 'tv', id: 'sports', name: '⚽ Sports' },
            { type: 'tv', id: 'events', name: '🔴 Événements' },
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

// --- ROUTE STREAM ULTRA-RAPIDE (UTILISE LE CACHE ASYNCHRONE) ---
app.get('/:config/stream/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ streams: [] });

    serverStats.channelClicks[req.params.id] = (serverStats.channelClicks[req.params.id] || 0) + 1;
    res.setHeader('Cache-Control', 'max-age=60, public');

    let streams = backgroundStreamCache.get(req.params.id);
    if (!streams || streams.length === 0) {
        let channelsData = await getChannelsForSources(config.sources);
        const channel = channelsData.find(c => c.id === req.params.id);
        if (channel) {
            streams = [];
            for (const source of channel.sources) {
                if (source.type === 'm3u' && source.directUrl) {
                    streams.push({ url: source.directUrl, name: '▶ Direct HD', title: source.originalName || 'Flux M3U' });
                } else if (source.type === 'addon') {
                    try {
                        let targetUrl = `${source.providerBase}/stream/tv/${encodeURIComponent(source.metaId)}.json`;
                        if (isValidHttpUrl(targetUrl)) {
                            const r = await axios.get(targetUrl, { timeout: 3000 });
                            if (r.data && r.data.streams) streams.push(...r.data.streams);
                        }
                    } catch (e) {}
                }
            }
        }
    }

    res.json({ streams: streams || [] });
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`[INFO] HybridTV v1.0.5 running on port ${PORT}`);
    updateEPG();
    setInterval(updateEPG, 3600000);
    setTimeout(backgroundStreamWarmer, 3000);
});
