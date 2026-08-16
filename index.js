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

    // Nettoyage de base
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

    // Fusions spécifiques
    if (displayName.includes('EQUIPE')) return "L'Équipe"; 
    if (displayName.includes('DISNEY')) return 'Disney Channel'; 

    // Galaxie Canal+ (Garde Canal+ Cinéma, Canal+ Sport, mais regroupe la chaîne mère)
    if (displayName === 'CANAL' || displayName === 'CANAL PLUS' || displayName === 'CANAL LIVE') return 'Canal+';
    if (displayName.startsWith('CANAL+')) {
        let suffix = displayName.replace('CANAL+', '').trim();
        if (!suffix) return 'Canal+';
        // Formate bien le nom, ex: "Canal+ Cinema"
        return `Canal+ ${suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase()}`;
    }

    // beIN SPORTS (Sépare proprement la 1, 2, 3)
    if (displayName.includes('BEIN SPORT')) {
        let beinMatch = displayName.match(/BEIN SPORTS?\s*(\d+)/);
        if (beinMatch) return `beIN SPORTS ${beinMatch[1]}`;
        if (displayName.includes('MAX')) return 'beIN SPORTS MAX';
        return 'beIN SPORTS 1'; // Par défaut si non spécifié
    }

    // RMC SPORT
    if (displayName.includes('RMC SPORT')) {
        let rmcMatch = displayName.match(/RMC SPORT\s*(\d+)/);
        if (rmcMatch) return `RMC Sport ${rmcMatch[1]}`;
        return 'RMC Sport (Multicanal)';
    }

    // EUROSPORT
    if (displayName.includes('EUROSPORT')) {
        let euroMatch = displayName.match(/EUROSPORT\s*(\d+)/);
        if (euroMatch) return `Eurosport ${euroMatch[1]}`;
        return 'Eurosport 1';
    }

    // DAZN
    if (displayName.includes('DAZN')) {
        let daznMatch = displayName.match(/DAZN\s*(\d+)/);
        if (daznMatch) return `DAZN ${daznMatch[1]}`;
        return 'DAZN 1';
    }

    // Noms TNT propres
    if (displayName === 'FRANCE 2') return 'France 2';
    if (displayName === 'FRANCE 3') return 'France 3';
    if (displayName === 'FRANCE 4') return 'France 4';
    if (displayName === 'FRANCE 5') return 'France 5';
    if (displayName.includes('FRANCE INFO')) return 'France Info';
    
    return displayName;
}

// Architecture type Bouquet TV Freebox
function getChannelMeta(channelName) {
    const n = channelName.toUpperCase();
    
    // --- TNT (SANS CANAL+) ---
    if (n === 'TF1') return { index: 1, category: 'vavoo_tnt' };
    if (n === 'FRANCE 2') return { index: 2, category: 'vavoo_tnt' };
    if (n === 'FRANCE 3') return { index: 3, category: 'vavoo_tnt' };
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

    // --- PREMIUM / PAYANTES ---
    if (n.startsWith('CANAL+')) return { index: 40, category: 'vavoo_premium' }; 
    if (n.startsWith('CINE+')) return { index: 45, category: 'vavoo_premium' };
    if (n.startsWith('OCS')) return { index: 46, category: 'vavoo_premium' };
    if (n === 'PARIS PREMIERE' || n.includes('RTL 9') || n === 'RTL9') return { index: 47, category: 'vavoo_premium' };
    if (n.includes('DISNEY')) return { index: 50, category: 'vavoo_premium' };

    // --- SPORTS ---
    if (n.startsWith('BEIN SPORTS')) return { index: 100, category: 'vavoo_sports' };
    if (n.startsWith('RMC SPORT')) return { index: 110, category: 'vavoo_sports' };
    if (n.startsWith('EUROSPORT')) return { index: 120, category: 'vavoo_sports' };
    if (n.startsWith('DAZN')) return { index: 130, category: 'vavoo_sports' };
    if (n.startsWith('AUTOMOTO')) return { index: 140, category: 'vavoo_sports' };
    if (n.startsWith('GOLF+')) return { index: 150, category: 'vavoo_sports' };
    if (n.includes('EQUIDIA')) return { index: 160, category: 'vavoo_sports' };
    if (n.includes('SPORT')) return { index: 199, category: 'vavoo_sports' };

    // --- AUTRES ---
    return { index: 999, category: 'vavoo_autres' };
}

async function updateStreams() {
    try {
        console.log('[TvVoo Proxy] Construction du bouquet type Free...');
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
            const metaInfo = getChannelMeta(displayName); 

            if (!channelsMap[id]) {
                channelsMap[id] = {
                    id: id,
                    name: displayName,
                    originalIds: [],
                    poster: meta.poster || DEFAULT_POSTER,
                    sortIndex: metaInfo.index,
                    category: metaInfo.category 
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

        console.log(`[TvVoo Proxy] Succès : Bouquet prêt avec ${channelsData.length} chaînes.`);
    } catch (err) {
        console.error('[TvVoo Proxy] Erreur :', err.message);
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
    res.send(`<h1>Vavoo FR (v10.0 - Bouquet Freebox) est en ligne !</h1><p>Chaînes totales : <strong>${channelsData.length}</strong></p>`);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.vavooproxy.fr.live',
        version: '10.0.0',
        name: 'Vavoo FR Box',
        description: 'Organisation type Freebox, Canal+ en premium et sources backups restaurées.',
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

const handleCatalog = (req, res) => {
    const requestedCatalog = req.params.id; 
    
    const validCatalogs = ['vavoo_tnt', 'vavoo_sports', 'vavoo_premium', 'vavoo_autres'];
    if (!validCatalogs.includes(requestedCatalog)) {
        return res.json({ metas: [] });
    }

    let skip = 0;
    if (req.params.extra) {
        const match = req.params.extra.match(/skip=(\d+)/);
        if (match) skip = parseInt(match[1], 10);
    }

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
            description: `${channel.originalIds.length} sources trouvées.`
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
        
        // Suppression du testeur de flux qui éliminait les liens à tort !
        
        allStreams.sort((a, b) => getStreamScore(b.title) - getStreamScore(a.title));

        const finalStreams = allStreams.map((s, idx) => ({
            ...s,
            title: `Backup ${idx + 1} | ${s.title || 'Flux Auto'}`
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
