const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const TVVOO_BASE = 'https://tvvoo.hayd.uk/cfg-fr';
let channelsData = []; 
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

function normalizeChannelName(rawName) {
    let clean = rawName.toUpperCase();

    clean = clean.replace(/^(?:FR|BE|CH|CA|VIP)\s*[:|/-]+\s*/, '');
    clean = clean.replace(/^FR\s+/, '');
    
    clean = clean.replace(/\+/g, ' PLUS '); 
    clean = clean.replace(/\[.*?\]|\(.*?\)/g, ' '); 
    
    const badWords = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'VAVOO', 'DIRECT', 'RAW', 'ACCESS'];
    badWords.forEach(w => {
        clean = clean.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
    });

    clean = clean.replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    let displayName = clean.replace(/PLUS/g, '+').replace(/\s+/g, ' ').trim();

    if (displayName.includes('EQUIPE')) return "L'Équipe"; 
    if (displayName.includes('DISNEY')) return 'Disney'; 
    
    if (displayName === 'CANAL' || displayName === 'CANAL LIVE' || displayName === 'CANAL PLUS' || displayName === 'CANAL+') return 'Canal+';
    if (displayName.startsWith('CANAL+')) {
        return displayName.replace('CANAL+', 'Canal+'); 
    }

    if (displayName.includes('RMC SPORT')) {
        let rmcMatch = displayName.match(/RMC SPORT\s*(\d+)/);
        if (rmcMatch) return `RMC Sport ${rmcMatch[1]}`;
        if (displayName.includes('LIVE') || displayName.includes('MULT')) return 'RMC Sport (Multicanal)';
        return 'RMC Sport';
    }

    if (displayName.includes('BEIN SPORT')) {
        let beinMatch = displayName.match(/BEIN SPORTS?\s*(\d+)/);
        if (beinMatch) return `beIN SPORTS ${beinMatch[1]}`;
        if (displayName.includes('MAX')) return 'beIN SPORTS MAX (Multicanal)';
        return 'beIN SPORTS';
    }

    if (displayName.includes('EUROSPORT')) {
        let euroMatch = displayName.match(/EUROSPORT\s*(\d+)/);
        if (euroMatch) return `Eurosport ${euroMatch[1]}`;
        if (displayName.includes('360')) return 'Eurosport 360 (Multicanal)';
        return 'Eurosport';
    }

    if (displayName.includes('DAZN')) {
        let daznMatch = displayName.match(/DAZN\s*(\d+)/);
        if (daznMatch) return `DAZN ${daznMatch[1]}`;
        return 'DAZN';
    }

    if (displayName === 'FRANCE 2') return 'France 2';
    if (displayName === 'FRANCE 3') return 'France 3';
    if (displayName === 'FRANCE 4') return 'France 4';
    if (displayName === 'FRANCE 5') return 'France 5';
    if (displayName.includes('FRANCE INFO')) return 'France Info';
    
    return displayName;
}

// Nouvelle fonction qui attribue à la fois l'ordre ET le catalogue (TNT, Sports, Premium, Autres)
function getChannelMeta(channelName) {
    const n = channelName.toUpperCase();
    
    // --- CATALOGUE 1 : TNT ---
    if (n === 'TF1') return { index: 1, category: 'vavoo_tnt' };
    if (n === 'FRANCE 2') return { index: 2, category: 'vavoo_tnt' };
    if (n === 'FRANCE 3') return { index: 3, category: 'vavoo_tnt' };
    if (n === 'CANAL+') return { index: 4, category: 'vavoo_tnt' };
    if (n === 'FRANCE 5') return { index: 5, category: 'vavoo_tnt' };
    if (n === 'M6') return { index: 6, category: 'vavoo_tnt' };
    if (n === 'ARTE') return { index: 7, category: 'vavoo_tnt' };
    if (n === 'C8') return { index: 8, category: 'vavoo_tnt' };
    if (n === 'W9') return { index: 9, category: 'vavoo_tnt' };
    if (n === 'TMC') return { index: 10, category: 'vavoo_tnt' };
    if (n === 'TFX') return { index: 11, category: 'vavoo_tnt' };
    if (n === 'NRJ 12' || n === 'NRJ12') return { index: 12, category: 'vavoo_tnt' };
    if (n.includes('LCP') || n.includes('SENAT')) return { index: 13, category: 'vavoo_tnt' };
    if (n === 'FRANCE 4') return { index: 14, category: 'vavoo_tnt' };
    if (n.includes('BFM')) return { index: 15, category: 'vavoo_tnt' };
    if (n.includes('CNEWS')) return { index: 16, category: 'vavoo_tnt' };
    if (n.includes('CSTAR')) return { index: 17, category: 'vavoo_tnt' };
    if (n === 'GULLI') return { index: 18, category: 'vavoo_tnt' };
    if (n.includes('TF1 SERIES')) return { index: 20, category: 'vavoo_tnt' };
    if (n === "L'ÉQUIPE") return { index: 21, category: 'vavoo_tnt' };
    if (n === '6TER') return { index: 22, category: 'vavoo_tnt' };
    if (n.includes('RMC STORY')) return { index: 23, category: 'vavoo_tnt' };
    if (n.includes('RMC DECOUVERTE')) return { index: 24, category: 'vavoo_tnt' };
    if (n.includes('CHERIE 25')) return { index: 25, category: 'vavoo_tnt' };
    if (n === 'LCI') return { index: 26, category: 'vavoo_tnt' };
    if (n.includes('FRANCE INFO')) return { index: 27, category: 'vavoo_tnt' };

    // --- CATALOGUE 2 : SPORTS ---
    if (n.startsWith('BEIN SPORTS')) return { index: 101, category: 'vavoo_sports' };
    if (n.startsWith('RMC SPORT')) return { index: 102, category: 'vavoo_sports' };
    if (n.startsWith('DAZN')) return { index: 103, category: 'vavoo_sports' };
    if (n.startsWith('EUROSPORT')) return { index: 104, category: 'vavoo_sports' };
    if (n.startsWith('CANAL+ SPORT')) return { index: 105, category: 'vavoo_sports' };
    if (n.startsWith('AUTOMOTO')) return { index: 106, category: 'vavoo_sports' };
    if (n.startsWith('GOLF+')) return { index: 107, category: 'vavoo_sports' };
    if (n.includes('SPORT')) return { index: 199, category: 'vavoo_sports' };

    // --- CATALOGUE 3 : CHAINES PAYANTES / PREMIUM ---
    if (n.startsWith('CANAL+')) return { index: 201, category: 'vavoo_premium' }; 
    if (n.startsWith('CINE+')) return { index: 202, category: 'vavoo_premium' };
    if (n.startsWith('OCS')) return { index: 203, category: 'vavoo_premium' };
    if (n === 'DISNEY') return { index: 204, category: 'vavoo_premium' };

    // --- CATALOGUE 4 : AUTRES ---
    return { index: 999, category: 'vavoo_autres' };
}

async function updateStreams() {
    try {
        console.log('[TvVoo Proxy] Récupération, filtrage et création des sous-catalogues...');
        const manifestRes = await axios.get(`${TVVOO_BASE}/manifest.json`, { timeout: 10000 });
        const catalogId = manifestRes.data.catalogs[0].id;
        const catalogRes = await axios.get(`${TVVOO_BASE}/catalog/tv/${catalogId}.json`, { timeout: 15000 });
        const metas = catalogRes.data.metas || [];
        
        let channelsMap = {};

        metas.forEach(meta => {
            if (!meta.name) return;
            
            let displayName = normalizeChannelName(meta.name);
            if (!displayName || displayName.length < 2) return; 

            const id = 'vavoo_id_' + displayName.replace(/[^a-zA-Z0-9+]/g, '_').toLowerCase();
            const metaInfo = getChannelMeta(displayName); // On récupère l'index et le catalogue cible

            if (!channelsMap[id]) {
                channelsMap[id] = {
                    id: id,
                    name: displayName,
                    originalIds: [],
                    poster: meta.poster || DEFAULT_POSTER,
                    sortIndex: metaInfo.index,
                    category: metaInfo.category // On sauvegarde le catalogue auquel la chaîne appartient
                };
            }

            if (!channelsMap[id].originalIds.includes(meta.id)) {
                channelsMap[id].originalIds.push(meta.id);
            }
            if (meta.poster && channelsMap[id].poster === DEFAULT_POSTER) {
                channelsMap[id].poster = meta.poster;
            }
        });

        channelsData = Object.values(channelsMap);
        channelsData.sort((a, b) => {
            if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
            return a.name.localeCompare(b.name);
        });

        console.log(`[TvVoo Proxy] Succès : ${channelsData.length} chaînes triées dans 4 catalogues.`);
    } catch (err) {
        console.error('[TvVoo Proxy] Erreur :', err.message);
    }
}

async function checkStreamValid(url) {
    try {
        await axios.get(url, { 
            headers: { 'Range': 'bytes=0-100' },
            timeout: 3000 
        });
        return true;
    } catch (e) {
        if (e.response && [404, 502, 503].includes(e.response.status)) {
            return false; 
        }
        return true; 
    }
}

function getStreamScore(title) {
    const t = (title || '').toUpperCase();
    if (t.includes('4K') || t.includes('2160') || t.includes('UHD')) return 4;
    if (t.includes('FHD') || t.includes('1080')) return 3;
    if (t.includes('HD') || t.includes('720')) return 2;
    if (t.includes('SD')) return 0;
    return 1;
}

app.get('/', (req, res) => {
    res.send(`<h1>Vavoo FR (v9.0 - Multi-Catalogues) est en ligne !</h1><p>Chaînes totales : <strong>${channelsData.length}</strong></p>`);
});

// MANIFEST MIS À JOUR : On déclare nos 4 catalogues pour que Nuvio les sépare visuellement
app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.vavooproxy.fr.live',
        version: '9.0.0',
        name: 'Vavoo FR Multi',
        description: 'Bouquets organisés par thèmes : TNT, Sports et Premium.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            { type: 'tv', id: 'vavoo_tnt', name: 'TNT Française' },
            { type: 'tv', id: 'vavoo_sports', name: 'Sports' },
            { type: 'tv', id: 'vavoo_premium', name: 'Chaînes Payantes' },
            { type: 'tv', id: 'vavoo_autres', name: 'Autres Chaînes' }
        ]
    });
});

// ROUTING DYNAMIQUE : Sert uniquement les chaînes du catalogue demandé
const handleCatalog = (req, res) => {
    const requestedCatalog = req.params.id; // Va valoir vavoo_tnt, vavoo_sports, etc.
    
    // Sécurité : vérifier que le catalogue demandé existe
    const validCatalogs = ['vavoo_tnt', 'vavoo_sports', 'vavoo_premium', 'vavoo_autres'];
    if (!validCatalogs.includes(requestedCatalog)) {
        return res.json({ metas: [] });
    }

    let skip = 0;
    if (req.params.extra) {
        const match = req.params.extra.match(/skip=(\d+)/);
        if (match) skip = parseInt(match[1], 10);
    }

    // On ne garde que les chaînes qui appartiennent au catalogue sur lequel tu as cliqué
    const filteredChannels = channelsData.filter(ch => ch.category === requestedCatalog);

    const paginatedMetas = filteredChannels.slice(skip, skip + 100).map(ch => ({
        id: ch.id,
        type: 'tv',
        name: ch.name,
        poster: ch.poster,
        posterShape: 'square'
    }));
    
    res.json({ metas: paginatedMetas });
};

// Intercepte les demandes dynamiques
app.get('/catalog/tv/:id.json', handleCatalog);
app.get('/catalog/tv/:id/:extra', handleCatalog);

app.get('/meta/tv/:id.json', (req, res) => {
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });

    res.json({
        meta: {
            id: channel.id,
            type: 'tv',
            name: channel.name,
            poster: channel.poster,
            posterShape: 'square',
            description: `${channel.originalIds.length} sources regroupées.`
        }
    });
});

app.get('/stream/tv/:id.json', async (req, res) => {
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        let allStreams = [];
        
        for (let i = 0; i < channel.originalIds.length; i++) {
            const originalId = channel.originalIds[i];
            const streamRes = await axios.get(`${TVVOO_BASE}/stream/tv/${originalId}.json`, {
                headers: { 'X-Forwarded-For': clientIp }
            });
            
            if (streamRes.data && streamRes.data.streams) {
                allStreams = allStreams.concat(streamRes.data.streams);
            }
        }
        
        const checkedStreams = await Promise.all(allStreams.map(async (s) => {
            const isValid = await checkStreamValid(s.url);
            return isValid ? s : null;
        }));
        
        let validStreams = checkedStreams.filter(s => s !== null);

        if (validStreams.length === 0 && allStreams.length > 0) {
            validStreams = allStreams;
        }

        validStreams.sort((a, b) => getStreamScore(b.title) - getStreamScore(a.title));

        const finalStreams = validStreams.map((s, idx) => ({
            ...s,
            title: `Source ${idx + 1} | ${s.title || 'Flux Auto'}`
        }));
        
        res.json({ streams: finalStreams });
    } catch (err) {
        console.error('Erreur flux:', err.message);
        res.json({ streams: [] });
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
    await updateStreams();
});
