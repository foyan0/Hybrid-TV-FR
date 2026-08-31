/**
 * HybridTV
 * Version: 1.0.4 (Correction Sémantique Canal+ / Canal J & Background Stream Warmer)
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');

const app = express();
app.use(cors());

// --- STATE & CACHING ---
let isUpdatingEPG = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let epgData = {}; 
let channelsCache = {}; 
let streamCache = new Map();
let backgroundStreamCache = new Map(); // Cache proactif asynchrone
let streamHealthCache = new Map();

const serverStats = {
    startTime: Date.now(),
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    channelClicks: {},
    activeIps: new Map()
};

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

// --- ROUTAGE SÉMANTIQUE CORRIGÉ & ROBUSTE ---
function getChannelData(rawName) {
    if (!rawName) return null;
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
    n = n.replace(/^(?:FR|BE|CH|CA|VIP|VAVOO)\s*[:|/-]+\s*/i, '');
    
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'DIRECT', 'RAW'];
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'gi'), ''); });

    n = n.replace(/\+/g, 'PLUS');
    let c = n.replace(/[^A-Z0-9]/g, '');
    if (!c || c.length < 2) return null;
    if (BLACKLIST.some(b => c.includes(b))) return null;

    // 1. EXCEPTIONS "CANAL" (Chaînes indépendantes qui contiennent le mot Canal)
    if (c.includes('CANALJ') || c === 'CJ') return { id: 'hyb_jeu_canalj', name: 'Canal J', categories: ['jeunesse'], index: 6 };
    if (c.includes('CANALSAVOIR') || c.includes('SAVOIR')) return { id: 'hyb_dec_savoir', name: 'Canal Savoir', categories: ['decouverte'], index: 40 };
    if (c.includes('CANALALPH') || c.includes('ALPH')) return { id: 'hyb_aut_canalalpha', name: 'Canal Alpha', categories: ['autres'], index: 150 };

    // 2. CHAÎNES SPORTIVES SPÉCIFIQUES CANAL+
    if (c.includes('MOTOGP') || c.includes('MOTO GP')) return { id: 'hyb_sport_motogp', name: 'Canal+ MotoGP', categories: ['sports', 'canal'], index: 92 };
    if (c.includes('FORMULA1') || c.includes('F1')) return { id: 'hyb_sport_f1', name: 'Canal+ Formula 1', categories: ['sports', 'canal'], index: 93 };

    // 3. VRAI BOUQUET CANAL+ PAYANT
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

    // 4. AUTRES GRANDES CHAÎNES (TNT, Sports, Infos, Jeunesse)
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

    // Fallback catégorisation intelligente
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

// --- CATALOG ENGINE UNIVERSEL & ROBUSTE ---
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

// --- BACKGROUND STREAM WARMER (RÉSOLUTION ASYNCHRONE PERMANENTE) ---
// Pré-charge les flux en arrière-plan pour éviter les temps d'attente et échecs de recherche
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
setInterval(backgroundStreamWarmer, 10 * 60 * 1000); // Exécuté toutes les 10 minutes

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

    res.json({
        uptime: `${Math.floor((Date.now() - serverStats.startTime)/3600000)}h`,
        totalRequests: serverStats.totalRequests,
        totalChannels: totalChannels,
        sourceReport: sourceReport
    });
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
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 40px 20px; margin: 0; }
            .container { max-width: 700px; margin: 0 auto; background: var(--card); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden; }
            .header { padding: 30px; text-align: center; border-bottom: 1px solid var(--border); }
            h1 { margin: 0 0 10px 0; font-size: 28px; }
            .subtitle { font-size: 14px; color: var(--text-muted); margin: 0; }
            .tabs { display: flex; border-bottom: 1px solid var(--border); background: #1a1a1a; }
            .tab-btn { flex: 1; padding: 15px; background: none; border: none; color: var(--text-muted); font-size: 15px; font-weight: bold; cursor: pointer; }
            .tab-btn.active { color: var(--text); border-bottom: 3px solid var(--primary); background: var(--card); }
            .tab-content { display: none; padding: 30px; }
            .tab-content.active { display: block; }
            .section { background: var(--card-alt); padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid var(--border); }
            .section-title { font-size: 14px; color: #ccc; font-weight: bold; margin-bottom: 15px; text-transform: uppercase; }
            .source-row { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
            .source-num { font-size: 13px; font-weight: bold; color: var(--primary); min-width: 20px; text-align: center; }
            .source-row input { flex: 1; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px; font-size: 13px; }
            .btn { display: inline-block; background: var(--primary); color: #fff; padding: 12px 24px; font-weight: bold; border-radius: 8px; cursor: pointer; border: none; width: 100%; box-sizing: border-box; text-align: center; }
            .btn-secondary { background: #333; margin-top: 10px; }
            .main-link { width: 100%; padding: 15px; margin-top: 15px; background: #111; color: #fff; border: 1px dashed #666; border-radius: 6px; box-sizing: border-box; }
            ul.report-list { list-style: none; padding: 0; margin: 0; font-size: 13px; }
            ul.report-list li { padding: 8px 0; border-bottom: 1px solid #333; display: flex; justify-content: space-between; }
            .status-ok { color: #4caf50; } .status-warn { color: #ff9800; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>📺 HybridTV Dashboard</h1>
                <p class="subtitle">Agrégateur IPTV Universel (v1.0.4)</p>
            </div>
            <div class="tabs">
                <button class="tab-btn active" onclick="switchTab('config', this)">⚙️ Configurer</button>
                <button class="tab-btn" onclick="switchTab('metrics', this)">📊 Métriques</button>
            </div>
            <div id="config" class="tab-content active">
                <div class="section">
                    <h3 class="section-title">Sources (Add-ons Stremio ou M3U)</h3>
                    <div id="sourcesContainer"></div>
                    <button type="button" onclick="addSourceField()" class="btn btn-secondary" style="padding:8px; font-size:12px;">+ Ajouter une source</button>
                </div>
                <button type="button" onclick="generateLink()" class="btn">⚡ Générer l'Add-on</button>
                <input type="text" id="manifestLink" class="main-link" placeholder="Lien généré ici..." readonly>
                <button type="button" onclick="copyLink()" class="btn btn-secondary">📋 Copier le lien</button>
            </div>
            <div id="metrics" class="tab-content">
                <div class="section">
                    <h3 class="section-title">Rapport des Sources</h3>
                    <ul class="report-list" id="sourceReportList"><li><i>Chargement...</i></li></ul>
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
            }
            function addSourceField() { if (sources.length < 5) { sources.push(''); renderSources(); } }
            function generateLink() {
                sources.forEach((_, index) => { const el = document.getElementById('src_' + index); if (el) sources[index] = el.value.trim(); });
                const valid = sources.filter(s => s.length > 0);
                if (valid.length === 0) return alert("Entrez au moins une source !");
                const token = btoa(JSON.stringify({ sources: valid, qualities: qualities }));
                document.getElementById("manifestLink").value = window.location.protocol + "//" + window.location.host + "/" + token + "/manifest.json";
                alert("Lien généré !");
            }
            function copyLink() { document.getElementById("manifestLink").select(); document.execCommand("copy"); alert("Copié !"); }
            async function fetchMetrics() {
                try {
                    let res = await fetch('/api/metrics');
                    let data = await res.json();
                    let htmlList = '';
                    for(let [k, v] of Object.entries(data.sourceReport)) {
                        let statusClass = v.status === 'ok' ? 'status-ok' : 'status-warn';
                        htmlList += \`<li><span>\${k}</span> <b class="\${statusClass}">\${v.status} (\${v.count})</b></li>\`;
                    }
                    document.getElementById('sourceReportList').innerHTML = htmlList || '<li>Aucune source</li>';
                } catch(e){}
            }
            renderSources();
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
        version: '1.0.4',
        name: 'HybridTV',
        description: 'Meta-Addon IPTV Universel (v1.0.4)',
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

// --- ROUTE STREAM ULTRA-RAPIDE (UTILISE LE CACHE ASYNCHRONE PRÉ-CHARGÉ) ---
app.get('/:config/stream/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ streams: [] });

    serverStats.channelClicks[req.params.id] = (serverStats.channelClicks[req.params.id] || 0) + 1;
    res.setHeader('Cache-Control', 'max-age=60, public');

    // Récupération instantanée depuis le cache de fond (zéro attente réseau synchrone)
    let streams = backgroundStreamCache.get(req.params.id);
    if (!streams || streams.length === 0) {
        // Fallback synchrone léger si le cache n'a pas encore tourné
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
    console.log(`[INFO] HybridTV v1.0.4 running on port ${PORT}`);
    updateEPG();
    setInterval(updateEPG, 3600000);
    setTimeout(backgroundStreamWarmer, 3000); // Lancement initial du pré-chargement des flux
});
