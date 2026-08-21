const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');

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
    n = n.replace(/\s+/g, ' ').trim();

    // Raccords Spéciaux
    if (n === 'TF 1') return 'TF1';
    if (n === 'C 8') return 'C8';
    if (n === 'CANAL PLUS' || n === 'CANAL' || n.includes('CANAL+ FRANCE')) return 'CANAL+';
    
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

// === LECTEUR EPG V61 (FUSION DE SOURCES MULTIPLES) ===
function slugify(str) { return str.toUpperCase().replace(/[^A-Z0-9]/g, ''); }

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

function extractEpgData(xml) {
    let sourceEpg = {};
    let epgChannels = {};
    
    // Scan des chaînes
    let chIdx = 0;
    while ((chIdx = xml.indexOf('<channel ', chIdx)) !== -1) {
        const endTag = xml.indexOf('</channel>', chIdx);
        if (endTag === -1) break;
        const block = xml.substring(chIdx, endTag);
        
        const idM = block.match(/id=["']([^"']+)["']/);
        const nameM = block.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
        
        if (idM && nameM) {
            epgChannels[idM[1]] = normalizeChannelName(nameM[1]);
        }
        chIdx = endTag + 10;
    }

    // Scan des programmes
    let pIdx = 0;
    while ((pIdx = xml.indexOf('<programme ', pIdx)) !== -1) {
        const pEnd = xml.indexOf('</programme>', pIdx);
        if (pEnd === -1) break;
        const block = xml.substring(pIdx, pEnd);
        
        const startM = block.match(/start=["']([^"']+)["']/);
        const stopM = block.match(/stop=["']([^"']+)["']/);
        const chanM = block.match(/channel=["']([^"']+)["']/);
        const titleM = block.match(/<title[^>]*>([^<]+)<\/title>/);
        const descM = block.match(/<desc[^>]*>([\s\S]*?)<\/desc>/);
        
        if (startM && stopM && chanM && titleM) {
            const rawChName = epgChannels[chanM[1]];
            if (rawChName) {
                if (!sourceEpg[rawChName]) sourceEpg[rawChName] = [];
                sourceEpg[rawChName].push({
                    start: parseXmltvDate(startM[1]),
                    stop: parseXmltvDate(stopM[1]),
                    title: titleM[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").trim(),
                    desc: descM ? descM[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").trim() : ''
                });
            }
        }
        pIdx = pEnd + 12;
    }
    return sourceEpg;
}

async function updateEPG() {
    if (isUpdatingEPG) return;
    isUpdatingEPG = true; 
    let tempEpgData = {};
    
    // Le Fusionneur : Il télécharge chaque source et ajoute les chaînes manquantes.
    const urls = [ 
        { url: 'https://xmltvfr.fr/xmltv/xmltv_francophone.xml', isGz: false }, // Priorité 1: Qualité TNT FR parfaite (TF1, C8, Canal+)
        { url: 'https://epgshare01.online/epgshare01/epg_ripper_FR1.xml.gz', isGz: true }, // Priorité 2: Méga base Sports / Découverte
        { url: 'https://raw.githubusercontent.com/Fazzani/grabber/master/guide.xml', isGz: false } // Priorité 3: Reste du monde
    ];

    try {
        let loadedSources = 0;
        
        for (const source of urls) {
            try {
                lastEpgError = `Fusion en cours... (${source.url.substring(8, 25)})`;
                const response = await axios.get(source.url, { 
                    responseType: source.isGz ? 'arraybuffer' : 'text',
                    timeout: 45000, 
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                
                let xml = '';
                if (source.isGz) {
                    const unzipped = await new Promise((resolve, reject) => {
                        zlib.gunzip(response.data, (err, buffer) => {
                            if (err) reject(err); else resolve(buffer);
                        });
                    });
                    xml = unzipped.toString('utf-8');
                } else {
                    xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                }
                
                // On extrait les programmes de cette source
                const parsedEpg = extractEpgData(xml);
                xml = null; // On libère la RAM immédiatement
                
                // FUSION : On ajoute les chaînes trouvées SI elles n'y sont pas déjà
                for (const channelName in parsedEpg) {
                    if (!tempEpgData[channelName] && parsedEpg[channelName].length > 0) {
                        tempEpgData[channelName] = parsedEpg[channelName];
                    }
                }
                
                loadedSources++;
                // Si on a récolté plus de 150 chaînes TV, le travail est fini !
                if (Object.keys(tempEpgData).length > 150) break;
                
            } catch (err) {
                console.log(`[EPG] Source ignorée (${source.url}):`, err.message);
            }
        }
        
        if (Object.keys(tempEpgData).length > 10) {
            epgData = tempEpgData;
            lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
            lastEpgError = "Succès";
        } else {
            lastEpgError = "Toutes les sources EPG sont actuellement hors ligne.";
        }
        
    } finally {
        isUpdatingEPG = false; 
    }
}

function getEpgForChannel(channelName) {
    if (!epgData || Object.keys(epgData).length === 0) return null;
    const targetSlug = slugify(channelName);
    
    let foundKey = Object.keys(epgData).find(k => slugify(k) === targetSlug);
    if (foundKey) return epgData[foundKey];

    const aliases = {
        "TF1": ["TF1FR", "TF1HD", "TF1.fr"],
        "FRANCE2": ["FRANCETV2", "FRANCE2HD", "France2.fr"],
        "M6": ["M6FR", "M6HD", "M6.fr"],
        "CNEWS": ["CNEWSFR", "CNews.fr"], 
        "BFMTV": ["BFMTVFR", "BFM", "BFMTV.fr"], 
        "ARTE": ["ARTEHD", "Arte.fr"], 
        "W9": ["W9HD", "W9.fr"],
        "TMC": ["TMCHD", "TMC.fr"], 
        "TFX": ["TFXHD", "TFX.fr"], 
        "NRJ12": ["NRJ12HD", "NRJ12.fr"], 
        "C8": ["C8HD", "C8.fr"], 
        "GULLI": ["GULLIHD", "Gulli.fr"]
    };

    if (aliases[targetSlug]) {
        for (const alias of aliases[targetSlug]) {
            foundKey = Object.keys(epgData).find(k => slugify(k) === slugify(alias));
            if (foundKey) return epgData[foundKey];
        }
    }

    foundKey = Object.keys(epgData).find(k => slugify(k).startsWith(targetSlug) && Math.abs(k.length - targetSlug.length) <= 3);
    return foundKey ? epgData[foundKey] : null;
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
    const host = req.get('host');
    const manifestUrl = `https://${host}/manifest.json`;
    const stremioUrl = `stremio://${host}/manifest.json`;
    
    let channelsStatus = isUpdatingChannels 
        ? '⏳ Recherche des chaînes en cours...' 
        : `✅ <b>${channelsData.length}</b> chaînes actives`;
        
    let epgStatus = "";
    if (isUpdatingEPG) {
        epgStatus = `⏳ ${lastEpgError}`;
    } else {
        const epgCount = Object.keys(epgData).length;
        if (epgCount > 0) {
            epgStatus = `✅ Programme TV chargé pour <b>${epgCount}</b> chaînes (Fusion active)`;
        } else {
            epgStatus = `❌ Échec du téléchargement.<br>Erreur technique : <i>${lastEpgError}</i>`;
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
            <p>Votre add-on télévisuel haute-performance.<br>Édition Spéciale "Magazine TV" avec Fusion de données.</p>
            
            <a href="${stremioUrl}" class="btn">▶ Ajouter à Stremio</a>
            <button onclick="copyLink()" class="btn btn-secondary">📋 Copier le lien</button>
            <input type="text" id="manifestLink" value="${manifestUrl}" readonly>
            
            <div class="stats">
                ${channelsStatus}<br>
                ${epgStatus}<br>
                🕒 Dernière synchronisation : ${lastUpdate}
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
        id: 'org.hybridproxy.fr.live.v61', 
        version: '61.0.0',
        name: 'Hybrid TV FR',
        description: 'L\'expérience IPTV ultime. Tri par IA, Programme TV Magazine, zéro publicité.',
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

app.get('/catalog/tv/:id/:extra', async (req, res) => {
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

// === LA MISE EN PAGE "MAGAZINE TV" (Inversée pour Nuvio) ===
app.get('/meta/tv/:id.json', async (req, res) => {
    await waitForChannels();
    res.setHeader('Cache-Control', 'max-age=1800, public'); 
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });
    
    let descriptionText = `▶ Diffusion en cours sur ${channel.displayName}...`;
    if (isUpdatingEPG && Object.keys(epgData).length === 0) {
        descriptionText = `▶ Programme TV en cours de téléchargement (Patientez quelques instants)...`;
    } else if (Object.keys(epgData).length === 0) {
        descriptionText = `▶ Le Programme TV est momentanément indisponible...`;
    }
    
    const epgList = getEpgForChannel(channel.name);
    if (epgList && epgList.length > 0) {
        const now = Date.now();
        epgList.sort((a, b) => a.start - b.start);
        
        const currentIndex = epgList.findIndex(p => now >= p.start && now <= p.stop);
        
        if (currentIndex !== -1) {
            const currentProg = epgList[currentIndex];
            const sTime = new Date(currentProg.start).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
            const eTime = new Date(currentProg.stop).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
            
            // 1. LE TITRE EN HAUT (Reste visible sous forme de "Sous-titre" dans Nuvio)
            descriptionText = `🔴 EN DIRECT (${sTime} - ${eTime}) : ${currentProg.title}`;
            
            // 2. LES PROGRAMMES "À SUIVRE" DIRECTEMENT EN DESSOUS (Pas besoin de dérouler le texte)
            const upcoming = epgList.slice(currentIndex + 1, currentIndex + 6);
            if (upcoming.length > 0) {
                descriptionText += `\n\n📺 À SUIVRE :`;
                upcoming.forEach(p => {
                    const uTime = new Date(p.start).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
                    descriptionText += `\n⏰ ${uTime} - ${p.title}`;
                });
            }

            // 3. LE GROS RÉSUMÉ RELÉGUÉ TOUT EN BAS
            if (currentProg.desc) {
                descriptionText += `\n\n📝 RÉSUMÉ :\n${currentProg.desc}`;
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
    updateEPG(); 
    updateStreams();
    setInterval(updateEPG, 3600000); 
    setInterval(updateStreams, 14400000); 
});
