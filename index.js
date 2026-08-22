const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');

const app = express();
app.use(cors());

let isUpdatingEPG = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let epgData = {}; 
let channelsCache = {}; 

const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

// Liste noire : Les chaînes poubelles, VOD déguisées ou inutiles
const BLACKLIST = [
    'A LA CARTE', 'DISNEY PLUS', 'DISNEY+', 'NETFLIX', 'PRIME VIDEO', 'APPLE TV',
    'MULTISPORTS', 'TEST', 'MIRROR', 'BACKUP CHANNEL', 'VOD', 'EVENEMENT'
];

function parseConfig(encodedConfig) {
    try {
        if (!encodedConfig || encodedConfig === 'manifest.json') return { sources: [], epg: true };
        const jsonStr = Buffer.from(encodedConfig, 'base64').toString('utf8');
        return JSON.parse(jsonStr);
    } catch (e) {
        return { sources: [], epg: true };
    }
}

// === LE MOTEUR ETL (Extract, Transform, Load) ===
// Ce moteur crée l'ADN unique de chaque chaîne pour fusionner les doublons et appliquer la blacklist.
function getChannelData(rawName) {
    if (!rawName) return null;
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    // Nettoyage radical : on supprime les mots entre parenthèses, crochets et les balises parasites
    n = n.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ');
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'DIRECT', 'RAW', 'ACCESS', 'FR', 'FRENCH', 'FRANCE'];
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'gi'), ''); });
    
    // L'ADN absolu de la chaîne (uniquement lettres et chiffres attachés)
    let c = n.replace(/[^A-Z0-9]/g, '');
    if (!c || c.length < 2) return null;

    // --- LE VIDEUR (BLACKLIST STRICTE) ---
    if (c.includes('ALACARTE') || c.includes('MULTISPORTS') || c.includes('EVENEMENT') || 
        c.includes('TEST') || c.includes('MIRROR') || c.includes('DISNEYPLUS') || 
        c.includes('NETFLIX') || c.includes('PRIMEVIDEO') || c.includes('LIVEEVENT')) {
        return null; 
    }

    // --- ⚽ SPORTS (Fusion DAZN / Ligue 1 Absolue) ---
    if (c.startsWith('DAZN') || c.includes('LIGUE1') || c.includes('PASSLIGUE')) {
        let m = c.match(/\d+/g); 
        let num = m ? m[m.length-1] : '1';
        if (parseInt(num) > 8) return null; // Les canaux DAZN au-delà de 8 sont souvent des mires
        return { id: 'hyb_sport_dazn'+num, name: 'DAZN '+num, category: 'sports', index: 10 + parseInt(num) };
    }
    if (c.startsWith('BEINSPORT')) {
        let isMax = c.includes('MAX');
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        return { id: 'hyb_sport_bein' + (isMax?'max':'') + num, name: isMax ? 'beIN SPORTS MAX '+num : 'beIN SPORTS '+num, category: 'sports', index: isMax ? 60 + parseInt(num) : 50 + parseInt(num) };
    }
    if (c.startsWith('RMCSPORT')) {
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        return { id: 'hyb_sport_rmc'+num, name: 'RMC Sport '+num, category: 'sports', index: 90 + parseInt(num) };
    }
    if (c.startsWith('EUROSPORT')) {
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        return { id: 'hyb_sport_euro'+num, name: 'Eurosport '+num, category: 'sports', index: 120 + parseInt(num) };
    }
    if (c.startsWith('CANAL') && (c.includes('SPORT') || c.includes('FOOT') || c.includes('FORMULA1'))) {
        if (c.includes('SPORT360')) return { id: 'hyb_sport_cplussport360', name: 'Canal+ Sport 360', category: 'sports', index: 152 };
        if (c.includes('FOOT')) return { id: 'hyb_sport_cplusfoot', name: 'Canal+ Foot', category: 'sports', index: 151 };
        if (c.includes('FORMULA1')) return { id: 'hyb_sport_cplusf1', name: 'Canal+ Formula 1', category: 'sports', index: 153 };
        return { id: 'hyb_sport_cplussport', name: 'Canal+ Sport', category: 'sports', index: 150 };
    }
    if (c === 'LEQUIPE' || c === 'LEQUIPETV') return { id: 'hyb_sport_lequipe', name: "L'Équipe", category: 'sports', index: 160 };
    if (c.includes('OLTV') || c === 'OLPLAY') return { id: 'hyb_sport_oltv', name: 'OLTV', category: 'sports', index: 170 };
    if (c.includes('AUTOMOTO')) return { id: 'hyb_sport_automoto', name: 'Automoto', category: 'sports', index: 180 };
    if (c.includes('GOLF')) return { id: 'hyb_sport_golf', name: 'Golf Channel', category: 'sports', index: 181 };

    // --- 🍿 CINEMA (Dédoublonnage des Ciné+) ---
    if (c.startsWith('CINE') || c.startsWith('CINEPLUS')) {
        if (c.includes('PREMIER')) return { id: 'hyb_cine_premier', name: 'Ciné+ Premier', category: 'cinema', index: 11 };
        if (c.includes('FRISSON')) return { id: 'hyb_cine_frisson', name: 'Ciné+ Frisson', category: 'cinema', index: 12 };
        if (c.includes('EMOTION')) return { id: 'hyb_cine_emotion', name: 'Ciné+ Émotion', category: 'cinema', index: 13 };
        if (c.includes('FAMIZ')) return { id: 'hyb_cine_famiz', name: 'Ciné+ Famiz', category: 'cinema', index: 14 };
        if (c.includes('CLUB')) return { id: 'hyb_cine_club', name: 'Ciné+ Club', category: 'cinema', index: 15 };
        if (c.includes('CLASSIC')) return { id: 'hyb_cine_classic', name: 'Ciné+ Classic', category: 'cinema', index: 16 };
        return { id: 'hyb_cine_plus', name: 'Ciné+', category: 'cinema', index: 19 };
    }
    if (c === 'ACTION') return { id: 'hyb_cine_action', name: 'Action', category: 'cinema', index: 30 };
    if (c === 'POLARPLUS' || c === 'POLAR') return { id: 'hyb_cine_polar', name: 'Polar+', category: 'cinema', index: 31 };
    if (c === 'PARAMOUNT' || c === 'PARAMOUNTCHANNEL') return { id: 'hyb_cine_paramount', name: 'Paramount Channel', category: 'cinema', index: 32 };
    
    // --- 🎟️ CANAL+ (Les déclinaisons) ---
    if (c.startsWith('CANAL') && !c.includes('PLAY')) {
        if (c === 'CANALPLUS' || c === 'CANAL') return { id: 'hyb_canal_cplus', name: 'Canal+', category: 'canal', index: 1 };
        if (c.includes('CINEMA')) return { id: 'hyb_canal_cinema', name: 'Canal+ Cinéma', category: 'canal', index: 2 };
        if (c.includes('GRANDECRAN')) return { id: 'hyb_canal_grandecran', name: 'Canal+ Grand Écran', category: 'canal', index: 3 };
        if (c.includes('SERIES')) return { id: 'hyb_canal_series', name: 'Canal+ Séries', category: 'canal', index: 4 };
        if (c.includes('BOXOFFICE')) return { id: 'hyb_canal_boxoffice', name: 'Canal+ Box Office', category: 'canal', index: 5 };
        if (c.includes('DOC')) return { id: 'hyb_canal_docs', name: 'Canal+ Docs', category: 'canal', index: 11 };
        if (c.includes('KIDS')) return { id: 'hyb_canal_kids', name: 'Canal+ Kids', category: 'canal', index: 12 };
        if (c.includes('DECALE')) return { id: 'hyb_canal_decale', name: 'Canal+ Décalé', category: 'canal', index: 13 };
    }

    // --- 👶 JEUNESSE ---
    if (c === 'CARTOONNETWORK') return { id: 'hyb_jeu_cartoon', name: 'Cartoon Network', category: 'jeunesse', index: 1 };
    if (c === 'BOOMERANG') return { id: 'hyb_jeu_boom', name: 'Boomerang', category: 'jeunesse', index: 2 };
    if (c === 'BOING' || c === 'BOEING') return { id: 'hyb_jeu_boing', name: 'Boing', category: 'jeunesse', index: 3 };
    if (c.startsWith('DISNEYCHANNEL')) return { id: 'hyb_jeu_disney', name: 'Disney Channel', category: 'jeunesse', index: 4 };
    if (c === 'DISNEYJUNIOR') return { id: 'hyb_jeu_disneyjr', name: 'Disney Junior', category: 'jeunesse', index: 5 };
    if (c === 'NICKELODEON') return { id: 'hyb_jeu_nick', name: 'Nickelodeon', category: 'jeunesse', index: 6 };
    if (c === 'GULLI') return { id: 'hyb_jeu_gulli', name: 'Gulli', category: 'jeunesse', index: 7 };
    if (c === 'BABYTV') return { id: 'hyb_jeu_baby', name: 'Baby TV', category: 'jeunesse', index: 8 };

    // --- 🔬 DECOUVERTE ---
    if (c === 'NATIONALGEOGRAPHIC' || c === 'NATGEO') return { id: 'hyb_dec_natgeo', name: 'National Geographic', category: 'decouverte', index: 1 };
    if (c === 'NATIONALGEOGRAPHICWILD' || c === 'NATGEOWILD') return { id: 'hyb_dec_natgeowild', name: 'Nat Geo Wild', category: 'decouverte', index: 2 };
    if (c === 'PLANETEPLUS' || c === 'PLANETE') return { id: 'hyb_dec_planete', name: 'Planète+', category: 'decouverte', index: 3 };
    if (c === 'DISCOVERYCHANNEL' || c === 'DISCOVERY') return { id: 'hyb_dec_discovery', name: 'Discovery Channel', category: 'decouverte', index: 4 };
    if (c === 'USHUAIA' || c === 'USHUAIATV') return { id: 'hyb_dec_ushuaia', name: 'Ushuaïa TV', category: 'decouverte', index: 5 };
    if (c === 'HISTOIRE' || c === 'HISTOIRETV') return { id: 'hyb_dec_histoire', name: 'Histoire TV', category: 'decouverte', index: 6 };

    // --- 📰 INFO ---
    if (c === 'BFMTV') return { id: 'hyb_info_bfm', name: 'BFMTV', category: 'info', index: 1 };
    if (c === 'CNEWS') return { id: 'hyb_info_cnews', name: 'CNews', category: 'info', index: 2 };
    if (c === 'LCI') return { id: 'hyb_info_lci', name: 'LCI', category: 'info', index: 3 };
    if (c === 'FRANCEINFO') return { id: 'hyb_info_frinfo', name: 'France Info', category: 'info', index: 4 };

    // --- 📺 TNT (Généralistes FR) ---
    if (c === 'TF1') return { id: 'hyb_tnt_tf1', name: 'TF1', category: 'tnt', index: 1 };
    if (c === 'FRANCE2') return { id: 'hyb_tnt_fr2', name: 'France 2', category: 'tnt', index: 2 };
    if (c === 'FRANCE3') return { id: 'hyb_tnt_fr3', name: 'France 3', category: 'tnt', index: 3 };
    if (c === 'FRANCE4') return { id: 'hyb_tnt_fr4', name: 'France 4', category: 'tnt', index: 4 };
    if (c === 'FRANCE5') return { id: 'hyb_tnt_fr5', name: 'France 5', category: 'tnt', index: 5 };
    if (c === 'M6') return { id: 'hyb_tnt_m6', name: 'M6', category: 'tnt', index: 6 };
    if (c === 'ARTE') return { id: 'hyb_tnt_arte', name: 'Arte', category: 'tnt', index: 7 };
    if (c === 'C8') return { id: 'hyb_tnt_c8', name: 'C8', category: 'tnt', index: 8 };
    if (c === 'W9') return { id: 'hyb_tnt_w9', name: 'W9', category: 'tnt', index: 9 };
    if (c === 'TMC') return { id: 'hyb_tnt_tmc', name: 'TMC', category: 'tnt', index: 10 };
    if (c === 'TFX') return { id: 'hyb_tnt_tfx', name: 'TFX', category: 'tnt', index: 11 };
    if (c === 'NRJ12') return { id: 'hyb_tnt_nrj', name: 'NRJ 12', category: 'tnt', index: 12 };

    // --- AUTRES (Ce qui n'est pas reconnu mais qui passe les filtres) ---
    // On recrée un nom lisible avec des majuscules propres
    let prettyName = n.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase()).trim();
    return {
        id: 'hyb_id_' + c,
        name: prettyName,
        category: 'autres',
        index: 500
    };
}

// Fonction utilitaire pour lier le nom de la chaîne EPG à notre système
function toSyncId(rawName) {
    if (!rawName) return '';
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return n.replace(/[^A-Z0-9]/g, ''); 
}

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

// Téléchargement et analyse en continu du programme TV
async function fetchAndParseEPG(url, isGz) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await axios.get(url, {
                responseType: 'stream',
                timeout: 60000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
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
                        localChannels[idM[1]] = toSyncId(nameM[1]); 
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

// Extraction simultanée des catalogues
async function fetchAddonCatalog(providerUrl) {
    let allMetas = [];
    try {
        let cleanUrl = providerUrl.trim();
        if (!cleanUrl.endsWith('manifest.json')) {
            cleanUrl = cleanUrl.replace(/\/$/, '') + '/manifest.json';
        }
        const base = cleanUrl.replace(/\/manifest\.json$/, '');

        const manifestRes = await axios.get(cleanUrl, { timeout: 4000 });
        const catalogs = manifestRes.data.catalogs || [];
        
        const catalogPromises = catalogs.map(async (catalog) => {
            let catMetas = [];
            let skip = 0; let hasMore = true; let pageCount = 0;
            while (hasMore && pageCount < 4) {
                pageCount++;
                try {
                    let url = skip > 0 ? `${base}/catalog/${catalog.type}/${catalog.id}/skip=${skip}.json` : `${base}/catalog/${catalog.type}/${catalog.id}.json`;
                    let res = await axios.get(url, { timeout: 4000 });
                    if (res.data && res.data.metas && res.data.metas.length > 0) {
                        catMetas.push(...res.data.metas);
                        skip += res.data.metas.length;
                    } else {
                        hasMore = false;
                    }
                } catch (e) {
                    hasMore = false;
                }
            }
            return catMetas;
        });

        const results = await Promise.all(catalogPromises);
        let seenIds = new Set();
        results.flat().forEach(m => {
            if (m && m.id && !seenIds.has(m.id)) {
                seenIds.add(m.id);
                allMetas.push({ ...m, _providerBase: base });
            }
        });
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
        let cleanUrl = providerUrl.trim();
        if (!cleanUrl.endsWith('manifest.json')) cleanUrl = cleanUrl.replace(/\/$/, '') + '/manifest.json';
        const base = cleanUrl.replace(/\/manifest\.json$/, '');

        metas.forEach(meta => {
            let rawName = meta.name || '';
            let channelInfo = getChannelData(rawName);
            
            // On ignore le flux si la chaîne est blacklistée (channelInfo === null)
            if (!channelInfo) return; 

            const id = channelInfo.id;

            if (!tempChannelsMap[id]) {
                tempChannelsMap[id] = { 
                    id: id, 
                    name: channelInfo.name, 
                    displayName: channelInfo.name, 
                    category: channelInfo.category,
                    sortIndex: channelInfo.index,
                    sources: [], 
                    poster: meta.poster || DEFAULT_POSTER 
                };
            } else if (meta.poster && tempChannelsMap[id].poster === DEFAULT_POSTER) {
                tempChannelsMap[id].poster = meta.poster; 
            }
            
            const sourceExists = tempChannelsMap[id].sources.find(s => s.metaId === meta.id && s.providerBase === base);
            if (!sourceExists) {
                tempChannelsMap[id].sources.push({ 
                    type: 'addon', 
                    metaId: meta.id, 
                    providerBase: base,
                    sourceIndex: i 
                });
            }
        });
    }

    let tempChannelsData = Object.values(tempChannelsMap).filter(ch => ch.sources.length > 0);

    // Tri interne par catégorie puis par nom
    tempChannelsData.sort((a, b) => {
        if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
        return a.displayName.localeCompare(b.displayName);
    });

    channelsCache[cacheKey] = { data: tempChannelsData, timestamp: Date.now() };
    return tempChannelsData;
}

// === INTERFACE WEB ===
app.get('/', async (req, res) => {
    let sourcesParam = req.query.sources;
    let sourcesList = sourcesParam ? sourcesParam.split(',') : ['', ''];
    let epgCount = Object.keys(epgData).length;
    let epgStatus = epgCount > 0 ? `✅ Programme téléchargé pour <b>${epgCount}</b> chaînes` : `⏳ Programme TV en cours de chargement...`;

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
                <b>HybridTV</b> centralise vos sources de flux en une véritable bibliothèque francophone thématisée et triée sur le volet. Fini le désordre : tout est classé par catégories logiques (TNT, Sport, Cinéma, etc.) avec une sélection automatique de la meilleure qualité et des sources les plus stables selon vos priorités.
            </div>
            
            <div class="section">
                <label style="font-size: 14px; color: #ccc; font-weight: bold;">Sources de flux (manifest.json) :</label><br>
                <span style="font-size: 11px; color: #777; display: block; margin-bottom: 12px;">L'ordre de priorité s'effectue du haut vers le bas (la source n°1 est interrogée en premier).</span>
                <div id="sourcesContainer"></div>
                <button type="button" onclick="addSourceField()" class="btn btn-small">+ Ajouter une source</button>
            </div>

            <div class="section">
                <label style="font-size: 14px; color: #ccc; font-weight: bold;">🔑 Code de Sauvegarde / Partage :</label><br>
                <span style="font-size: 12px; color: #777;">Copiez ce code pour sauvegarder vos sources, ou collez un code reçu pour l'importer :</span>
                <textarea id="exportTokenBox" class="export-box" placeholder="Code de configuration..."></textarea>
                <button type="button" onclick="importToken()" class="btn btn-small" style="margin-top: 5px;">📥 Importer le code</button>
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
                        <input type="text" id="src_\${index}" value="\${src}" placeholder="https://votre-source.com/manifest.json">
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
                updateExportToken();
            }

            function updateExportToken() {
                const validSources = sources.filter(s => s.length > 0);
                const isEpg = document.getElementById("epgToggle").checked;
                const configObj = { sources: validSources, epg: isEpg };
                const token = btoa(JSON.stringify(configObj));
                document.getElementById('exportTokenBox').value = token;
            }

            function importToken() {
                const token = document.getElementById('exportTokenBox').value.trim();
                try {
                    const jsonStr = atob(token);
                    const config = JSON.parse(jsonStr);
                    if (config.sources && Array.isArray(config.sources)) {
                        sources = config.sources;
                        if (sources.length === 0) sources = ['', ''];
                        if (config.epg !== undefined) document.getElementById("epgToggle").checked = config.epg;
                        renderSources();
                        alert("Configuration importée avec succès !");
                    } else {
                        alert("Code invalide.");
                    }
                } catch(e) {
                    alert("Erreur : Ce code de sauvegarde est corrompu ou invalide.");
                }
            }

            function generateLink() {
                saveInputs();
                const validSources = sources.filter(s => s.length > 0);
                if (validSources.length === 0) {
                    alert("Veuillez entrer au moins un lien de source !");
                    return;
                }
                const token = document.getElementById('exportTokenBox').value;
                const base = window.location.protocol + "//" + window.location.host;
                const url = base + "/" + token + "/manifest.json";
                
                document.getElementById("manifestLink").value = url;
                alert("Lien généré avec succès !");
            }

            let savedSources = localStorage.getItem('hybrid_sources');
            if (savedSources && !${sourcesParam ? 'true' : 'false'}) {
                sources = JSON.parse(savedSources);
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

app.get('/:config/manifest.json', (req, res) => {
    const config = parseConfig(req.params.config);
    const confName = config.epg ? 'epg-on' : 'epg-off';
    
    res.setHeader('Cache-Control', 'max-age=86400, public'); 
    res.json({
        id: 'org.hybridtv.meta.' + confName, 
        version: '1.2.1',
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
            { type: 'tv', id: 'autres', name: '📂 Autres' }
        ]
    });
});

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

    const validCatalogs = ['tnt', 'info', 'jeunesse', 'decouverte', 'cinema', 'musique', 'canal', 'sports', 'autres'];
    if (!validCatalogs.includes(requestedCatalog)) return res.json({ metas: [] });
    
    const filteredChannels = channelsData.filter(ch => ch.category === requestedCatalog);
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
        let streamPromises = channel.sources.map(async (source) => {
            try {
                const streamRes = await axios.get(`${source.providerBase}/stream/tv/${source.metaId}.json`, {
                    headers: { 'X-Forwarded-For': clientIp }, timeout: 4000 
                });
                if (streamRes.data && streamRes.data.streams) {
                    return streamRes.data.streams.map(s => {
                        let qual = "Qualité Standard (SD)";
                        let score = 0;
                        let up = (s.title || '').toUpperCase() + ' ' + (s.name || '').toUpperCase();
                        
                        // Notation de la Qualité Vidéo
                        if (up.includes('4K') || up.includes('2160') || up.includes('UHD')) { qual = "Ultra Haute Qualité (4K)"; score += 600; } 
                        else if (up.includes('FHD') || up.includes('1080')) { qual = "Haute Qualité (FHD)"; score += 400; } 
                        else if (up.includes('HD') || up.includes('720')) { qual = "Haute Qualité (HD)"; score += 200; } 
                        else { score += 50; }

                        // LA PRIORITÉ ABSOLUE AU FRANÇAIS (+5000 points)
                        if (up.match(/\bFR\b/) || up.match(/\bVF\b/) || up.includes('FRENCH') || up.includes('FRANCE')) {
                            score += 5000;
                        }

                        // LA GUILLOTINE DES FLUX MORTS OU DE SECOURS (-3000 points)
                        if (up.includes('BACKUP') || up.includes('SECOURS') || up.includes('ALT') || up.includes('TEST')) {
                            score -= 3000;
                        }
                        
                        // Bonus lié à l'ordre des sources configuré par l'utilisateur
                        score += (10 - source.sourceIndex) * 100;

                        return { ...s, _qualText: qual, _score: score };
                    });
                }
            } catch (err) {}
            return [];
        });

        let results = await Promise.all(streamPromises);
        let allStreams = [].concat(...results);

        // Tri mathématique des flux par score décroissant
        allStreams.sort((a, b) => b._score - a._score);
        
        // Coupe stricte aux 8 meilleurs flux pour une interface rapide
        const limitedStreams = allStreams.slice(0, 8);

        const finalStreams = limitedStreams.map((s, idx) => ({
            url: s.url, name: `▶ Source ${idx + 1}`, title: s._qualText
        }));
        
        res.json({ streams: finalStreams });
    } catch (err) { res.json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`HybridTV Server démarré sur le port ${PORT}`);
    updateEPG(); 
    setInterval(updateEPG, 3600000); 
});
