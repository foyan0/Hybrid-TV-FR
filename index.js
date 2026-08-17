const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

let isUpdating = true;

const ADDON_PROVIDERS = [
    { id: 'vavoo', base: 'https://tvvoo.hayd.uk/cfg-fr', label: 'Vavoo', isPriority: true },
    { id: 'mio', base: 'https://tvmio.ooguy.com/eyJjb3VudHJpZXMiOlsiRlIiLCJCRV9GUiJdLCJjYXRlZ29yaWVzIjp7IkZSIjpbIkdlbmVyYWwg8J+7oiIsIlNwb3J0cyDimq3igIsiLCJEb2N1bWVudGFpcmVzIPCfijrQuiIsIkZpbG1zIPCfjqwiLCJJbmZvcm1hdGlvbnMg8J+7oiIsIkVuZmFudHMgv5G2IiwiTXVzaWMg8J+OtSJdfSwiZW5hYmxlU2VhcmNoIjpmYWxzZX0', label: 'Mio', isPriority: false }
];

let channelsData = [];
let epgData = {}; 
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

// === NORMALISATION STRICTE ===
function normalizeChannelName(rawName) {
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    n = n.replace(/\s*\([Tt][Vv]\)\s*/g, ''); // Suppression de (TV)
    n = n.replace(/^(FR|BE|CH|CA|VIP)\s*[:|/-]+\s*/, '');
    n = n.replace(/^FR\s+/, '');
    
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'VAVOO', 'DIRECT', 'RAW', 'ACCESS'];
    n = n.replace(/[^A-Z0-9+ ]/g, ' '); 
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'g'), ' '); });
    n = n.replace(/\s+/g, ' ').trim();

    // Alias pour regrouper les doublons et nettoyer les noms
    if (n === 'BFM' || n === 'BFM TV') n = 'BFMTV';
    if (n === 'C NEWS') n = 'CNEWS';
    if (n === 'FRANCEINFO') n = 'FRANCE INFO';
    if (n === 'LA CHAINE METEO' || n === 'METEO') n = 'LA CHAINE METEO';
    if (n === 'LCN') n = 'LCN';
    if (n === '20 MINUTES') n = '20 MINUTES TV';

    if (n === 'CANAL PLUS') n = 'CANAL+';
    if (n === 'CANAL PLUS FOOT' || n === 'FOOT+') n = 'CANAL+ FOOT';
    if (n === 'CANAL PLUS SPORT') n = 'CANAL+ SPORT';
    if (n === 'CANAL PLUS SPORT 360' || n === 'CANAL+ 360' || n === 'CANAL SPORT 360') n = 'CANAL+ SPORT 360';
    if (n === 'CANAL PLUS CINEMA') n = 'CANAL+ CINEMA';
    if (n === 'CANAL PLUS GRAND ECRAN') n = 'CANAL+ GRAND ECRAN';
    if (n === 'CANAL PLUS SERIES') n = 'CANAL+ SERIES';
    if (n === 'CANAL PLUS DOCS') n = 'CANAL+ DOCS';
    if (n === 'CANAL PLUS FAMILY') n = 'CANAL+ FAMILY';
    if (n === 'CANAL PLUS KIDS' || n === 'CANAL KIDS') n = 'CANAL+ KIDS';
    if (n === 'CANAL PLUS DECALE') n = 'CANAL+ DECALE';
    if (n === 'CANAL PLUS BOX OFFICE') n = 'CANAL+ BOX OFFICE';
    if (n.includes('CANAL') && (n.includes('ULTRA') || n.includes('4K'))) n = 'CANAL+ 4K';

    if (n === 'DISNEY CHANNEL 1' || n === 'DISNEY 1') n = 'DISNEY CHANNEL +1';
    if (n === 'DISNEY JR') n = 'DISNEY JUNIOR';
    if (n === 'J ONE' || n === 'G1') n = 'GAME ONE';

    return n;
}

function getPrettyName(n) {
    if (n === 'TF1') return 'TF1';
    if (n === 'M6') return 'M6';
    if (n === 'W9') return 'W9';
    if (n === 'C8') return 'C8';
    if (n === 'TFX') return 'TFX';
    if (n === 'TMC') return 'TMC';
    if (n === 'LCI') return 'LCI';
    if (n === 'LCN') return 'LCN';
    if (n === 'BFMTV') return 'BFMTV';
    if (n === 'CNEWS') return 'CNews';
    if (n === 'GULLI') return 'Gulli';
    if (n === 'ARTE') return 'Arte';
    if (n.startsWith('CANAL+')) return n.replace('CANAL+', 'Canal+').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase()).replace('Canal+ ', 'Canal+ ');
    return n.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
}

// === PLACEMENTS MULTIPLES EXACTS ===
function getChannelPlacements(n) {
    let placements = [];

    // INFO
    if (n === 'FRANCE INFO') placements.push({ category: 'vavoo_info', index: 1 });
    else if (n === 'LA CHAINE METEO') placements.push({ category: 'vavoo_info', index: 2 });
    else if (n === 'CNEWS') placements.push({ category: 'vavoo_info', index: 3 });
    else if (n === 'LCI') placements.push({ category: 'vavoo_info', index: 4 });
    else if (n === 'BFMTV') placements.push({ category: 'vavoo_info', index: 5 });
    else if (n === 'FRANCE 24') placements.push({ category: 'vavoo_info', index: 6 });
    else if (n === 'EURONEWS') placements.push({ category: 'vavoo_info', index: 7 });
    else if (n === 'LCN') placements.push({ category: 'vavoo_info', index: 8 });
    else if (n === '20 MINUTES TV') placements.push({ category: 'vavoo_info', index: 9 });
    else if (n.includes('INFO')) placements.push({ category: 'vavoo_info', index: 50 });

    // JEUNESSE
    if (n === 'CARTOON NETWORK') placements.push({ category: 'vavoo_jeunesse', index: 1 });
    else if (n === 'DISNEY CHANNEL') placements.push({ category: 'vavoo_jeunesse', index: 2 });
    else if (n === 'GULLI') placements.push({ category: 'vavoo_jeunesse', index: 3 });
    else if (n === 'NICKELODEON') placements.push({ category: 'vavoo_jeunesse', index: 4 });
    else if (n === 'GAME ONE') placements.push({ category: 'vavoo_jeunesse', index: 5 });
    else if (n === 'DISNEY XD') placements.push({ category: 'vavoo_jeunesse', index: 6 });
    else if (n === 'BOOMERANG') placements.push({ category: 'vavoo_jeunesse', index: 7 });
    else if (n === 'CANAL J') placements.push({ category: 'vavoo_jeunesse', index: 8 });
    else if (n === 'CANAL+ KIDS') placements.push({ category: 'vavoo_jeunesse', index: 9 });
    else if (n === 'DISNEY JUNIOR') placements.push({ category: 'vavoo_jeunesse', index: 10 });
    else if (n === 'NICKELODEON TEEN') placements.push({ category: 'vavoo_jeunesse', index: 11 });
    else if (n === 'NICKELODEON JUNIOR') placements.push({ category: 'vavoo_jeunesse', index: 12 });
    else if (n === 'MANGAS') placements.push({ category: 'vavoo_jeunesse', index: 13 });
    else if (n === 'DISNEY CHANNEL +1') placements.push({ category: 'vavoo_jeunesse', index: 50 });
    else if (n.includes('NICKELODEON +1') || n.includes('NICKELODEON 14')) placements.push({ category: 'vavoo_jeunesse', index: 51 });
    else if (n.includes('DISNEY') || n.includes('CARTOON') || n.includes('BOOMERANG') || n.includes('NICKELODEON') || n.includes('TIJI') || n.includes('TELETOON') || n.includes('PIWI')) placements.push({ category: 'vavoo_jeunesse', index: 30 });

    // BOUQUET CANAL
    if (n === 'CANAL+') placements.push({ category: 'vavoo_canal', index: 1 });
    else if (n === 'CANAL+ FOOT') placements.push({ category: 'vavoo_canal', index: 2 });
    else if (n === 'CANAL+ SPORT') placements.push({ category: 'vavoo_canal', index: 3 });
    else if (n === 'CANAL+ SPORT 360') placements.push({ category: 'vavoo_canal', index: 4 });
    else if (n === 'CANAL+ FORMULA 1') placements.push({ category: 'vavoo_canal', index: 5 });
    else if (n === 'CANAL+ CINEMA') placements.push({ category: 'vavoo_canal', index: 6 });
    else if (n === 'CANAL+ GRAND ECRAN') placements.push({ category: 'vavoo_canal', index: 7 });
    else if (n === 'CANAL+ BOX OFFICE') placements.push({ category: 'vavoo_canal', index: 8 });
    else if (n === 'CANAL+ SERIES') placements.push({ category: 'vavoo_canal', index: 9 });
    else if (n === 'CANAL+ FAMILY') placements.push({ category: 'vavoo_canal', index: 10 });
    else if (n === 'CANAL+ DOCS') placements.push({ category: 'vavoo_canal', index: 11 });
    else if (n === 'CANAL J') placements.push({ category: 'vavoo_canal', index: 12 });
    else if (n === 'CANAL+ KIDS') placements.push({ category: 'vavoo_canal', index: 13 });
    else if (n === 'CANAL+ 4K') placements.push({ category: 'vavoo_canal', index: 14 });
    else if (n === 'CANAL+ DECALE') placements.push({ category: 'vavoo_canal', index: 15 });
    else if (n === 'CSTAR HITS') placements.push({ category: 'vavoo_canal', index: 16 });
    else if (n.startsWith('CANAL+')) placements.push({ category: 'vavoo_canal', index: 30 });

    // SPORTS
    if (n === 'CANAL+ SPORT' || n === 'CANAL+ FOOT' || n === 'CANAL+ SPORT 360' || n === 'CANAL+ FORMULA 1') placements.push({ category: 'vavoo_sports', index: 250 });
    if (n.startsWith('BEIN SPORTS') || n.includes('BING SPORT')) placements.push({ category: 'vavoo_sports', index: 100 });
    else if (n.startsWith('RMC SPORT') && !n.includes('MULTICANAL')) placements.push({ category: 'vavoo_sports', index: 110 });
    else if (n.startsWith('EUROSPORT')) placements.push({ category: 'vavoo_sports', index: 120 });
    else if (n.startsWith('DAZN')) placements.push({ category: 'vavoo_sports', index: 130 });
    else if (n.startsWith('AUTOMOTO')) placements.push({ category: 'vavoo_sports', index: 140 });
    else if (n.includes('GOLF')) placements.push({ category: 'vavoo_sports', index: 150 });
    else if (n.includes('EQUIDIA')) placements.push({ category: 'vavoo_sports', index: 160 });
    else if (n.includes('SPORT') && !n.includes('CANAL')) placements.push({ category: 'vavoo_sports', index: 199 });

    // DECOUVERTE
    if (n === 'DISCOVERY CHANNEL') placements.push({ category: 'vavoo_decouverte', index: 1 });
    else if (n === 'DISCOVERY') placements.push({ category: 'vavoo_decouverte', index: 2 });
    else if (n === 'USHUAIA') placements.push({ category: 'vavoo_decouverte', index: 3 });
    else if (n === 'CRIME DISTRICT') placements.push({ category: 'vavoo_decouverte', index: 4 });
    else if (n === 'CHASSE ET PECHE' || n === 'CHASSE & PECHE' || n === 'CHASSE') placements.push({ category: 'vavoo_decouverte', index: 5 });
    else if (n === 'ANIMAUX') placements.push({ category: 'vavoo_decouverte', index: 6 });
    else if (n === 'STAR CHANNEL') placements.push({ category: 'vavoo_decouverte', index: 7 });

    // CINEMA
    if (n.includes('PARAMOUNT')) placements.push({ category: 'vavoo_cinema', index: 1 });
    else if (n.includes('WARNER')) placements.push({ category: 'vavoo_cinema', index: 2 });
    else if (n.includes('ACTION')) placements.push({ category: 'vavoo_cinema', index: 3 });
    else if (n.includes('TCM')) placements.push({ category: 'vavoo_cinema', index: 4 });
    else if (n.includes('CINE+')) placements.push({ category: 'vavoo_cinema', index: 5 });
    else if (n.includes('OCS')) placements.push({ category: 'vavoo_cinema', index: 6 });

    // MUSIQUE
    if (n.includes('MCM') || n.includes('MEZZO') || n.includes('MTV') || n.includes('NRJ HITS')) {
        placements.push({ category: 'vavoo_musique', index: 10 });
    }

    // TNT
    if (n === 'TF1') placements.push({ category: 'vavoo_tnt', index: 1 });
    else if (n === 'FRANCE 2') placements.push({ category: 'vavoo_tnt', index: 2 });
    else if (n === 'FRANCE 3') placements.push({ category: 'vavoo_tnt', index: 3 });
    else if (n === 'FRANCE 4') placements.push({ category: 'vavoo_tnt', index: 4 });
    else if (n === 'FRANCE 5') placements.push({ category: 'vavoo_tnt', index: 5 });
    else if (n === 'M6') placements.push({ category: 'vavoo_tnt', index: 6 });
    else if (n === 'ARTE') placements.push({ category: 'vavoo_tnt', index: 7 });
    else if (n === 'C8') placements.push({ category: 'vavoo_tnt', index: 8 });
    else if (n === 'W9') placements.push({ category: 'vavoo_tnt', index: 9 });
    else if (n === 'TMC') placements.push({ category: 'vavoo_tnt', index: 10 });
    else if (n === 'TFX') placements.push({ category: 'vavoo_tnt', index: 11 });
    else if (n === 'NRJ 12') placements.push({ category: 'vavoo_tnt', index: 12 });
    else if (n.includes('LCP') || n.includes('SENAT')) placements.push({ category: 'vavoo_tnt', index: 13 });
    else if (n === 'CSTAR') placements.push({ category: 'vavoo_tnt', index: 17 });
    else if (n === 'GULLI') placements.push({ category: 'vavoo_tnt', index: 18 });
    else if (n === 'TF1 SERIES') placements.push({ category: 'vavoo_tnt', index: 20 });
    else if (n === "L'ÉQUIPE") placements.push({ category: 'vavoo_tnt', index: 21 });
    else if (n === '6TER') placements.push({ category: 'vavoo_tnt', index: 22 });
    else if (n === 'RMC STORY') placements.push({ category: 'vavoo_tnt', index: 23 });
    else if (n === 'RMC DECOUVERTE') placements.push({ category: 'vavoo_tnt', index: 24 });
    else if (n === 'CHERIE 25') placements.push({ category: 'vavoo_tnt', index: 25 });

    if (placements.length === 0) {
        placements.push({ category: 'vavoo_autres', index: 500 });
    }

    return placements;
}

// === LECTEUR EPG AVANCÉ (Double source + Heure Locale) ===
const EPG_MAPPING = {
    "TF1": ["TF1", "TF1 FR", "TF1 HD"],
    "FRANCE 2": ["FRANCE 2", "FRANCETV 2", "FRANCE 2 HD"],
    "FRANCE 3": ["FRANCE 3", "FRANCE 3 REGIONS"],
    "FRANCE 4": ["FRANCE 4", "FRANCE 4 HD"],
    "FRANCE 5": ["FRANCE 5", "FRANCE 5 HD"],
    "M6": ["M6", "M6 FR", "M6 HD"],
    "ARTE": ["ARTE", "ARTE HD"],
    "C8": ["C8", "C8 HD"],
    "W9": ["W9", "W9 HD"],
    "TMC": ["TMC", "TMC HD"],
    "TFX": ["TFX", "TFX HD"],
    "NRJ 12": ["NRJ 12", "NRJ12", "NRJ 12 HD"],
    "BFMTV": ["BFMTV", "BFM TV", "BFM"],
    "CNEWS": ["CNEWS", "C NEWS"],
    "LCI": ["LCI"],
    "FRANCE INFO": ["FRANCE INFO", "FRANCEINFO"],
    "CANAL+": ["CANAL+", "CANAL +", "CANAL"],
    "CANAL J": ["CANAL J", "CANALJ"],
    "CANAL+ KIDS": ["CANAL+ KIDS", "CANAL KIDS", "CANAL PLUS KIDS"],
    "GULLI": ["GULLI", "GULLI HD"],
    "GAME ONE": ["GAME ONE", "GAMEONE"],
    "DISNEY CHANNEL": ["DISNEY CHANNEL", "DISNEY CHANNEL HD"],
    "CARTOON NETWORK": ["CARTOON NETWORK", "CARTOON NETWORK HD"]
};

function getEpgForChannel(channelName) {
    if (!epgData) return null;
    const target = channelName.toUpperCase().trim();
    if (epgData[target]) return epgData[target];

    for (const [key, aliases] of Object.entries(EPG_MAPPING)) {
        if (aliases.includes(target) || target === key) {
            for (const alias of aliases) {
                if (epgData[alias]) return epgData[alias];
            }
        }
    }
    const foundKey = Object.keys(epgData).find(k => k === target || k.includes(target) || target.includes(k));
    return foundKey ? epgData[foundKey] : null;
}

function parseXmltvDate(str) {
    if (!str) return 0;
    const y = str.substring(0,4), m = str.substring(4,6), d = str.substring(6,8);
    const h = str.substring(8,10), min = str.substring(10,12), s = str.substring(12,14);
    let offset = str.substring(15).trim() || '+0200';
    if (!offset.includes(':') && offset.length >= 5) {
        offset = offset.slice(0,3) + ':' + offset.slice(3);
    } else if (offset.length < 5) {
        offset = '+02:00';
    }
    return new Date(`${y}-${m}-${d}T${h}:${min}:${s}${offset}`).getTime();
}

async function updateEPG() {
    const urls = ['https://xmltv.ch/xmltv/xmltv-tnt.xml', 'https://xmltv.ch/xmltv/xmltv-francophone.xml'];
    let newEpgData = {};

    for (const url of urls) {
        try {
            const res = await axios.get(url, { timeout: 15000 });
            const xml = res.data;
            let epgChannels = {};
            
            const chRegex = /<channel id="([^"]+)">\s*<display-name[^>]*>(.*?)<\/display-name>/g;
            let match;
            while ((match = chRegex.exec(xml)) !== null) {
                epgChannels[match[1]] = normalizeChannelName(match[2]);
            }

            const progBlocks = xml.match(/<programme[^>]+>[\s\S]*?<\/programme>/g) || [];
            for (let block of progBlocks) {
                const startMatch = block.match(/start="([^"]+)"/);
                const stopMatch = block.match(/stop="([^"]+)"/);
                const chanMatch = block.match(/channel="([^"]+)"/);
                const titleMatch = block.match(/<title[^>]*>([^<]+)<\/title>/);
                const descMatch = block.match(/<desc[^>]*>([^<]+)<\/desc>/);

                if (startMatch && stopMatch && chanMatch && titleMatch) {
                    const rawChName = epgChannels[chanMatch[1]];
                    if (!rawChName) continue;

                    const startTs = parseXmltvDate(startMatch[1]);
                    const stopTs = parseXmltvDate(stopMatch[1]);

                    if (!newEpgData[rawChName]) newEpgData[rawChName] = [];
                    newEpgData[rawChName].push({
                        start: startTs,
                        stop: stopTs,
                        title: titleMatch[1].trim(),
                        desc: descMatch ? descMatch[1].trim() : ''
                    });
                }
            }
        } catch (err) {}
    }
    epgData = newEpgData;
}

// === ASPIRATEUR ===
async function fetchAddonCatalog(provider) {
    let allMetas = [];
    try {
        const manifestRes = await axios.get(`${provider.base}/manifest.json`, { timeout: 10000 });
        for (const catalog of manifestRes.data.catalogs) {
            let skip = 0;
            let hasMore = true;
            let pageCount = 0;
            let seenIds = new Set(); 
            while (hasMore && pageCount < 15) {
                pageCount++;
                try {
                    let url = skip > 0 ? `${provider.base}/catalog/${catalog.type}/${catalog.id}/skip=${skip}.json` : `${provider.base}/catalog/${catalog.type}/${catalog.id}.json`;
                    let res = await axios.get(url, { timeout: 10000 });
                    if (res.data && res.data.metas && res.data.metas.length > 0) {
                        let newAdded = 0;
                        res.data.metas.forEach(m => {
                            if (!seenIds.has(m.id)) {
                                seenIds.add(m.id);
                                allMetas.push(m);
                                newAdded++;
                            }
                        });
                        if (newAdded === 0) hasMore = false; 
                        else skip += res.data.metas.length; 
                    } else { hasMore = false; }
                } catch (e) { hasMore = false; }
            }
        }
    } catch (err) {}
    return allMetas;
}

async function updateStreams() {
    isUpdating = true;
    try {
        let channelsMap = {};

        for (const provider of ADDON_PROVIDERS) {
            const metas = await fetchAddonCatalog(provider);
            metas.forEach(meta => {
                let dName = normalizeChannelName(meta.name);
                if (!dName || dName.length < 2) return; 

                const id = 'hyb_id_' + dName.replace(/[^a-zA-Z0-9+]/g, '_').toLowerCase();

                if (!channelsMap[id]) {
                    channelsMap[id] = { id, name: dName, displayName: getPrettyName(dName), sources: [], poster: meta.poster || DEFAULT_POSTER };
                }
                
                const sourceExists = channelsMap[id].sources.find(s => s.metaId === meta.id && s.provider && s.provider.id === provider.id);
                if (!sourceExists) channelsMap[id].sources.push({ type: 'addon', metaId: meta.id, provider: provider });
            });
        }

        channelsData = [];
        Object.values(channelsMap).forEach(ch => {
            if (ch.sources.length > 0) {
                ch.placements = getChannelPlacements(ch.name);
                channelsData.push(ch);
            }
        });

    } catch (err) {}
    isUpdating = false; 
}

// === NOUVELLE PAGE WEB ===
app.get('/', (req, res) => {
    const host = req.get('host');
    const manifestUrl = `https://${host}/manifest.json`;
    const stremioUrl = `stremio://${host}/manifest.json`;
    
    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Hybrid TV FR</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #141414; color: #fff; text-align: center; padding: 40px 20px; }
            .container { max-width: 600px; margin: 0 auto; background: #1f1f1f; padding: 40px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-top: 4px solid #e50914; }
            h1 { color: #fff; font-size: 32px; margin-bottom: 10px; }
            p { font-size: 16px; color: #aaa; margin-bottom: 30px; line-height: 1.6; }
            .btn { display: inline-block; background: #e50914; color: #fff; padding: 15px 30px; text-decoration: none; font-size: 16px; font-weight: bold; border-radius: 8px; margin: 10px; cursor: pointer; border: none; transition: 0.2s; }
            .btn:hover { background: #f40612; transform: scale(1.05); }
            .btn-secondary { background: #333; }
            .btn-secondary:hover { background: #444; }
            .stats { margin-top: 30px; font-size: 14px; color: #888; background: #111; padding: 15px; border-radius: 6px; }
            input { width: 100%; padding: 12px; margin-top: 20px; background: #111; color: #fff; border: 1px solid #444; border-radius: 6px; text-align: center; font-size: 14px; box-sizing: border-box; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📺 Hybrid TV FR</h1>
            <p>Votre add-on télévisuel unifié et épuré. <br>Profitez d'un guide TV en temps réel sur la majorité des chaînes, le tout avec un tri parfait et sans aucun texte polluant.</p>
            
            <a href="${stremioUrl}" class="btn">▶ Ajouter à Stremio</a>
            <button onclick="copyLink()" class="btn btn-secondary">📋 Copier le lien pour Nuvio</button>
            
            <input type="text" id="manifestLink" value="${manifestUrl}" readonly>
            
            <div class="stats">
                ${isUpdating ? '⏳ Mise à jour de la grille en cours...' : `✅ <b>${channelsData.length}</b> chaînes actives et triées`}
            </div>
        </div>

        <script>
            function copyLink() {
                var copyText = document.getElementById("manifestLink");
                copyText.select();
                copyText.setSelectionRange(0, 99999);
                document.execCommand("copy");
                alert("Lien copié avec succès ! Collez-le dans la barre de recherche des Add-ons sur Nuvio.");
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.hybridproxy.fr.live.v39', 
        version: '39.0.0',
        name: 'Hybrid TV FR',
        description: 'TNT, Information, Jeunesse, Découverte, Cinéma, Musique, Bouquet Canal, Sports.',
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

const handleCatalog = (req, res) => {
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
        id: ch.id,
        type: 'tv',
        name: ch.displayName,
        poster: ch.poster,
        posterShape: 'square'
    }));
    res.json({ metas: paginatedMetas });
};

app.get('/catalog/tv/:id.json', handleCatalog);
app.get('/catalog/tv/:id/:extra', handleCatalog);

app.get('/meta/tv/:id.json', async (req, res) => {
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });
    
    let descriptionText = undefined;
    const epgList = getEpgForChannel(channel.name);
    
    if (epgList) {
        const now = Date.now();
        const currentProg = epgList.find(p => now >= p.start && now <= p.stop);
        if (currentProg) {
            descriptionText = `🔴 EN DIRECT : ${currentProg.title}`;
            if (currentProg.desc) {
                descriptionText += `\n\n${currentProg.desc}`;
            }
        }
    }

    let responseMeta = {
        id: channel.id,
        type: 'tv',
        name: channel.displayName,
        poster: channel.poster,
        posterShape: 'square'
    };
    
    if (descriptionText) {
        responseMeta.description = descriptionText;
    }

    res.json({ meta: responseMeta });
});

app.get('/stream/tv/:id.json', async (req, res) => {
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
                            
                            return {
                                ...s,
                                _qualText: qual,
                                _label: source.provider.label, 
                                _isPriority: source.provider.isPriority
                            };
                        });
                        allStreams = allStreams.concat(mappedStreams);
                    }
                } catch (err) {}
            }
        }
        
        allStreams.sort((a, b) => {
            if (a._label === 'Vavoo' && b._label === 'Mio') return -1; 
            if (a._label === 'Mio' && b._label === 'Vavoo') return 1;
            return 0;
        });

        // Remplace totalement les textes polluants (Legal, Hybride, etc.) par un format propre
        const finalStreams = allStreams.map((s, idx) => ({
            url: s.url,
            name: `▶ Source ${idx + 1}\n(${s._label})`,
            title: s._qualText
        }));
        
        res.json({ streams: finalStreams });
    } catch (err) {
        res.json({ streams: [] });
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
    await updateEPG(); 
    await updateStreams();
    setInterval(updateEPG, 3600000); 
});
