const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');

const app = express();
app.use(cors());

// Variables globales EPG et Cache
let isUpdatingEPG = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let epgData = {}; 
let channelsCache = {}; // Cache mémoire pour éviter les lenteurs

const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

// === DÉCODAGE DU TOKEN DE CONFIGURATION ===
function parseConfig(encodedConfig) {
    try {
        if (!encodedConfig || encodedConfig === 'manifest.json') return { sources: [], epg: true };
        const jsonStr = Buffer.from(encodedConfig, 'base64').toString('utf8');
        return JSON.parse(jsonStr);
    } catch (e) {
        return { sources: [], epg: true };
    }
}

// === NORMALISATION AGRESSIVE ===
function normalizeChannelName(rawName) {
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/\s*\([Tt][Vv]\)\s*/g, '');
    n = n.replace(/DURING EVENT ONLY/g, '');
    n = n.replace(/EVENT ONLY/g, '');
    n = n.replace(/^(FR|BE|CH|CA|VIP)\s*[:|/-]+\s*/, '');
    n = n.replace(/^FR\s+/, '');
    
    if (n === 'DISNEY+' || n === 'DISNEY PLUS') return '';

    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'VAVOO', 'DIRECT', 'RAW', 'ACCESS'];
    n = n.replace(/[^A-Z0-9+ ]/g, ' '); 
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'g'), ' '); });
    n = n.replace(/\bHD\b/g, ' '); 
    n = n.replace(/\s+/g, ' ').trim();

    if (n.includes('BFM') && !n.includes('BUSINESS') && !n.includes('PARIS') && !n.includes('LYON')) return 'BFMTV';
    if (n.includes('CNEWS') || n.includes('C NEWS')) return 'CNEWS';
    if (n.includes('FRANCEINFO') || n.includes('FRANCE INFO')) return 'FRANCE INFO';
    if (n.includes('METEO')) return 'LA CHAINE METEO';
    if (n === 'LCN') return 'LCN';
    if (n.includes('20 MINUTES')) return '20 MINUTES TV';
    if (n === 'SCI FI' || n === 'SYFY') return 'SYFY';
    if (n.includes('L EQUIPE') || n.includes('LEQUIPE')) return 'L EQUIPE';
    if (n.includes('WILD') && (n.includes('NAT') || n.includes('GEO'))) return 'NATIONAL GEOGRAPHIC WILD';
    if (n.includes('NAT GEO') || n.includes('NATIONAL GEO')) return 'NATIONAL GEOGRAPHIC';
    if (n.includes('CHASSE') && n.includes('PECHE')) return 'CHASSE ET PECHE';
    if (n.includes('MTV') && !n.includes('HITS')) return 'MTV';

    if (n.includes('DISCOVERY')) {
        if (n.includes('SCIENCE') || n.includes('SCI FI')) return 'DISCOVERY SCIENCE';
        if (n.includes('INVESTIGATION') || n.includes('ID')) return 'DISCOVERY INVESTIGATION';
        return 'DISCOVERY CHANNEL';
    }

    if (n.includes('PLANETE')) {
        if (n.includes('CRIME') || n.includes('CI')) return 'PLANETE+ CRIME';
        if (n.includes('AVENTURE') || n.includes('AE')) return 'PLANETE+ AVENTURE';
        return 'PLANETE+';
    }

    let beinMatch = n.match(/BEIN SPORTS?\s*(MAX)?\s*(\d+)/);
    if (beinMatch) return beinMatch[1] ? `BEIN SPORTS MAX ${beinMatch[2]}` : `BEIN SPORTS ${beinMatch[2]}`;
    if (n.includes('BEIN SPORT')) return 'BEIN SPORTS 1';

    if (n.startsWith('CANAL') || n === 'CANAL') {
        if (n.includes('FOOT')) return 'CANAL+ FOOT';
        if (n.includes('SPORT 360') || n.includes('360')) return 'CANAL+ SPORT 360';
        if (n.includes('SPORT')) return 'CANAL+ SPORT';
        if (n.includes('CINEMA')) return 'CANAL+ CINEMA';
        if (n.includes('GRAND ECRAN') || n.includes('ECRAN')) return 'CANAL+ GRAND ECRAN';
        if (n.includes('SERIES')) return 'CANAL+ SERIES';
        if (n.includes('DOC')) return 'CANAL+ DOCS';
        if (n.includes('FAMILY')) return 'CANAL+ FAMILY';
        if (n.includes('KIDS')) return 'CANAL+ KIDS';
        if (n.includes('DECALE')) return 'CANAL+ DECALE';
        if (n.includes('BOX OFFICE')) return 'CANAL+ BOX OFFICE';
        if (n.includes('4K') || n.includes('ULTRA')) return 'CANAL+ 4K';
        return 'CANAL+';
    }

    if (n === 'DISNEY CHANNEL 1' || n === 'DISNEY 1' || n === 'DISNEYCHANNEL') return 'DISNEY CHANNEL';
    if (n === 'DISNEY JR') return 'DISNEY JUNIOR';
    if (n === 'J ONE' || n === 'G1') return 'GAME ONE';

    return n;
}

function toSyncId(name) {
    if (!name) return '';
    let n = name.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/[^A-Z0-9]/g, ''); 
    
    if (n === 'TF1' || n === 'TF1HD' || n === 'TF1FR' || n === 'TF14K') return 'TF1';
    if (n === 'TF1SERIESFILMS' || n === 'TF1SERIES') return 'TF1SERIESFILMS';
    if (n === 'FRANCE2' || n === 'FRANCETV2' || n === 'FRANCE2HD' || n === 'FRANCE2UHD') return 'FRANCE2';
    if (n === 'FRANCE3' || n === 'FRANCE3HD' || n === 'FRANCETV3') return 'FRANCE3';
    if (n === 'FRANCE4' || n === 'FRANCE4HD') return 'FRANCE4';
    if (n === 'FRANCE5' || n === 'FRANCE5HD') return 'FRANCE5';
    if (n === 'M6' || n === 'M6HD' || n === 'M6FR' || n === 'M64K') return 'M6';
    if (n === 'ARTE' || n === 'ARTEHD' || n === 'ARTEFR') return 'ARTE';
    if (n === 'C8' || n === 'C8HD') return 'C8';
    if (n === 'W9' || n === 'W9HD') return 'W9';
    if (n === 'TMC' || n === 'TMCHD') return 'TMC';
    if (n === 'TFX' || n === 'TFXHD') return 'TFX';
    if (n === 'NRJ12' || n === 'NRJ12HD') return 'NRJ12';
    if (n === 'LCP' || n === 'LCPAN' || n === 'PUBLICSENAT') return 'LCP';
    
    if (n === 'BFMTV' || n === 'BFMTVHD' || n === 'BFMTVFR' || n === 'BFM') return 'BFMTV';
    if (n === 'CNEWS' || n === 'CNEWSHD' || n === 'CNEWSFR') return 'CNEWS';
    if (n === 'CSTAR' || n === 'CSTARHD' || n === 'CSTARHITS') return 'CSTAR';
    if (n === 'GULLI' || n === 'GULLIHD') return 'GULLI';
    if (n === 'GAMEONE' || n === 'GAMEONEHD' || n === 'GAMEONEFR') return 'GAMEONE';
    if (n.startsWith('MTV') && !n.includes('HITS')) return 'MTV';
    
    if (n.startsWith('BEINSPORT')) {
        if (n.includes('1')) return 'BEINSPORTS1';
        if (n.includes('2')) return 'BEINSPORTS2';
        if (n.includes('3')) return 'BEINSPORTS3';
    }
    
    if (n.startsWith('CANAL')) {
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
        if (n === 'CANALPLUS' || n === 'CANAL' || n === 'CANALPLUSFRANCE' || n === 'CANALHD' || n === 'CANALPLUSHD') return 'CANAL'; 
    }

    if (n.startsWith('DISCOVERY')) {
        if (n.includes('SCIENCE')) return 'DISCOVERYSCIENCE';
        if (n.includes('INVESTIGATION') || n.includes('ID')) return 'DISCOVERYINVESTIGATION';
        return 'DISCOVERYCHANNEL';
    }
    
    if (n.startsWith('PLANETE')) {
        if (n.includes('CRIME')) return 'PLANETECRIME';
        if (n.includes('AVENTURE')) return 'PLANETEAVENTURE';
        if (n === 'PLANETE' || n === 'PLANETEPLUS' || n === 'PLANETEHD') return 'PLANETE';
    }
    
    if (n.startsWith('NATIONALGEOGRAPHIC') || n.startsWith('NATGEO')) {
        if (n.includes('WILD')) return 'NATIONALGEOGRAPHICWILD';
        return 'NATIONALGEOGRAPHIC';
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

// === EXTRACTEUR EPG EN STREAMING ===
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
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(timestamp)).replace(':', 'h');
}

async function fetchAndParseEPG(url, isGz) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await axios.get(url, {
                responseType: 'stream',
                timeout: 60000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' }
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
                for (const channelKey in parsedEpg) {
                    if (!tempEpgData[channelKey] && parsedEpg[channelKey].length > 0) {
                        tempEpgData[channelKey] = parsedEpg[channelKey];
                    }
                }
                if (Object.keys(tempEpgData).length > 100) break;
            } catch (err) {}
        }
        if (Object.keys(tempEpgData).length > 10) {
            epgData = tempEpgData;
            lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
        }
    } finally {
        isUpdatingEPG = false; 
    }
}

function getEpgForChannel(channelName) {
    if (!epgData || Object.keys(epgData).length === 0) return null;
    return epgData[toSyncId(channelName)] || null;
}

// === CACHE ET RÉCUPÉRATION DES CANAUX AVEC TIMEOUT RAPIDE ===
async function fetchAddonCatalog(providerUrl) {
    let allMetas = [];
    try {
        const manifestRes = await axios.get(`${providerUrl}/manifest.json`, { timeout: 5000 });
        const base = providerUrl.replace(/\/manifest\.json$/, '');
        
        for (const catalog of manifestRes.data.catalogs || []) {
            let skip = 0; let hasMore = true; let pageCount = 0; let seenIds = new Set(); 
            while (hasMore && pageCount < 6) {
                pageCount++;
                try {
                    let url = skip > 0 ? `${base}/catalog/${catalog.type}/${catalog.id}/skip=${skip}.json` : `${base}/catalog/${catalog.type}/${catalog.id}.json`;
                    let res = await axios.get(url, { timeout: 5000 });
                    if (res.data && res.data.metas && res.data.metas.length > 0) {
                        let newAdded = 0;
                        res.data.metas.forEach(m => {
                            if (!seenIds.has(m.id)) { seenIds.add(m.id); allMetas.push({ ...m, _providerBase: base }); newAdded++; }
                        });
                        if (newAdded === 0) hasMore = false; else skip += res.data.metas.length; 
                    } else { hasMore = false; }
                } catch (e) { hasMore = false; }
            }
        }
    } catch (err) {}
    return allMetas;
}

async function getChannelsForSources(sourcesList) {
    const cacheKey = sourcesList.join('|');
    if (channelsCache[cacheKey] && (Date.now() - channelsCache[cacheKey].timestamp < 3600000)) {
        return channelsCache[cacheKey].data;
    }

    let tempChannelsMap = {};
    for (let i = 0; i < sourcesList.length; i++) {
        const providerUrl = sourcesList[i].trim();
        if (!providerUrl) continue;
        
        const metas = await fetchAddonCatalog(providerUrl);
        const base = providerUrl.replace(/\/manifest\.json$/, '');

        metas.forEach(meta => {
            let dName = normalizeChannelName(meta.name);
            if (!dName || dName.length < 2) return; 

            const id = 'hyb_id_' + dName.replace(/[^a-zA-Z0-9+]/g, '_').toLowerCase();

            if (!tempChannelsMap[id]) {
                tempChannelsMap[id] = { id, name: dName, displayName: getPrettyName(dName), sources: [], poster: meta.poster || DEFAULT_POSTER };
            } else if (meta.poster && tempChannelsMap[id].poster === DEFAULT_POSTER) {
                tempChannelsMap[id].poster = meta.poster; 
            }
            
            const sourceExists = tempChannelsMap[id].sources.find(s => s.metaId === meta.id && s.providerBase === base);
            if (!sourceExists) {
                tempChannelsMap[id].sources.push({ 
                    type: 'addon', 
                    metaId: meta.id, 
                    providerBase: base,
                    isPriority: i === 0 
                });
            }
        });
    }

    let tempChannelsData = [];
    Object.values(tempChannelsMap).forEach(ch => {
        if (ch.sources.length > 0) {
            ch.sources.sort((a, b) => (b.isPriority ? 1 : 0) - (a.isPriority ? 1 : 0));
            ch.placements = getChannelPlacements(ch.name);
            tempChannelsData.push(ch);
        }
    });

    channelsCache[cacheKey] = { data: tempChannelsData, timestamp: Date.now() };
    return tempChannelsData;
}

// === INTERFACE WEB AVEC GESTION DU CONFIG TOKEN ===
app.get('/', async (req, res) => {
    let epgCount = Object.keys(epgData).length;
    let epgStatus = epgCount > 0 ? `✅ Programme téléchargé pour <b>${epgCount}</b> chaînes` : `⏳ Programme TV en cours de chargement...`;

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Hybrid TV FR</title>
        <style>
            body { font-family: -apple-system, sans-serif; background: #141414; color: #fff; text-align: center; padding: 40px 20px; }
            .container { max-width: 650px; margin: 0 auto; background: #1f1f1f; padding: 40px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-top: 4px solid #e50914; }
            h1 { color: #fff; font-size: 32px; margin-bottom: 10px; }
            p { font-size: 15px; color: #aaa; margin-bottom: 25px; line-height: 1.6; }
            .section { background: #111; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #333; text-align: left; }
            .source-row { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
            .source-row input { flex: 1; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px; font-size: 13px; }
            .btn { display: inline-block; background: #e50914; color: #fff; padding: 12px 24px; text-decoration: none; font-size: 14px; font-weight: bold; border-radius: 8px; margin: 5px; cursor: pointer; border: none; transition: 0.2s; }
            .btn:hover { background: #f40612; transform: scale(1.02); }
            .btn-secondary { background: #333; }
            .btn-secondary:hover { background: #444; }
            .btn-small { background: #444; padding: 8px 12px; font-size: 13px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .btn-danger { background: #800; padding: 8px 12px; font-size: 13px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .stats { margin-top: 25px; font-size: 14px; color: #888; background: #111; padding: 15px; border-radius: 6px; line-height: 1.8; text-align: left; }
            input[type="text"].main-link { width: 100%; padding: 12px; margin-top: 15px; background: #111; color: #fff; border: 1px solid #444; border-radius: 6px; text-align: center; font-size: 14px; box-sizing: border-box; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📺 Hybrid TV FR</h1>
            <p>Ajoutez les liens de vos manifests d'add-ons ci-dessous, puis cliquez sur générer pour obtenir votre lien universel sécurisé.</p>
            
            <div class="section">
                <label style="font-size: 14px; color: #ccc; font-weight: bold;">Sources de flux (manifest.json) :</label><br><br>
                <div id="sourcesContainer"></div>
                <button type="button" onclick="addSourceField()" class="btn btn-small">+ Ajouter une source</button>
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
            // Restauration automatique depuis le navigateur (localStorage)
            let savedSources = localStorage.getItem('hybrid_sources');
            let sources = savedSources ? JSON.parse(savedSources) : ['', ''];

            function renderSources() {
                const container = document.getElementById('sourcesContainer');
                container.innerHTML = '';
                sources.forEach((src, index) => {
                    if (index >= 5) return;
                    const div = document.createElement('div');
                    div.className = 'source-row';
                    div.innerHTML = \`
                        <input type="text" id="src_\${index}" value="\${src}" placeholder="https://votre-source.com/manifest.json">
                        \${sources.length > 1 ? '<button type="button" onclick="removeSource(' + index + ')" class="btn btn-danger">✕</button>' : ''}
                    \`;
                    container.appendChild(div);
                });
            }

            function addSourceField() {
                if (sources.length < 5) {
                    saveInputs();
                    sources.push('');
                    renderSources();
                }
            }

            function removeSource(index) {
                saveInputs();
                sources.splice(index, 1);
                renderSources();
            }

            function saveInputs() {
                sources.forEach((_, index) => {
                    const el = document.getElementById('src_' + index);
                    if (el) sources[index] = el.value.trim();
                });
                localStorage.setItem('hybrid_sources', JSON.stringify(sources));
            }

            function generateLink() {
                saveInputs();
                const validSources = sources.filter(s => s.length > 0);
                if (validSources.length === 0) {
                    alert("Veuillez entrer au moins un lien de source !");
                    return;
                }
                const isEpg = document.getElementById("epgToggle").checked;
                
                // Création du Token de configuration encodé en Base64 (Le "Code")
                const configObj = { sources: validSources, epg: isEpg };
                const configToken = btoa(JSON.stringify(configObj));
                
                const base = window.location.protocol + "//" + window.location.host;
                const url = base + "/" + configToken + "/manifest.json";
                
                document.getElementById("manifestLink").value = url;
                alert("Lien généré et sauvegardé avec succès !");
            }

            renderSources();

            function copyLink() {
                var copyText = document.getElementById("manifestLink");
                if (!copyText.value) {
                    alert("Veuillez d'abord générer le lien !");
                    return;
                }
                copyText.select(); 
                document.execCommand("copy"); 
                alert("Lien copié dans le presse-papier !");
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// === ROUTAGE DES MANIFESTS PAR CONFIG TOKEN ===
app.get('/:config/manifest.json', (req, res) => {
    const config = parseConfig(req.params.config);
    const confName = config.epg ? 'epg-on' : 'epg-off';
    
    res.setHeader('Cache-Control', 'max-age=86400, public'); 
    res.json({
        id: 'org.hybridproxy.fr.meta.' + confName, 
        version: '2.1.0',
        name: config.epg ? 'Hybrid TV FR' : 'Hybrid TV FR (Sans Programme TV)',
        description: 'L\'expérience IPTV ultime. Édition Meta-Addon sécurisée.',
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

// === CATALOGUES PAR CONFIG TOKEN ===
app.get(['/:config/catalog/tv/:id.json', '/:config/catalog/tv/:id/:extra'], async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ metas: [] });
    
    let channelsData = await getChannelsForSources(config.sources);
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

// === Méta (Programme TV) ===
app.get('/:config/meta/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ meta: {} });
    
    let channelsData = await getChannelsForSources(config.sources);
    res.setHeader('Cache-Control', 'max-age=1800, public'); 
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });
    
    let descriptionText = `▶ Diffusion en cours sur ${channel.displayName}...`;
    
    if (config.epg) {
        if (Object.keys(epgData).length === 0) {
            descriptionText = `▶ Le Programme TV est en cours de chargement...`;
        } else {
            const epgList = getEpgForChannel(channel.name);
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

// === STREAMS RAPIDES AVEC TIMEOUT ===
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
        let allStreams = [];
        for (const source of channel.sources) {
            try {
                const streamRes = await axios.get(`${source.providerBase}/stream/tv/${source.metaId}.json`, {
                    headers: { 'X-Forwarded-For': clientIp }, timeout: 5000 
                });
                if (streamRes.data && streamRes.data.streams) {
                    const mappedStreams = streamRes.data.streams.map(s => {
                        let qual = "Qualité Standard (SD)";
                        let up = (s.title || '').toUpperCase();
                        if (up.includes('4K') || up.includes('2160') || up.includes('UHD')) qual = "Ultra Haute Qualité (4K)";
                        else if (up.includes('FHD') || up.includes('1080') || up.includes('HD') || up.includes('720')) qual = "Haute Qualité (HD/FHD)";
                        return { ...s, _qualText: qual, _isPriority: source.isPriority };
                    });
                    allStreams = allStreams.concat(mappedStreams);
                }
            } catch (err) {}
        }
        
        allStreams.sort((a, b) => {
            if (a._isPriority && !b._isPriority) return -1;
            if (!a._isPriority && b._isPriority) return 1;
            return 0;
        });

        const finalStreams = allStreams.map((s, idx) => ({
            url: s.url, name: `▶ Source ${idx + 1}`, title: s._qualText
        }));
        
        res.json({ streams: finalStreams });
    } catch (err) { res.json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`Meta-Addon Server démarré sur le port ${PORT}`);
    updateEPG(); 
    setInterval(updateEPG, 3600000); 
});
