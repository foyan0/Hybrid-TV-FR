const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// --- TES FOURNISSEURS INDÉPENDANTS ---
// Si un jour Vavoo change, il suffit de remplacer le lien de `base` ici par un autre Add-on !
const PROVIDERS = [
    { id: 'legal', base: 'https://tvlegal.beluchon.top/eyJjYXRhbG9ncyI6WyJ0ZjEtaW5mb3MiXSwibGl2ZSI6dHJ1ZSwidG1kYktleSI6ImE4ZjQxNjI1ODc4N2Y3MGFjYzY0YTBlMmE0ODU1ZDdjIn0=', label: 'Légal', isPriority: true },
    { id: 'vavoo', base: 'https://tvvoo.hayd.uk/cfg-fr', label: 'Vavoo', isPriority: false }
];

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
    if (displayName.includes('DISNEY')) return 'Disney Channel'; 

    // BLINDAGE DE CANAL+ POUR QU'IL RESTE DANS LE PREMIUM
    if (displayName === 'CANAL' || displayName === 'CANAL PLUS' || displayName === 'CANAL LIVE') return 'Canal+';
    if (displayName.startsWith('CANAL+')) {
        let suffix = displayName.replace('CANAL+', '').trim();
        if (!suffix) return 'Canal+';
        return `Canal+ ${suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase()}`;
    }

    if (displayName.includes('BEIN SPORT')) {
        let beinMatch = displayName.match(/BEIN SPORTS?\s*(\d+)/);
        if (beinMatch) return `beIN SPORTS ${beinMatch[1]}`;
        if (displayName.includes('MAX')) return 'beIN SPORTS MAX';
        return 'beIN SPORTS 1'; 
    }

    if (displayName.includes('RMC SPORT')) {
        let rmcMatch = displayName.match(/RMC SPORT\s*(\d+)/);
        if (rmcMatch) return `RMC Sport ${rmcMatch[1]}`;
        return 'RMC Sport (Multicanal)';
    }

    if (displayName.includes('EUROSPORT')) {
        let euroMatch = displayName.match(/EUROSPORT\s*(\d+)/);
        if (euroMatch) return `Eurosport ${euroMatch[1]}`;
        return 'Eurosport 1';
    }

    if (displayName.includes('DAZN')) {
        let daznMatch = displayName.match(/DAZN\s*(\d+)/);
        if (daznMatch) return `DAZN ${daznMatch[1]}`;
        return 'DAZN 1';
    }

    if (displayName === 'FRANCE 2') return 'France 2';
    if (displayName === 'FRANCE 3') return 'France 3';
    if (displayName === 'FRANCE 4') return 'France 4';
    if (displayName === 'FRANCE 5') return 'France 5';
    if (displayName.includes('FRANCE INFO')) return 'France Info';
    
    return displayName;
}

function getChannelMeta(channelName) {
    const n = channelName.toUpperCase();
    
    // --- TNT ---
    if (n === 'TF1') return { index: 1, category: 'vavoo_tnt' };
    if (n === 'FRANCE 2') return { index: 2, category: 'vavoo_tnt' };
    if (n === 'FRANCE 3') return { index: 3, category: 'vavoo_tnt' };
    if (n === 'FRANCE 4') return { index: 4, category: 'vavoo_tnt' };
    if (n === 'FRANCE 5') return { index: 5, category: 'vavoo_tnt' };
    if (n === 'M6') return { index: 6, category: 'vavoo_tnt' };
    if (n === 'ARTE') return { index: 7, category: 'vavoo_tnt' };
    if (n === 'C8') return { index: 8, category: 'vavoo_tnt' };
    if (n === 'W9') return { index: 9, category: 'vavoo_tnt' };
    if (n === 'TMC') return { index: 10, category: 'vavoo_tnt' };
    if (n === 'TFX') return { index: 11, category: 'vavoo_tnt' };
    if (n === 'NRJ 12' || n === 'NRJ12') return { index: 12, category: 'vavoo_tnt' };
    if (n.includes('LCP') || n.includes('SENAT')) return { index: 13, category: 'vavoo_tnt' };
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

    // --- PREMIUM (Vérification stricte pour forcer Canal+ ici) ---
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

    return { index: 999, category: 'vavoo_autres' };
}

async function fetchAddonCatalog(provider) {
    let allMetas = [];
    try {
        console.log(`[Proxy] Aspiration du fournisseur : ${provider.label}...`);
        const manifestRes = await axios.get(`${provider.base}/manifest.json`, { timeout: 10000 });
        
        for (const catalog of manifestRes.data.catalogs) {
            const catalogId = catalog.id;
            const catalogType = catalog.type;
            
            try {
                let baseRes = await axios.get(`${provider.base}/catalog/${catalogType}/${catalogId}.json`, { timeout: 10000 });
                if (baseRes.data && baseRes.data.metas) {
                    allMetas = allMetas.concat(baseRes.data.metas);
                }

                const genreExtra = (catalog.extra || []).find(e => e.name === 'genre');
                if (genreExtra && genreExtra.options) {
                    for (const genre of genreExtra.options) {
                        let genreRes = await axios.get(`${provider.base}/catalog/${catalogType}/${catalogId}/genre=${encodeURIComponent(genre)}.json`, { timeout: 10000 });
                        if (genreRes.data && genreRes.data.metas) {
                            allMetas = allMetas.concat(genreRes.data.metas);
                        }
                    }
                }
            } catch (err) {
                // Silencieux si une catégorie échoue
            }
        }
    } catch (err) {
        console.error(`[Proxy] Erreur avec ${provider.label} :`, err.message);
    }
    return allMetas;
}

async function updateStreams() {
    try {
        let channelsMap = {};

        for (const provider of PROVIDERS) {
            const metas = await fetchAddonCatalog(provider);
            
            metas.forEach(meta => {
                if (!meta.name) return;
                
                let displayName = normalizeChannelName(meta.name);
                if (!displayName || displayName.length < 2) return; 

                const id = 'hyb_id_' + displayName.replace(/[^a-zA-Z0-9+]/g, '_').toLowerCase();
                const metaInfo = getChannelMeta(displayName); 

                if (!channelsMap[id]) {
                    channelsMap[id] = {
                        id: id,
                        name: displayName,
                        sources: [], 
                        poster: meta.poster || DEFAULT_POSTER,
                        sortIndex: metaInfo.index,
                        category: metaInfo.category 
                    };
                }

                // Associe la source au bon fournisseur (Légal ou Vavoo)
                const sourceExists = channelsMap[id].sources.find(s => s.metaId === meta.id && s.provider.id === provider.id);
                if (!sourceExists) {
                    channelsMap[id].sources.push({
                        metaId: meta.id,
                        provider: provider
                    });
                }
                
                if (meta.poster && channelsMap[id].poster === DEFAULT_POSTER) {
                    channelsMap[id].poster = meta.poster;
                }
            });
        }

        channelsData = Object.values(channelsMap);
        channelsData.sort((a, b) => {
            if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
            return a.name.localeCompare(b.name);
        });

        console.log(`[Proxy] Fusion réussie. ${channelsData.length} chaînes uniques construites.`);
    } catch (err) {
        console.error('[Proxy] Erreur globale :', err.message);
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
    res.send(`<h1>Hybrid TV FR (v14.0 - Légal + TvVoo) est en ligne !</h1><p>Chaînes totales : <strong>${channelsData.length}</strong></p>`);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.hybridproxy.fr.live',
        version: '14.0.0',
        name: 'Super TV Box',
        description: 'Flux Légaux prioritaires + Secours Vavoo (TvVoo).',
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
            description: `Système Hybride : ${channel.sources.length} réseaux analysés pour garantir la diffusion.`
        }
    });
});

app.get('/stream/tv/:id.json', async (req, res) => {
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        let allStreams = [];
        
        // Requête simultanée aux différents fournisseurs pour la chaîne
        for (const source of channel.sources) {
            try {
                const streamRes = await axios.get(`${source.provider.base}/stream/tv/${source.metaId}.json`, {
                    headers: { 'X-Forwarded-For': clientIp },
                    timeout: 5000
                });
                
                if (streamRes.data && streamRes.data.streams) {
                    const mappedStreams = streamRes.data.streams.map(s => ({
                        ...s,
                        _score: getStreamScore(s.title),
                        _label: source.provider.label, // Affichera "Légal" ou "Vavoo"
                        _isPriority: source.provider.isPriority
                    }));
                    allStreams = allStreams.concat(mappedStreams);
                }
            } catch (err) {
                // Si Vavoo tombe en panne, le Légal continue de fonctionner en silence !
            }
        }
        
        // Tri : Les flux "Légal" (Priority) se mettent automatiquement tout en haut de la liste
        allStreams.sort((a, b) => {
            if (a._isPriority && !b._isPriority) return -1;
            if (!a._isPriority && b._isPriority) return 1;
            return b._score - a._score;
        });

        // Formatage du texte affiché dans l'application
        const finalStreams = allStreams.map((s, idx) => ({
            url: s.url,
            title: `[${s._label}] Choix ${idx + 1} | ${s.title.replace(/\[.*?\]\s*/g, '') || 'Auto'}`
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
