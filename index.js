const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');

const app = express();
app.use(cors());

// Variables globales
let isUpdatingChannels = false;
let isUpdatingEPG = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let lastEpgError = "Téléchargement initial en cours...";

const ADDON_PROVIDERS = [
    { id: 'vavoo', base: 'https://tvvoo.hayd.uk/cfg-fr', label: 'Vavoo', isPriority: true },
    { id: 'mio', base: 'https://tvmio.ooguy.com/eyJjb3VudHJpZXMiOlsiRlIiLCJCRV9GUiJdLCJjYXRlZ29yaWVzIjp7IkZSIjpbIkdlbmVyYWwg8J+7oiIsIlNwb3J0cyDimq3igIsiLCJEb2N1bWVudGFpcmVzIPCfijrQuiIsIkZpbG1zIPCfjqwiLCJJbmZvcm1hdGlvbnMg8J+7oiIsIkVuZmFudHMgv5G2IiwiTXVzaWMg8J+OtSJdfSwiZW5hYmxlU2VhcmNoIjpmYWxzZX0', label: 'Mio', isPriority: false }
];

let channelsData = []; 
let epgData = {}; 
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
    return n.replace(/\s+/g, ' ').trim();
}

function toSyncId(name) {
    if (!name) return '';
    let n = name.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/[^A-Z0-9]/g, ''); 
    if (n.startsWith('TF1')) return 'TF1';
    if (n.startsWith('FRANCE2')) return 'FRANCE2';
    if (n.startsWith('FRANCE3')) return 'FRANCE3';
    if (n.startsWith('FRANCE4')) return 'FRANCE4';
    if (n.startsWith('FRANCE5')) return 'FRANCE5';
    if (n.startsWith('M6')) return 'M6';
    if (n.startsWith('ARTE')) return 'ARTE';
    if (n.startsWith('C8')) return 'C8';
    if (n.startsWith('W9')) return 'W9';
    if (n.startsWith('TMC')) return 'TMC';
    if (n.startsWith('TFX')) return 'TFX';
    if (n.startsWith('NRJ12')) return 'NRJ12';
    if (n.startsWith('LCP')) return 'LCP';
    if (n.includes('BFMTV') || n === 'BFM') return 'BFMTV';
    if (n.includes('CNEWS')) return 'CNEWS';
    if (n.includes('CSTAR')) return 'CSTAR';
    if (n.includes('GULLI')) return 'GULLI';
    if (n.includes('CANAL')) {
        if (n.includes('SPORT360')) return 'CANALSPORT360';
        if (n.includes('SPORT')) return 'CANALSPORT';
        if (n.includes('CINEMA')) return 'CANALCINEMA';
        if (n.includes('SERIES')) return 'CANALSERIES';
        if (n.includes('GRAND') || n.includes('ECRAN')) return 'CANALGRANDECRAN';
        if (n.includes('DOC')) return 'CANALDOCS';
        if (n.includes('KIDS')) return 'CANALKIDS';
        if (n.includes('FOOT')) return 'CANALFOOT';
        if (n.includes('BOXOFFICE')) return 'CANALBOXOFFICE';
        if (n.includes('DECALE')) return 'CANALDECALE';
        return 'CANAL';
    }
    if (n.startsWith('BEINSPORT')) {
        if (n.includes('1')) return 'BEINSPORTS1';
        if (n.includes('2')) return 'BEINSPORTS2';
        if (n.includes('3')) return 'BEINSPORTS3';
    }
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

// === EXTRACTEUR EPG V65 (Stream continu, sans synopsis, 0% RAM) ===
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

// Le parseur magique : Il lit au fur et à mesure sans saturer la mémoire de Render
async function fetchAndParseEPG(url, isGz) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await axios.get(url, {
                responseType: 'stream',
                timeout: 45000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });

            let stream = response.data;
            if (isGz) {
                const unzip = zlib.createGunzip();
                stream = stream.pipe(unzip);
            }

            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

            let localChannels = {}; 
            let localEpg = {};      
            
            let inChannel = false, chanBlock = '';
            let inProgramme = false, progBlock = '';

            rl.on('line', (line) => {
                // On saute les résumés et images, on gagne un temps fou et on évite les bugs Nuvio !
                if (line.includes('<desc') || line.includes('<icon')) return;

                if (line.includes('<channel ')) { inChannel = true; chanBlock = line; }
                else if (inChannel) { chanBlock += '\n' + line; }
                
                if (inChannel && chanBlock.includes('</channel>')) {
                    const idM = chanBlock.match(/id=["']([^"']+)["']/);
                    const nameM = chanBlock.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
                    if (idM && nameM) {
                        localChannels[idM[1]] = toSyncId(normalizeChannelName(nameM[1]));
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
                        const syncKey = localChannels[chanM[1]];
                        if (syncKey) {
                            if (!localEpg[syncKey]) localEpg[syncKey] = [];
                            localEpg[syncKey].push({
                                start: parseXmltvDate(startM[1]),
                                stop: parseXmltvDate(stopM[1]),
                                title: titleM[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim()
                                // Plus de synopsis !
                            });
                        }
                    }
                    inProgramme = false; progBlock = '';
                }
            });

            rl.on('close', () => resolve(localEpg));
            rl.on('error', (err) => reject(err));

            // Sécurité anti-gel
            setTimeout(() => { stream.destroy(); reject(new Error("Timeout du stream")); }, 45000);

        } catch (err) { reject(err); }
    });
}

// L'ESSAIM "Censure-Bypass" : On commence par la Suisse et la Belgique pour esquiver le blocage de TF1/Canal
async function updateEPG() {
    if (isUpdatingEPG) return;
    isUpdatingEPG = true; 
    let tempEpgData = {};
    let successCount = 0;
    
    const sources = [
        { url: 'https://xmltvfr.fr/xmltv/xmltv_suisse.xml', isGz: false },    // Ramène TF1, M6, Canal+ (Diffusés légalement en Suisse)
        { url: 'https://xmltvfr.fr/xmltv/xmltv_belgique.xml', isGz: false },  // Ramène TF1, C8, etc.
        { url: 'https://xmltvfr.fr/xmltv/xmltv_tnt.xml', isGz: false },       // La TNT de base qui marchait pour toi
        { url: 'https://raw.githubusercontent.com/davidmrs/epg/master/guide.xml', isGz: false }, // Giga-base Github
        { url: 'https://xmltvfr.fr/xmltv/xmltv_francophone.xml', isGz: false } // Catch-all massif
    ];

    try {
        for (const source of sources) {
            try {
                const parsedEpg = await fetchAndParseEPG(source.url, source.isGz);
                
                let added = false;
                for (const channelKey in parsedEpg) {
                    if (!tempEpgData[channelKey] && parsedEpg[channelKey].length > 0) {
                        tempEpgData[channelKey] = parsedEpg[channelKey];
                        added = true;
                    }
                }
                if (added) successCount++;
                
                // Si on a plus de 150 chaînes, on a largement de quoi faire, on arrête.
                if (Object.keys(tempEpgData).length > 150) break;
                
            } catch (err) {
                console.log(`[EPG] Source passée: ${source.url.substring(0, 30)}...`);
            }
        }
        
        if (Object.keys(tempEpgData).length > 10) {
            epgData = tempEpgData;
            lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
            lastEpgError = `Succès (Données fusionnées depuis ${successCount} sources)`;
        } else {
            lastEpgError = "Toutes les sources EPG de l'essaim ont échoué.";
        }
        
    } finally {
        isUpdatingEPG = false; 
    }
}

function getEpgForChannel(channelName) {
    if (!epgData || Object.keys(epgData).length === 0) return null;
    const syncKey = toSyncId(channelName);
    return epgData[syncKey] || null;
}

// === SAS D'ATTENTE ===
async function waitForChannels() {
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
        if (tempChannelsData.length > 0) channelsData = tempChannelsData;
    } catch (err) {}
    isUpdatingChannels = false; 
}

// === INTERFACE WEB ===
app.get('/', (req, res) => {
    let channelsStatus = isUpdatingChannels ? '⏳ Recherche des chaînes en cours...' : `✅ <b>${channelsData.length}</b> chaînes actives`;
    let epgStatus = "";
    if (isUpdatingEPG) {
        epgStatus = `⏳ Téléchargement de l'Essaim EPG en cours...`;
    } else {
        const epgCount = Object.keys(epgData).length;
        if (epgCount > 0) {
            epgStatus = `✅ Programme TV chargé pour <b>${epgCount}</b> chaînes (${lastEpgError})`;
        } else {
            epgStatus = `❌ Échec du téléchargement.<br><span style="color:#ff6b6b; font-size:12px;">Détails : ${lastEpgError}</span>`;
        }
    }
    
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
            .options { background: #111; padding: 15px; border-radius: 8px; margin-bottom: 25px; border: 1px solid #333; }
            .btn { display: inline-block; background: #e50914; color: #fff; padding: 15px 30px; text-decoration: none; font-size: 16px; font-weight: bold; border-radius: 8px; margin: 10px; cursor: pointer; border: none; transition: 0.2s; }
            .btn:hover { background: #f40612; transform: scale(1.05); }
            .btn-secondary { background: #333; }
            .btn-secondary:hover { background: #444; }
            .stats { margin-top: 30px; font-size: 14px; color: #888; background: #111; padding: 15px; border-radius: 6px; line-height: 1.8; }
            input[type="text"] { width: 100%; padding: 12px; margin-top: 20px; background: #111; color: #fff; border: 1px solid #444; border-radius: 6px; text-align: center; font-size: 14px; box-sizing: border-box; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📺 Hybrid TV FR</h1>
            <p>Votre add-on télévisuel haute-performance.<br>Édition Épurée & Serveur Suisse (Anti-Censure).</p>
            
            <div class="options">
                <label style="cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px;">
                    <input type="checkbox" id="epgToggle" checked onchange="updateLinks()" style="width: 20px; height: 20px; margin: 0; cursor: pointer;">
                    <b style="font-size: 16px;">Activer le Programme TV (EPG)</b>
                </label>
            </div>
            
            <a href="#" id="stremioBtn" class="btn">▶ Ajouter à Stremio</a>
            <button onclick="copyLink()" class="btn btn-secondary">📋 Copier le lien</button>
            <input type="text" id="manifestLink" readonly>
            
            <div class="stats">
                ${channelsStatus}<br>
                ${epgStatus}<br>
                🕒 Dernière synchronisation EPG : ${lastUpdate}
            </div>
        </div>
        <script>
            function updateLinks() {
                var isEpg = document.getElementById("epgToggle").checked;
                var conf = isEpg ? "epg-on" : "epg-off";
                var base = window.location.protocol + "//" + window.location.host;
                var url = base + "/" + conf + "/manifest.json";
                var stremioUrl = "stremio://" + window.location.host + "/" + conf + "/manifest.json";
                
                document.getElementById("manifestLink").value = url;
                document.getElementById("stremioBtn").href = stremioUrl;
            }
            updateLinks();
            
            function copyLink() {
                var copyText = document.getElementById("manifestLink");
                copyText.select(); 
                document.execCommand("copy"); 
                alert("Lien copié ! Pensez à DÉSINSTALLER l'ancien add-on dans Nuvio avant de coller celui-ci.");
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// === ROUTAGE INTELLIGENT ===
function handleManifest(req, res, conf) {
    res.setHeader('Cache-Control', 'max-age=86400, public'); 
    res.json({
        id: 'org.hybridproxy.fr.live.v65.' + conf, 
        version: '65.0.0',
        name: conf === 'epg-on' ? 'Hybrid TV FR' : 'Hybrid TV FR (Sans EPG)',
        description: 'L\'expérience IPTV ultime. Affichage Épuré Nuvio.',
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
}

app.get('/manifest.json', (req, res) => handleManifest(req, res, 'epg-on'));
app.get('/:conf/manifest.json', (req, res) => handleManifest(req, res, req.params.conf));

app.get('/:conf?/catalog/tv/:id.json', async (req, res) => {
    await waitForChannels(); 
    if (channelsData.length === 0) { res.setHeader('Cache-Control', 'no-cache'); return res.json({ metas: [] }); }
    
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

app.get('/:conf?/catalog/tv/:id/:extra', async (req, res) => {
    await waitForChannels(); 
    if (channelsData.length === 0) { res.setHeader('Cache-Control', 'no-cache'); return res.json({ metas: [] }); }

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

// === LA MISE EN PAGE NUVIO (ZÉRO SYNOPSIS, QUE DU "À SUIVRE") ===
app.get('/:conf?/meta/tv/:id.json', async (req, res) => {
    const isEpgOn = !req.params.conf || req.params.conf === 'epg-on';
    await waitForChannels();
    res.setHeader('Cache-Control', 'max-age=1800, public'); 
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });
    
    let descriptionText = `▶ Diffusion en cours sur ${channel.displayName}...`;
    
    if (isEpgOn) {
        if (isUpdatingEPG && Object.keys(epgData).length === 0) {
            descriptionText = `▶ Programme TV en cours de téléchargement (Patientez quelques instants)...`;
        } else if (Object.keys(epgData).length === 0) {
            descriptionText = `▶ Le Programme TV est momentanément indisponible...`;
        } else {
            const epgList = getEpgForChannel(channel.name);
            if (epgList && epgList.length > 0) {
                const now = Date.now();
                epgList.sort((a, b) => a.start - b.start);
                
                const currentIndex = epgList.findIndex(p => now >= p.start && now <= p.stop);
                
                if (currentIndex !== -1) {
                    const currentProg = epgList[currentIndex];
                    const sTime = new Date(currentProg.start).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
                    const eTime = new Date(currentProg.stop).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
                    
                    descriptionText = `🔴 EN DIRECT (${sTime} - ${eTime}) : ${currentProg.title}`;
                    
                    const upcoming = epgList.slice(currentIndex + 1, currentIndex + 6);
                    if (upcoming.length > 0) {
                        descriptionText += `\n\n📺 À SUIVRE :`;
                        upcoming.forEach(p => {
                            const uTime = new Date(p.start).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
                            descriptionText += `\n⏰ ${uTime} - ${p.title}`;
                        });
                    }
                    
                } else {
                    const nextProgs = epgList.filter(p => p.start > now).slice(0, 5);
                    if (nextProgs.length > 0) {
                        descriptionText = `▶ Aucun programme renseigné en ce moment.\n\n📺 À VENIR :`;
                        nextProgs.forEach(p => {
                            const uTime = new Date(p.start).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
                            descriptionText += `\n⏰ ${uTime} - ${p.title}`;
                        });
                    }
                }
            }
        }
    }

    res.json({
        meta: { id: channel.id, type: 'tv', name: channel.displayName, poster: channel.poster, posterShape: 'square', description: descriptionText }
    });
});

app.get('/:conf?/stream/tv/:id.json', async (req, res) => {
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
    updateEPG(); 
    updateStreams();
    setInterval(updateEPG, 3600000); 
    setInterval(updateStreams, 14400000); 
});
