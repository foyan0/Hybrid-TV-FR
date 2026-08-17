const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

let isUpdating = true;

// --- LES SOURCES ---
const ADDON_PROVIDERS = [
    { id: 'vavoo', base: 'https://tvvoo.hayd.uk/cfg-fr', label: 'Vavoo', isPriority: true },
    { id: 'mio', base: 'https://tvmio.ooguy.com/eyJjb3VudHJpZXMiOlsiRlIiLCJCRV9GUiJdLCJjYXRlZ29yaWVzIjp7IkZSIjpbIkdlbmVyYWwg8J+7oiIsIlNwb3J0cyDimq3igIsiLCJEb2N1bWVudGFpcmVzIPCfijrQuiIsIkZpbG1zIPCfjqwiLCJJbmZvcm1hdGlvbnMg8J+7oiIsIkVuZmFudHMgv5G2IiwiTXVzaWMg8J+OtSJdfSwiZW5hYmxlU2VhcmNoIjpmYWxzZX0', label: 'Mio', isPriority: false }
];

let channelsData = [];
let epgData = {}; 
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

// === NORMALISATION (Supprime les TV entre parenthèses, les tags, etc.) ===
function normalizeChannelName(rawName) {
    let clean = rawName.toUpperCase();
    clean = clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    clean = clean.replace(/\s*\([Tt][Vv]\)\s*/g, ''); // Suppression stricte de (TV)
    clean = clean.replace(/^(?:FR|BE|CH|CA|VIP)\s*[:|/-]+\s*/, '');
    clean = clean.replace(/^FR\s+/, '');
    clean = clean.replace(/\+/g, ' PLUS '); 
    clean = clean.replace(/\[.*?\]|\(.*?\)/g, ' '); 
    
    const badWords = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'VAVOO', 'DIRECT', 'RAW', 'ACCESS'];
    clean = clean.replace(/[^A-Z0-9+ ]/g, ' ');
    badWords.forEach(w => {
        clean = clean.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
    });

    clean = clean.replace(/\s+/g, ' ').trim();
    let displayName = clean.replace(/PLUS/g, '+').replace(/\s+/g, ' ').trim();

    if (displayName === 'CNEWS' || displayName.includes('C NEWS')) return 'CNews';
    if (displayName === 'LCN') return 'LCN';
    if (displayName === 'CARTOON NETWORK') return 'Cartoon Network';
    if (displayName === 'CARTOONITO') return 'Cartoonito';
    if (displayName.includes('EQUIPE')) return "L'Équipe"; 

    // CANAL+ EXACT
    if (displayName.includes('CANAL J')) return 'Canal J';
    if (displayName.includes('CANAL+ KIDS') || displayName.includes('CANAL KIDS')) return 'Canal+ Kids';
    if (displayName.includes('CANAL+ FOOT') || displayName === 'FOOT+') return 'Canal+ Foot';
    if (displayName.includes('CANAL+ SPORT 360') || displayName === 'CANAL+ 360') return 'Canal+ Sport 360';
    if (displayName.includes('CANAL+ SPORT')) return 'Canal+ Sport';
    if (displayName.includes('CANAL+ CINEMA')) return 'Canal+ Cinéma';
    if (displayName.includes('CANAL+ GRAND ECRAN')) return 'Canal+ Grand Écran';
    if (displayName.includes('CANAL+ BOX OFFICE')) return 'Canal+ Box Office';
    if (displayName.includes('CANAL+ SERIES')) return 'Canal+ Séries';
    if (displayName.includes('CANAL+ DOCS')) return 'Canal+ Docs';
    if (displayName.includes('CANAL+ FAMILY')) return 'Canal+ Family';
    if (displayName.includes('CANAL+ DECALE')) return 'Canal+ Décalé';
    if (displayName.includes('CANAL+ 4K') || displayName.includes('CANAL ULTRA')) return 'Canal+ 4K';
    if (displayName === 'CANAL+' || displayName === 'CANAL +') return 'Canal+';

    // JEUNESSE EXACT
    if (displayName.includes('DISNEY CHANNEL') && displayName.includes('1')) return 'Disney Channel +1';
    if (displayName.includes('DISNEY CHANNEL')) return 'Disney Channel';
    if (displayName.includes('DISNEY XD')) return 'Disney XD';
    if (displayName.includes('DISNEY JUNIOR') || displayName.includes('DISNEY JR')) return 'Disney Junior';
    if (displayName.includes('DISNEY CINEMA')) return 'Disney Cinéma';
    if (displayName.includes('NICKELODEON') && (displayName.includes('1') || displayName.includes('14') || displayName.includes('+'))) return 'Nickelodeon +1';
    if (displayName.includes('NICKELODEON TEEN')) return 'Nickelodeon Teen';
    if (displayName.includes('NICKELODEON JUNIOR')) return 'Nickelodeon Junior';
    if (displayName === 'NICKELODEON') return 'Nickelodeon';
    if (displayName.includes('GAME ONE') || displayName === 'J ONE') return 'Game One';
    if (displayName === 'GULLI') return 'Gulli';
    if (displayName.includes('BOOMERANG')) return 'Boomerang';

    // AUTRES
    if (displayName === 'TF1') return 'TF1';
    if (displayName === 'FRANCE 2') return 'France 2';
    if (displayName === 'FRANCE 3') return 'France 3';
    if (displayName === 'FRANCE 4') return 'France 4';
    if (displayName === 'FRANCE 5') return 'France 5';
    if (displayName === 'M6') return 'M6';
    
    return displayName.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()).replace('+', '+ ');
}

// === PLACEMENTS ET TRI MULTIPLES ===
function getChannelPlacements(name) {
    const n = name.toUpperCase();
    let placements = []; 

    if (n.includes('BFM') || n === 'CNEWS' || n === 'LCI' || n === 'FRANCE INFO' || n === 'FRANCE 24' || n === 'EURONEWS' || n.includes('METEO') || n.includes('20 MINUTES') || n === 'LCN') {
        let idx = 50;
        if(n.includes('TF1')) idx = 1;
        else if(n.includes('BFMTV')) idx=2;
        else if(n === 'CNEWS') idx=3;
        else if(n === 'LCI') idx=4;
        else if(n === 'FRANCE INFO') idx=5;
        else if(n === 'FRANCE 24') idx=6;
        else if(n === 'BFM BUSINESS') idx=7;
        else if(n === 'EURONEWS') idx=8;
        else if(n.includes('METEO')) idx=9;
        placements.push({ category: 'vavoo_info', index: idx });
    }

    let jeuIdx = -1;
    if(n==='CARTOON NETWORK') jeuIdx=1;
    if(n==='DISNEY CHANNEL') jeuIdx=2;
    if(n==='GULLI') jeuIdx=3;
    if(n==='NICKELODEON') jeuIdx=4;
    if(n==='GAME ONE') jeuIdx=5;
    if(n==='DISNEY XD') jeuIdx=6;
    if(n==='BOOMERANG') jeuIdx=7;
    if(n==='CANAL+ KIDS') jeuIdx=8;
    if(n==='CANAL J') jeuIdx=9;
    if(n==='DISNEY JUNIOR') jeuIdx=10;
    if(n==='NICKELODEON TEEN') jeuIdx=11;
    if(n==='DISNEY CHANNEL +1') jeuIdx=50; 
    if(n==='NICKELODEON +1') jeuIdx=51; 
    
    if(jeuIdx !== -1) {
        placements.push({ category: 'vavoo_jeunesse', index: jeuIdx });
    } else if (n.includes('TIJI') || n.includes('TELETOON') || n.includes('PIWI')) {
        placements.push({ category: 'vavoo_jeunesse', index: 30 });
    }

    let canIdx = -1;
    if(n==='CANAL+') canIdx=1;
    if(n==='CANAL+ FOOT') canIdx=2;
    if(n==='CANAL+ SPORT') canIdx=3;
    if(n==='CANAL+ SPORT 360') canIdx=4;
    if(n==='CANAL+ FORMULA 1') canIdx=5;
    if(n==='CANAL+ CINEMA') canIdx=6;
    if(n==='CANAL+ GRAND ECRAN') canIdx=7;
    if(n==='CANAL+ BOX OFFICE') canIdx=8;
    if(n==='CANAL+ SERIES') canIdx=9;
    if(n==='CANAL+ FAMILY') canIdx=10;
    if(n==='CANAL+ DOCS') canIdx=11;
    if(n==='CANAL J') canIdx=12;
    if(n==='CANAL+ KIDS') canIdx=13;
    if(n==='CANAL+ 4K') canIdx=14;
    if(n==='CANAL+ DECALE') canIdx=15;
    if(n.includes('CSTAR HITS')) canIdx=16;
    if(canIdx !== -1) {
        placements.push({ category: 'vavoo_canal', index: canIdx });
    }

    if (n.includes('DISCOVERY') || n.includes('CRIME DISTRICT') || n.includes('USHUAIA') || n.includes('CHASSE') || n.includes('ANIMAUX') || n.includes('STAR CHANNEL')) {
        let decIndex = 10;
        if (n.includes('DISCOVERY CHANNEL')) decIndex = 1;
        if (n.includes('DISCOVERY')) decIndex = 2;
        if (n.includes('USHUAIA')) decIndex = 3;
        if (n.includes('CRIME DISTRICT')) decIndex = 4;
        if (n.includes('CHASSE')) decIndex = 5;
        if (n.includes('ANIMAUX')) decIndex = 6;
        if (n.includes('STAR CHANNEL')) decIndex = 7;
        placements.push({ category: 'vavoo_decouverte', index: decIndex });
    }

    if (n.includes('PARAMOUNT') || n.includes('WARNER') || n.includes('ACTION') || n.includes('TCM') || n.includes('OCS') || n.includes('CINE+')) {
        let cinIndex = 10;
        if (n.includes('PARAMOUNT')) cinIndex = 1;
        if (n.includes('WARNER')) cinIndex = 2;
        if (n.includes('ACTION')) cinIndex = 3;
        if (n.includes('TCM')) cinIndex = 4;
        placements.push({ category: 'vavoo_cinema', index: cinIndex });
    }

    if (n.includes('MCM') || n.includes('MEZZO') || n.includes('MTV') || n.includes('NRJ HITS')) {
        placements.push({ category: 'vavoo_musique', index: 10 });
    }

    let spoIdx = -1;
    if(n.startsWith('BEIN SPORTS')) spoIdx=100;
    if(n.startsWith('RMC SPORT') && !n.includes('MULTICANAL')) spoIdx=110;
    if(n.startsWith('EUROSPORT')) spoIdx=120;
    if(n.startsWith('DAZN')) spoIdx=130;
    if(n.startsWith('AUTOMOTO')) spoIdx=140;
    if(n.includes('GOLF+') || n.includes('GOLF CHANNEL')) spoIdx=150;
    if(n.includes('EQUIDIA')) spoIdx=160;
    if(n==='CANAL+ SPORT' || n==='CANAL+ FOOT' || n==='CANAL+ FORMULA 1' || n==='CANAL+ SPORT 360') spoIdx=250;
    if(spoIdx !== -1) placements.push({ category: 'vavoo_sports', index: spoIdx });

    let tntIdx = -1;
    if(n==='TF1') tntIdx=1;
    if(n==='FRANCE 2') tntIdx=2;
    if(n==='FRANCE 3') tntIdx=3;
    if(n==='FRANCE 4') tntIdx=4;
    if(n==='FRANCE 5') tntIdx=5;
    if(n==='M6') tntIdx=6;
    if(n==='ARTE') tntIdx=7;
    if(n==='C8') tntIdx=8;
    if(n==='W9') tntIdx=9;
    if(n==='TMC') tntIdx=10;
    if(n==='TFX') tntIdx=11;
    if(n==='NRJ 12') tntIdx=12;
    if(n.includes('LCP') || n.includes('SENAT')) tntIdx=13;
    if(n==='CSTAR') tntIdx=17;
    if(n==='GULLI') tntIdx=18;
    if(n.includes('TF1 SERIES')) tntIdx=20;
    if(n==="L'ÉQUIPE") tntIdx=21;
    if(n==='6TER') tntIdx=22;
    if(n==='RMC STORY') tntIdx=23;
    if(n==='RMC DECOUVERTE') tntIdx=24;
    if(n==='CHERIE 25') tntIdx=25;
    
    if(tntIdx !== -1) placements.push({ category: 'vavoo_tnt', index: tntIdx });

    if (placements.length === 0) {
        placements.push({ category: 'vavoo_autres', index: 500 });
    }

    return placements;
}

// === LECTEUR EPG BLINDÉ (Multi-sources, Anti-Bug et Fuseau Paris) ===
async function updateEPG() {
    const urls = [
        'https://xmltv.ch/xmltv/xmltv-tnt.xml',
        'https://xmltv.ch/xmltv/xmltv-francophone.xml'
    ];
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
                    
                    const startStr = startMatch[1];
                    const year = startStr.substring(0,4);
                    const month = startStr.substring(4,6);
                    const day = startStr.substring(6,8);
                    const hour = startStr.substring(8,10);
                    const min = startStr.substring(10,12);
                    const sec = startStr.substring(12,14);
                    
                    let offset = startStr.substring(15).trim() || '+0200';
                    if (!offset.includes(':')) offset = offset.slice(0,3) + ':' + offset.slice(3);

                    const isoStart = `${year}-${month}-${day}T${hour}:${min}:${sec}${offset}`;
                    
                    const stopStr = stopMatch[1];
                    const isoStop = `${stopStr.substring(0,4)}-${stopStr.substring(4,6)}-${stopStr.substring(6,8)}T${stopStr.substring(8,10)}:${stopStr.substring(10,12)}:${stopStr.substring(12,14)}${offset}`;

                    const startTs = new Date(isoStart).getTime();
                    const stopTs = new Date(isoStop).getTime();

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

async function fetchAddonCatalog(provider) {
    let allMetas = [];
    try {
        const manifestRes = await axios.get(`${provider.base}/manifest.json`, { timeout: 10000 });
        for (const catalog of manifestRes.data.catalogs) {
            let skip = 0;
            let hasMore = true;
            let maxPages = 15;
            let pageCount = 0;
            let seenIds = new Set(); 
            while (hasMore && pageCount < maxPages) {
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
                    channelsMap[id] = { id, name: dName, sources: [], poster: meta.poster || DEFAULT_POSTER };
                }
                
                const sourceExists = channelsMap[id].sources.find(s => s.metaId === meta.id && s.provider && s.provider.id === provider.id);
                if (!sourceExists) channelsMap[id].sources.push({ type: 'addon', metaId: meta.id, provider: provider });
                
                if (meta.poster && channelsMap[id].poster === DEFAULT_POSTER) {
                    channelsMap[id].poster = meta.poster;
                }
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

// === NOUVELLE PAGE WEB POUR NUVIO ===
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
            <p>Votre add-on de streaming TV unifié et épuré. <br>Profitez d'un guide TV en temps réel (EPG) sur la majorité des chaînes, le tout sans doublons ni textes polluants.</p>
            
            <a href="${stremioUrl}" class="btn">▶ Ajouter à Stremio</a>
            <button onclick="copyLink()" class="btn btn-secondary">📋 Copier pour Nuvio</button>
            
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
                alert("Lien copié avec succès ! Allez dans Nuvio pour l'ajouter.");
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.hybridproxy.fr.live.v38', 
        version: '38.0.0',
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
            return a.name.localeCompare(b.name);
        });

    const paginatedMetas = filteredChannels.slice(skip, skip + 100).map(ch => ({
        id: ch.id,
        type: 'tv',
        name: ch.name,
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
    
    let descriptionText = "";
    
    // Recherche stricte et robuste dans notre EPG maison
    const target = channel.name;
    let currentEpg = epgData[target];
    if (!currentEpg) {
        const foundKey = Object.keys(epgData).find(k => k.toUpperCase() === target.toUpperCase());
        if (foundKey) currentEpg = epgData[foundKey];
    }

    if (currentEpg) {
        const now = Date.now();
        const currentProg = currentEpg.find(p => now >= p.start && now <= p.stop);
        if (currentProg) {
            descriptionText = `🔴 EN DIRECT : ${currentProg.title}`;
            if (currentProg.desc) {
                descriptionText += `\n\n${currentProg.desc}`;
            }
        }
    }

    res.json({
        meta: {
            id: channel.id,
            type: 'tv',
            name: channel.name,
            poster: channel.poster,
            posterShape: 'square',
            description: descriptionText // Vide si aucun programme TV, sans aucun texte parasite
        }
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
                        const mappedStreams = streamRes.data.streams.map(s => ({
                            ...s,
                            _score: getStreamScore(s.title),
                            _label: source.provider.label, 
                            _isPriority: source.provider.isPriority
                        }));
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
            url: s.url,
            title: `[${s._label}] Choix ${idx + 1} | ${s.title.replace(/\[.*?\]\s*/g, '') || 'Auto'}`
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
