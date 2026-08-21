const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Variables globales
let isUpdatingChannels = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let apiTestStatus = "⏳ Test de l'API EPG en cours...";

const ADDON_PROVIDERS = [
    { id: 'vavoo', base: 'https://tvvoo.hayd.uk/cfg-fr', label: 'Vavoo', isPriority: true },
    { id: 'mio', base: 'https://tvmio.ooguy.com/eyJjb3VudHJpZXMiOlsiRlIiLCJCRV9GUiJdLCJjYXRlZ29yaWVzIjp7IkZSIjpbIkdlbmVyYWwg8J+7oiIsIlNwb3J0cyDimq3igIsiLCJEb2N1bWVudGFpcmVzIPCfijrQuiIsIkZpbG1zIPCfjqwiLCJJbmZvcm1hdGlvbnMg8J+7oiIsIkVuZmFudHMgv5G2IiwiTXVzaWMg8J+OtSJdfSwiZW5hYmxlU2VhcmNoIjpmYWxzZX0', label: 'Mio', isPriority: false }
];

let channelsData = []; 
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

// === NORMALISATION ===
function normalizeChannelName(rawName) {
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/\s*\([Tt][Vv]\)\s*/g, '');
    n = n.replace(/DURING EVENT ONLY/g, '');
    n = n.replace(/EVENT ONLY/g, '');
    n = n.replace(/^(FR|BE|CH|CA|VIP)\s*[:|/-]+\s*/, '');
    n = n.replace(/^FR\s+/, '');
    
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'VAVOO', 'DIRECT', 'RAW', 'ACCESS'];
    n = n.replace(/[^A-Z0-9+ ]/g, ' '); 
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'g'), ' '); });
    n = n.replace(/\s+/g, ' ').trim();

    if (n === 'BFM' || n === 'BFM TV') return 'BFMTV';
    if (n === 'C NEWS') return 'CNEWS';
    if (n === 'FRANCEINFO') return 'FRANCE INFO';
    if (n === 'LA CHAINE METEO' || n === 'METEO') return 'LA CHAINE METEO';
    if (n === 'LCN') return 'LCN';
    if (n === '20 MINUTES') return '20 MINUTES TV';
    if (n === 'SCI FI') return 'SYFY';
    if (n === 'L EQUIPE' || n === 'LA CHAINE L EQUIPE') return 'L EQUIPE';
    if (n.includes('WILD') && (n.includes('NAT') || n.includes('GEO'))) return 'NATIONAL GEOGRAPHIC WILD';
    if (n.includes('NAT GEO') || n.includes('NATIONAL GEO')) return 'NATIONAL GEOGRAPHIC';
    if (n.includes('CHASSE') && n.includes('PECHE')) return 'CHASSE ET PECHE';

    if (n.includes('DISCOVERY')) {
        if (n.includes('SCIENCE') || n.includes('SCI FI')) return 'DISCOVERY SCIENCE';
        if (n.includes('INVESTIGATION') || n.includes('ID')) return 'DISCOVERY INVESTIGATION';
        return 'DISCOVERY CHANNEL';
    }

    if (n.includes('PLANETE') && n.includes('CRIME')) return 'PLANETE+ CRIME';
    if (n.includes('PLANETE') && n.includes('AVENTURE')) return 'PLANETE+ AVENTURE';
    if (n.includes('PLANETE')) return 'PLANETE+';

    let beinMatch = n.match(/BEIN SPORTS?\s*(MAX)?\s*(\d+)/);
    if (beinMatch) return beinMatch[1] ? `BEIN SPORTS MAX ${beinMatch[2]}` : `BEIN SPORTS ${beinMatch[2]}`;
    if (n.includes('BEIN SPORT')) return 'BEIN SPORTS 1';

    if (n === 'CANAL PLUS' || n === 'CANAL') return 'CANAL+';
    if (n === 'CANAL PLUS FOOT' || n === 'FOOT+') return 'CANAL+ FOOT';
    if (n === 'CANAL PLUS SPORT') return 'CANAL+ SPORT';
    if (n.includes('SPORT 360') || n.includes('CANAL+ 360')) return 'CANAL+ SPORT 360';
    if (n === 'CANAL PLUS CINEMA') return 'CANAL+ CINEMA';
    if (n === 'CANAL PLUS GRAND ECRAN') return 'CANAL+ GRAND ECRAN';
    if (n === 'CANAL PLUS SERIES') return 'CANAL+ SERIES';
    if (n === 'CANAL PLUS DOCS') return 'CANAL+ DOCS';
    if (n === 'CANAL PLUS FAMILY') return 'CANAL+ FAMILY';
    if (n === 'CANAL PLUS KIDS' || n === 'CANAL KIDS') return 'CANAL+ KIDS';
    if (n === 'CANAL PLUS DECALE') return 'CANAL+ DECALE';
    if (n === 'CANAL PLUS BOX OFFICE') return 'CANAL+ BOX OFFICE';
    if (n.includes('CANAL') && (n.includes('ULTRA') || n.includes('4K'))) return 'CANAL+ 4K';

    if (n === 'DISNEY CHANNEL 1' || n === 'DISNEY 1') return 'DISNEY CHANNEL +1';
    if (n === 'DISNEY JR') return 'DISNEY JUNIOR';
    if (n === 'J ONE' || n === 'G1') return 'GAME ONE';

    return n;
}

function getPrettyName(n) {
    if (n === 'L EQUIPE') return "L'Équipe";
    if (n === 'CHASSE ET PECHE') return "Chasse et Pêche";
    if (n === 'NATIONAL GEOGRAPHIC WILD') return "National Geographic Wild";
    if (n === 'PLANETE+ CRIME') return "Planète+ Crime";
    if (n === 'PLANETE+ AVENTURE') return "Planète+ Aventure";
    if (n === 'TF1' || n === 'M6' || n === 'W9' || n === 'C8' || n === 'TFX' || n === 'TMC' || n === 'LCI' || n === 'BFMTV' || n === 'LCN') return n;
    if (n === 'CNEWS') return 'CNews';
    if (n === 'GULLI') return 'Gulli';
    if (n === 'ARTE') return 'Arte';
    if (n.startsWith('CANAL+')) return n.replace('CANAL+', 'Canal+').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase()).replace('Canal+ ', 'Canal+ ');
    return n.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
}

function getChannelPlacements(n) {
    let placements = [];

    if (['FRANCE INFO', 'LA CHAINE METEO', 'CNEWS', 'LCI', 'BFMTV', 'FRANCE 24', 'EURONEWS', 'LCN', '20 MINUTES TV'].includes(n) || n.startsWith('BFM ')) {
        let idx = 50;
        if(n === 'FRANCE INFO') idx = 1; else if(n === 'LA CHAINE METEO') idx = 2; else if(n === 'CNEWS') idx = 3; else if(n === 'LCI') idx = 4; else if(n === 'BFMTV') idx = 5; else if(n === 'FRANCE 24') idx = 6; else if(n === 'EURONEWS') idx = 7; else if(n.startsWith('BFM ')) idx = 20; 
        placements.push({ category: 'vavoo_info', index: idx });
    }

    let jeuIdx = -1;
    if (n === 'CARTOON NETWORK') jeuIdx = 1; else if (n === 'DISNEY CHANNEL') jeuIdx = 2; else if (n === 'GULLI') jeuIdx = 3; else if (n === 'NICKELODEON') jeuIdx = 4; else if (n === 'GAME ONE') jeuIdx = 5; else if (n === 'DISNEY XD') jeuIdx = 6; else if (n === 'BOOMERANG') jeuIdx = 7; else if (n === 'CANAL+ KIDS') jeuIdx = 8; else if (n === 'CANAL J') jeuIdx = 9; else if (n === 'DISNEY JUNIOR') jeuIdx = 10; else if (n === 'NICKELODEON TEEN') jeuIdx = 11; else if (n === 'NICKELODEON JUNIOR') jeuIdx = 12; else if (n === 'NICKTOONS') jeuIdx = 13; else if (n === 'DISNEY CHANNEL +1') jeuIdx = 50; else if (n.includes('NICKELODEON') && (n.includes('+') || n.includes('14') || n.includes('1'))) jeuIdx = 51;
    if (jeuIdx !== -1) placements.push({ category: 'vavoo_jeunesse', index: jeuIdx });
    else if (['DISNEY', 'CARTOON', 'BOOMERANG', 'NICKELODEON', 'TIJI', 'TELETOON', 'PIWI', 'MANGAS', 'TOONAMI'].some(k => n.includes(k))) placements.push({ category: 'vavoo_jeunesse', index: 30 });

    let canIdx = -1;
    if(n==='CANAL+') canIdx=1; else if(n==='CANAL+ FOOT') canIdx=2; else if(n==='CANAL+ SPORT') canIdx=3; else if(n==='CANAL+ SPORT 360') canIdx=4; else if(n==='CANAL+ FORMULA 1') canIdx=5; else if(n==='CANAL+ CINEMA') canIdx=6; else if(n==='CANAL+ GRAND ECRAN') canIdx=7; else if(n==='CANAL+ BOX OFFICE') canIdx=8; else if(n==='CANAL+ SERIES') canIdx=9; else if(n==='CANAL+ FAMILY') canIdx=10; else if(n==='CANAL+ DOCS') canIdx=11; else if(n==='CANAL J') canIdx=12; else if(n==='CANAL+ KIDS') canIdx=13; else if(n==='CANAL+ 4K') canIdx=14; else if(n==='CANAL+ DECALE') canIdx=16; else if(n.includes('CSTAR HITS')) canIdx=17;
    if(canIdx !== -1) placements.push({ category: 'vavoo_canal', index: canIdx });
    else if (n.startsWith('CANAL') && !n.includes('PLAY')) placements.push({ category: 'vavoo_canal', index: 30 });

    if (['DISCOVERY', 'PLANETE', 'NATIONAL GEOGRAPHIC', 'USHUAIA', 'HISTOIRE', 'ANIMAUX', 'CHASSE', 'SCIENCE', 'TREK', 'SEASONS', 'MYZEN', 'CRIME DISTRICT', 'STAR CHANNEL'].some(k => n.includes(k))) {
        let decIndex = 10;
        if(n === 'DISCOVERY CHANNEL') decIndex = 1; else if(n.includes('PLANETE')) decIndex = 2; else if(n.includes('NATIONAL GEOGRAPHIC')) decIndex = 3;
        placements.push({ category: 'vavoo_decouverte', index: decIndex });
    }

    if (['PARAMOUNT', 'WARNER', 'ACTION', 'TCM', 'CINE+', 'OCS', 'SYFY', 'SCI FI', 'SERIE CLUB', 'TV BREIZH', 'COMEDY CENTRAL', 'POLAR+'].some(k => n.includes(k))) placements.push({ category: 'vavoo_cinema', index: 10 });

    if (['TRACE', 'M6 MUSIC', 'MTV', 'NRJ HITS', 'MCM', 'MEZZO', 'MELODY', 'CLUBBING TV', 'CSTAR HITS'].some(k => n.includes(k)) && n !== 'BFMTV') {
        let musIndex = 10;
        if(n.includes('M6 MUSIC')) musIndex = 1; else if(n.includes('NRJ HITS')) musIndex = 2; else if(n.includes('MTV')) musIndex = 3; else if(n.includes('TRACE')) musIndex = 4; else if(n.includes('MCM')) musIndex = 5; else if(n.includes('MEZZO') || n.includes('MELODY')) musIndex = 20; 
        placements.push({ category: 'vavoo_musique', index: musIndex });
    }

    if (n === 'CANAL+ SPORT' || n === 'CANAL+ FOOT' || n === 'CANAL+ SPORT 360' || n === 'CANAL+ FORMULA 1') placements.push({ category: 'vavoo_sports', index: 250 });
    if (n.startsWith('BEIN SPORTS') || n.includes('BING SPORT')) {
        let match = n.match(/\d+/); let beinIdx = match ? parseInt(match[0]) : 0; if (n.includes('MAX')) beinIdx += 10; 
        placements.push({ category: 'vavoo_sports', index: 100 + beinIdx });
    }
    else if (n.startsWith('RMC SPORT') && !n.includes('MULTICANAL')) placements.push({ category: 'vavoo_sports', index: 120 });
    else if (n.startsWith('EUROSPORT')) placements.push({ category: 'vavoo_sports', index: 130 });
    else if (n.startsWith('DAZN')) placements.push({ category: 'vavoo_sports', index: 140 });
    else if (['AUTOMOTO', 'GOLF', 'EQUIDIA', 'OLTV', 'INFOSPORT'].some(k => n.includes(k))) placements.push({ category: 'vavoo_sports', index: 150 });
    else if (n === 'L EQUIPE') placements.push({ category: 'vavoo_sports', index: 160 });
    else if (n.includes('SPORT') && !n.includes('CANAL')) placements.push({ category: 'vavoo_sports', index: 199 });

    const tntList = ['TF1', 'FRANCE 2', 'FRANCE 3', 'FRANCE 4', 'FRANCE 5', 'M6', 'ARTE', 'C8', 'W9', 'TMC', 'TFX', 'NRJ 12', 'LCP', 'PUBLIC SENAT', 'CSTAR', 'GULLI', 'TF1 SERIES', 'L EQUIPE', '6TER', 'RMC STORY', 'RMC DECOUVERTE', 'CHERIE 25'];
    if (tntList.includes(n)) placements.push({ category: 'vavoo_tnt', index: tntList.indexOf(n) + 1 });

    if (placements.length === 0) placements.push({ category: 'vavoo_autres', index: 500 });
    return placements;
}

// === API EPG "À LA DEMANDE" ===
const CHANNEL_API_MAP = {
    "TF1": "c200", "FRANCE 2": "c202", "FRANCE 3": "c204", "CANAL+": "c47",
    "FRANCE 5": "c207", "M6": "c208", "ARTE": "c138", "C8": "c553", "W9": "c211",
    "TMC": "c212", "TFX": "c213", "NRJ 12": "c214", "LCP": "c215",
    "FRANCE 4": "c206", "BFMTV": "c217", "CNEWS": "c568", "CSTAR": "c10100",
    "GULLI": "c220", "TF1 SERIES": "c2466", "L EQUIPE": "c1979", "6TER": "c2464",
    "RMC STORY": "c2465", "RMC DECOUVERTE": "c2463", "CHERIE 25": "c2462",
    "LCI": "c244", "FRANCEINFO": "c6206", "PARIS PREMIERE": "c225",
    "RTL 9": "c130", "TEVA": "c129", "COMEDY CENTRAL": "c6265",
    "CANAL+ CINEMA": "c49", "CANAL+ SPORT": "c50", "CANAL+ SERIES": "c3315",
    "CANAL+ GRAND ECRAN": "c10813", "CANAL+ DOCS": "c10812", "CANAL+ KIDS": "c10814",
    "BEIN SPORTS 1": "c2378", "BEIN SPORTS 2": "c2384", "BEIN SPORTS 3": "c4587",
    "EUROSPORT 1": "c119", "EUROSPORT 2": "c242", "AUTOMOTO": "c126",
    "NATIONAL GEOGRAPHIC": "c100", "NATIONAL GEOGRAPHIC WILD": "c869",
    "USHUAIA": "c121", "HISTOIRE": "c110", "TOUTE L HISTOIRE": "c120",
    "ANIMAUX": "c124", "CHASSE ET PECHE": "c113", "DISCOVERY CHANNEL": "c867",
    "PLANETE+": "c92", "PLANETE+ AVENTURE": "c94", "PLANETE+ CRIME": "c247",
    "DISNEY CHANNEL": "c131", "CARTOON NETWORK": "c136", "NICKELODEON": "c249",
    "TIJI": "c134", "TELETOON": "c132", "PIWI": "c133", "BOOMERANG": "c135",
    "MANGAS": "c137", "GAME ONE": "c141", "J ONE": "c3534",
    "MTV": "c153", "NRJ HITS": "c656", "M6 MUSIC": "c156", "TRACE": "c243",
    "POLAR+": "c6114", "SERIE CLUB": "c128", "TV BREIZH": "c152", "SYFY": "c248",
    "ACTION": "c101", "TCM": "c102", "PARAMOUNT": "c3546"
};

let liveEpgCache = {};

async function fetchLiveEpgForChannel(channelName) {
    const apiCode = CHANNEL_API_MAP[channelName];
    if (!apiCode) return null;

    const cachedData = liveEpgCache[channelName];
    if (cachedData && cachedData.expiresAt > Date.now()) {
        return cachedData.description;
    }

    try {
        const url = `https://api.programme-tv.net/tv/epg/v1/grid/channels/${apiCode}/now`;
        const res = await axios.get(url, {
            timeout: 5000,
            headers: { 'User-Agent': 'ProgrammeTV/3.0.0 (Android)' }
        });

        if (res.data && res.data.programs && res.data.programs.length > 0) {
            const prog = res.data.programs[0];
            let title = prog.title || 'Programme Inconnu';
            if (prog.subtitle) title += ` - ${prog.subtitle}`;
            
            const sTime = new Date(prog.start).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
            const eTime = new Date(prog.end).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
            
            let descText = `🔴 EN DIRECT (${sTime} - ${eTime}) : ${title}`;
            if (prog.synopsis) descText += `\n\n${prog.synopsis}`;

            liveEpgCache[channelName] = {
                description: descText,
                expiresAt: Date.now() + (30 * 60 * 1000)
            };

            return descText;
        }
    } catch (err) {
        // En cas de blocage de l'API (DataDome) on passe par le proxy allorigins
        try {
            const urlProxy = `https://api.allorigins.win/get?url=` + encodeURIComponent(`https://api.programme-tv.net/tv/epg/v1/grid/channels/${apiCode}/now`);
            const resProxy = await axios.get(urlProxy, { timeout: 6000 });
            if (resProxy.data && resProxy.data.contents) {
                const data = JSON.parse(resProxy.data.contents);
                if (data.programs && data.programs.length > 0) {
                    const prog = data.programs[0];
                    let title = prog.title || 'Programme';
                    const sTime = new Date(prog.start).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
                    const eTime = new Date(prog.end).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
                    let descText = `🔴 EN DIRECT (${sTime} - ${eTime}) : ${title}`;
                    if (prog.synopsis) descText += `\n\n${prog.synopsis}`;
                    
                    liveEpgCache[channelName] = { description: descText, expiresAt: Date.now() + (30 * 60 * 1000) };
                    return descText;
                }
            }
        } catch(proxyErr) {
            console.error(`Double échec EPG pour ${channelName}`);
        }
    }
    return null;
}

async function testEpgApi() {
    try {
        const test = await fetchLiveEpgForChannel("TF1");
        if (test && test.includes("EN DIRECT")) {
            apiTestStatus = "✅ L'API 'À la demande' répond parfaitement.";
        } else {
            apiTestStatus = "⚠️ L'API répond mais aucun programme trouvé.";
        }
    } catch(e) {
        apiTestStatus = "❌ L'API est bloquée.";
    }
}

// === LE SAS D'ATTENTE (POUR NE PAS VIDER NUVIO) ===
async function waitForChannels() {
    // Si Nuvio est trop rapide, on le met en attente (maximum 15 secondes)
    let tries = 0;
    while(isUpdatingChannels && tries < 30) {
        await new Promise(resolve => setTimeout(resolve, 500));
        tries++;
    }
}

// === MISE À JOUR DES FLUX ===
async function fetchAddonCatalog(provider) {
    let allMetas = [];
    try {
        const manifestRes = await axios.get(`${provider.base}/manifest.json`, { timeout: 10000 });
        for (const catalog of manifestRes.data.catalogs) {
            let skip = 0; let hasMore = true; let pageCount = 0; let seenIds = new Set(); 
            while (hasMore && pageCount < 15) {
                pageCount++;
                try {
                    let url = skip > 0 ? `${provider.base}/catalog/${catalog.type}/${catalog.id}/skip=${skip}.json` : `${provider.base}/catalog/${catalog.type}/${catalog.id}.json`;
                    let res = await axios.get(url, { timeout: 10000 });
                    if (res.data && res.data.metas && res.data.metas.length > 0) {
                        let newAdded = 0;
                        res.data.metas.forEach(m => {
                            if (!seenIds.has(m.id)) { seenIds.add(m.id); allMetas.push(m); newAdded++; }
                        });
                        if (newAdded === 0) hasMore = false; else skip += res.data.metas.length; 
                    } else { hasMore = false; }
                } catch (e) { hasMore = false; }
            }
        }
    } catch (err) {}
    return allMetas;
}

async function updateStreams() {
    if (isUpdatingChannels) return;
    isUpdatingChannels = true;
    try {
        let tempChannelsMap = {};

        for (const provider of ADDON_PROVIDERS) {
            const metas = await fetchAddonCatalog(provider);
            metas.forEach(meta => {
                let dName = normalizeChannelName(meta.name);
                if (!dName || dName.length < 2) return; 

                const id = 'hyb_id_' + dName.replace(/[^a-zA-Z0-9+]/g, '_').toLowerCase();

                if (!tempChannelsMap[id]) {
                    tempChannelsMap[id] = { id, name: dName, displayName: getPrettyName(dName), sources: [], poster: meta.poster || DEFAULT_POSTER };
                }
                const sourceExists = tempChannelsMap[id].sources.find(s => s.metaId === meta.id && s.provider.id === provider.id);
                if (!sourceExists) tempChannelsMap[id].sources.push({ type: 'addon', metaId: meta.id, provider: provider });
            });
        }

        let tempChannelsData = [];
        Object.values(tempChannelsMap).forEach(ch => {
            if (ch.sources.length > 0) {
                ch.placements = getChannelPlacements(ch.name);
                tempChannelsData.push(ch);
            }
        });

        if (tempChannelsData.length > 0) {
            channelsData = tempChannelsData;
            lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
        }

    } catch (err) {}
    isUpdatingChannels = false; 
}

// === INTERFACE WEB ===
app.get('/', (req, res) => {
    const host = req.get('host');
    const manifestUrl = `https://${host}/manifest.json`;
    const stremioUrl = `stremio://${host}/manifest.json`;
    
    let channelsStatus = isUpdatingChannels 
        ? '⏳ Recherche des chaînes en cours (Nuvio est mis en attente)...' 
        : `✅ <b>${channelsData.length}</b> chaînes actives`;
        
    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Hybrid TV FR</title>
        <style>
            body { font-family: -apple-system, sans-serif; background: #141414; color: #fff; text-align: center; padding: 40px 20px; }
            .container { max-width: 600px; margin: 0 auto; background: #1f1f1f; padding: 40px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-top: 4px solid #e50914; }
            h1 { color: #fff; font-size: 32px; margin-bottom: 10px; }
            p { font-size: 16px; color: #aaa; margin-bottom: 30px; line-height: 1.6; }
            .btn { display: inline-block; background: #e50914; color: #fff; padding: 15px 30px; text-decoration: none; font-size: 16px; font-weight: bold; border-radius: 8px; margin: 10px; cursor: pointer; border: none; transition: 0.2s; }
            .btn:hover { background: #f40612; transform: scale(1.05); }
            .btn-secondary { background: #333; }
            .btn-secondary:hover { background: #444; }
            .stats { margin-top: 30px; font-size: 14px; color: #888; background: #111; padding: 15px; border-radius: 6px; line-height: 1.8; }
            input { width: 100%; padding: 12px; margin-top: 20px; background: #111; color: #fff; border: 1px solid #444; border-radius: 6px; text-align: center; font-size: 14px; box-sizing: border-box; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📺 Hybrid TV FR</h1>
            <p>Votre add-on télévisuel haute-performance.<br>Propulsé par un sas de sécurité pour Nuvio.</p>
            
            <a href="${stremioUrl}" class="btn">▶ Ajouter à Stremio</a>
            <button onclick="copyLink()" class="btn btn-secondary">📋 Copier le lien</button>
            <input type="text" id="manifestLink" value="${manifestUrl}" readonly>
            
            <div class="stats">
                ${channelsStatus}<br><br>
                ${apiTestStatus}<br>
                🕒 Dernière synchronisation des chaînes : ${lastUpdate}
            </div>
        </div>
        <script>
            function copyLink() {
                var copyText = document.getElementById("manifestLink");
                copyText.select(); document.execCommand("copy"); alert("Lien copié avec succès !");
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.get('/manifest.json', (req, res) => {
    res.setHeader('Cache-Control', 'max-age=86400, public'); 
    res.json({
        id: 'org.hybridproxy.fr.live.v58', 
        version: '58.0.0',
        name: 'Hybrid TV FR',
        description: 'L\'expérience IPTV ultime. Sécurisé contre le cache vide.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            { type: 'tv', id: 'vavoo_tnt', name: '📺 TNT' },
            { type: 'tv', id: 'vavoo_info', name: '📰 Information' },
            { type: 'tv', id: 'vavoo_jeunesse', name: '👶 Jeunesse' },
            { type: 'tv', id: 'vavoo_decouverte', name: '🔬 Découverte & Docu' },
            { type: 'tv', id: 'vavoo_cinema', name: '🍿 Cinéma & Séries' },
            { type: 'tv', id: 'vavoo_musique', name: '🎵 Musique' },
            { type: 'tv', id: 'vavoo_canal', name: '🎟️ Bouquet Canal' },
            { type: 'tv', id: 'vavoo_sports', name: '⚽ Sports' },
            { type: 'tv', id: 'vavoo_autres', name: '📂 Autres' }
        ]
    });
});

app.get('/catalog/tv/:id.json', async (req, res) => {
    await waitForChannels(); // LE FAMEUX PÉAGE !
    
    // Si malgré l'attente on a toujours rien, on dit à Nuvio de ne rien mettre en cache !
    if (channelsData.length === 0) {
        res.setHeader('Cache-Control', 'no-cache');
        return res.json({ metas: [] });
    }
    
    res.setHeader('Cache-Control', 'max-age=14400, public'); 
    const requestedCatalog = req.params.id; 
    let skip = 0;
    const validCatalogs = ['vavoo_tnt', 'vavoo_info', 'vavoo_jeunesse', 'vavoo_decouverte', 'vavoo_cinema', 'vavoo_musique', 'vavoo_canal', 'vavoo_sports', 'vavoo_autres'];
    if (!validCatalogs.includes(requestedCatalog)) return res.json({ metas: [] });
    
    const filteredChannels = channelsData
        .filter(ch => ch.placements.some(p => p.category === requestedCatalog))
        .map(ch => {
            const place = ch.placements.find(p => p.category === requestedCatalog);
            return { ...ch, sortIndex: place.index };
        })
        .sort((a, b) => {
            if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
            return a.displayName.localeCompare(b.displayName);
        });

    const paginatedMetas = filteredChannels.slice(skip, skip + 100).map(ch => ({
        id: ch.id, type: 'tv', name: ch.displayName, poster: ch.poster, posterShape: 'square'
    }));
    res.json({ metas: paginatedMetas });
});

app.get('/catalog/tv/:id/:extra', async (req, res) => {
    await waitForChannels();
    if (channelsData.length === 0) {
        res.setHeader('Cache-Control', 'no-cache');
        return res.json({ metas: [] });
    }

    res.setHeader('Cache-Control', 'max-age=14400, public'); 
    const requestedCatalog = req.params.id; 
    let skip = 0;
    if (req.params.extra) {
        const match = req.params.extra.match(/skip=(\d+)/);
        if (match) skip = parseInt(match[1], 10);
    }
    const validCatalogs = ['vavoo_tnt', 'vavoo_info', 'vavoo_jeunesse', 'vavoo_decouverte', 'vavoo_cinema', 'vavoo_musique', 'vavoo_canal', 'vavoo_sports', 'vavoo_autres'];
    if (!validCatalogs.includes(requestedCatalog)) return res.json({ metas: [] });
    
    const filteredChannels = channelsData
        .filter(ch => ch.placements.some(p => p.category === requestedCatalog))
        .map(ch => {
            const place = ch.placements.find(p => p.category === requestedCatalog);
            return { ...ch, sortIndex: place.index };
        })
        .sort((a, b) => {
            if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
            return a.displayName.localeCompare(b.displayName);
        });

    const paginatedMetas = filteredChannels.slice(skip, skip + 100).map(ch => ({
        id: ch.id, type: 'tv', name: ch.displayName, poster: ch.poster, posterShape: 'square'
    }));
    res.json({ metas: paginatedMetas });
});

app.get('/meta/tv/:id.json', async (req, res) => {
    await waitForChannels();
    res.setHeader('Cache-Control', 'max-age=60, public'); 
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });
    
    let descriptionText = `▶ Diffusion en cours sur ${channel.displayName}...`;
    
    const liveEpg = await fetchLiveEpgForChannel(channel.name);
    if (liveEpg) {
        descriptionText = liveEpg;
    }

    res.json({
        meta: { id: channel.id, type: 'tv', name: channel.displayName, poster: channel.poster, posterShape: 'square', description: descriptionText }
    });
});

function getStreamScore(title) {
    const t = (title || '').toUpperCase();
    if (t.includes('4K') || t.includes('2160') || t.includes('UHD')) return 4;
    if (t.includes('FHD') || t.includes('1080')) return 3;
    if (t.includes('HD') || t.includes('720')) return 2;
    if (t.includes('SD')) return 0;
    return 1;
}

app.get('/stream/tv/:id.json', async (req, res) => {
    await waitForChannels();
    res.setHeader('Cache-Control', 'max-age=1800, public'); 
    const rawIp = req.headers['x-forwarded-for'];
    const clientIp = rawIp ? rawIp.split(',')[0].trim() : req.socket.remoteAddress;

    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });
    
    try {
        let allStreams = [];
        for (const source of channel.sources) {
            if (source.type === 'addon') {
                try {
                    const streamRes = await axios.get(`${source.provider.base}/stream/tv/${source.metaId}.json`, {
                        headers: { 'X-Forwarded-For': clientIp }, timeout: 10000 
                    });
                    if (streamRes.data && streamRes.data.streams) {
                        const mappedStreams = streamRes.data.streams.map(s => {
                            let qual = "Qualité Standard (SD)";
                            let up = (s.title || '').toUpperCase();
                            if (up.includes('4K') || up.includes('2160') || up.includes('UHD')) qual = "Ultra Haute Qualité (4K)";
                            else if (up.includes('FHD') || up.includes('1080') || up.includes('HD') || up.includes('720')) qual = "Haute Qualité (HD/FHD)";
                            return { ...s, _qualText: qual, _label: source.provider.label, _isPriority: source.provider.isPriority };
                        });
                        allStreams = allStreams.concat(mappedStreams);
                    }
                } catch (err) {}
            }
        }
        
        allStreams.sort((a, b) => {
            if (a._label === 'Vavoo' && b._label === 'Mio') return -1; 
            if (a._label === 'Mio' && b._label === 'Vavoo') return 1;
            return b._score - a._score;
        });

        const finalStreams = allStreams.map((s, idx) => ({
            url: s.url, name: `▶ Source ${idx + 1}\n(${s._label})`, title: s._qualText
        }));
        
        res.json({ streams: finalStreams });
    } catch (err) { res.json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
    
    // On met à jour les chaînes immédiatement
    updateStreams().then(() => {
        // Une fois les chaînes chargées, on teste discrètement l'API EPG en arrière-plan
        testEpgApi();
    });
    
    setInterval(updateStreams, 14400000); 
});
