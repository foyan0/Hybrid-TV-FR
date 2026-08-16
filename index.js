const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// --- SOURCES ---
const TV_LEGAL_BASE = 'https://tvlegal.beluchon.top/eyJjYXRhbG9ncyI6WyJ0ZjEtaW5mb3MiXSwibGl2ZSI6dHJ1ZSwidG1kYktleSI6ImE4ZjQxNjI1ODc4N2Y3MGFjYzY0YTBlMmE0ODU1ZDdjIn0=';
const VAVOO_M3U_URL = 'http://vavoo.to/playlist.m3u';

let channelsData = []; 
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

// --- FONCTIONS DE NETTOYAGE ET ORGANISATION ---
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

    // BLINDAGE CANAL+
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

    // --- PREMIUM (Vérification stricte de Canal+) ---
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

// --- GÉNÉRATEUR NÉCROMANCIEN DE CLÉS VAVOO (Natif) ---
async function generateVavooToken() {
    try {
        const res = await axios.post('https://www.vavoo.tv/api/box/guest', {
            app: '1',
            brand: 'VAVOO',
            model: 'VAVOO',
            os: 'Android',
            uuid: 'd2d1421b-640a-4286-8a71-f9eb79f42c16' // Simulation appareil Android
        });
        return res.data.signed; // Voici la clé secrète !
    } catch (err) {
        console.error('Erreur génération clé Vavoo:', err.message);
        return null;
    }
}

// --- ASPIRATEURS ---

// 1. Aspirateur Légal (Add-on Stremio)
async function fetchLegalStreams() {
    let metas = [];
    try {
        console.log(`[Proxy] Aspiration du réseau Légal...`);
        const manifestRes = await axios.get(`${TV_LEGAL_BASE}/manifest.json`, { timeout: 10000 });
        for (const catalog of manifestRes.data.catalogs) {
            try {
                let baseRes = await axios.get(`${TV_LEGAL_BASE}/catalog/${catalog.type}/${catalog.id}.json`, { timeout: 10000 });
                if (baseRes.data && baseRes.data.metas) metas = metas.concat(baseRes.data.metas);
            } catch (err) { }
        }
    } catch (err) {
        console.error(`[Proxy] Erreur Légal :`, err.message);
    }
    return metas;
}

// 2. Aspirateur Vavoo Brut (Indépendant)
async function fetchVavooNative() {
    let metas = [];
    try {
        console.log(`[Proxy] Aspiration du réseau Vavoo (Fichier brut)...`);
        const response = await axios.get(VAVOO_M3U_URL, {
            headers: { 'User-Agent': 'VAVOO/2.6' },
            timeout: 15000
        });

        const lines = response.data.split('\n');
        let currentName = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('#EXTINF:')) {
                const parts = line.split(',');
                currentName = parts.length > 1 ? parts.slice(1).join(',').trim() : '';
            } else if (line && !line.startsWith('#') && currentName) {
                // On ne garde que les chaînes taggées "France" ou "FR" pour éviter la saturation
                if (currentName.toUpperCase().includes('FR') || currentName.toUpperCase().includes('FRANCE')) {
                    metas.push({
                        id: 'vavoo_raw_' + Buffer.from(line).toString('base64').substring(0, 15), // ID unique basé sur l'URL
                        name: currentName,
                        poster: DEFAULT_POSTER,
                        _rawUrl: line // On stocke l'URL brute, on la décryptera plus tard
                    });
                }
                currentName = '';
            }
        }
    } catch (err) {
        console.error(`[Proxy] Erreur Vavoo Brut :`, err.message);
    }
    return metas;
}

// Construction de la base de données
async function updateStreams() {
    try {
        let channelsMap = {};

        // 1. Chargement Légal
        const legalMetas = await fetchLegalStreams();
        legalMetas.forEach(meta => {
            let dName = normalizeChannelName(meta.name);
            if (!dName || dName.length < 2) return;
            const id = 'hyb_id_' + dName.replace(/[^a-zA-Z0-9+]/g, '_').toLowerCase();
            const metaInfo = getChannelMeta(dName); 

            if (!channelsMap[id]) {
                channelsMap[id] = { id, name: dName, sources: [], poster: meta.poster || DEFAULT_POSTER, sortIndex: metaInfo.index, category: metaInfo.category };
            }
            channelsMap[id].sources.push({ type: 'legal', metaId: meta.id });
            if (meta.poster && channelsMap[id].poster === DEFAULT_POSTER) channelsMap[id].poster = meta.poster;
        });

        // 2. Chargement Vavoo
        const vavooMetas = await fetchVavooNative();
        vavooMetas.forEach(meta => {
            let dName = normalizeChannelName(meta.name);
            if (!dName || dName.length < 2) return;
            const id = 'hyb_id_' + dName.replace(/[^a-zA-Z0-9+]/g, '_').toLowerCase();
            const metaInfo = getChannelMeta(dName); 

            if (!channelsMap[id]) {
                channelsMap[id] = { id, name: dName, sources: [], poster: meta.poster || DEFAULT_POSTER, sortIndex: metaInfo.index, category: metaInfo.category };
            }
            channelsMap[id].sources.push({ type: 'vavoo', url: meta._rawUrl });
        });

        channelsData = Object.values(channelsMap);
        channelsData.sort((a, b) => {
            if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
            return a.name.localeCompare(b.name);
        });

        console.log(`[Proxy] Fusion réussie. ${channelsData.length} chaînes prêtes.`);
    } catch (err) {
        console.error('[Proxy] Erreur globale :', err.message);
    }
}

// --- SERVEUR ADDON ---

app.get('/', (req, res) => {
    res.send(`<h1>Hybrid TV FR (v13.0 - Indépendance Totale) est en ligne !</h1><p>Chaînes totales : <strong>${channelsData.length}</strong></p>`);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.hybridproxy.fr.live',
        version: '13.0.0',
        name: 'Super TV Box',
        description: 'Flux Légaux + Vavoo (Génération de clés Native).',
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
    if (!validCatalogs.includes(requestedCatalog)) return res.json({ metas: [] });

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
            description: `Système Autonome : Flux Officiels + Backups générés en temps réel.`
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
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });

    try {
        let allStreams = [];
        
        // 1. Récupération des flux Légaux (Rapide)
        const legalSources = channel.sources.filter(s => s.type === 'legal');
        for (const source of legalSources) {
            try {
                const streamRes = await axios.get(`${TV_LEGAL_BASE}/stream/tv/${source.metaId}.json`, { timeout: 5000 });
                if (streamRes.data && streamRes.data.streams) {
                    const mappedStreams = streamRes.data.streams.map(s => ({
                        ...s,
                        _score: getStreamScore(s.title),
                        _label: 'Légal',
                        _isPriority: true
                    }));
                    allStreams = allStreams.concat(mappedStreams);
                }
            } catch (err) {}
        }

        // 2. Déchiffrement à la volée des flux Vavoo (Génération du Token)
        const vavooSources = channel.sources.filter(s => s.type === 'vavoo');
        if (vavooSources.length > 0) {
            const token = await generateVavooToken(); // On crée la clé de sécurité
            
            vavooSources.forEach((source, index) => {
                let finalUrl = source.url;
                
                // Si Vavoo exige un token, on l'ajoute à l'URL finale
                if (token && finalUrl.includes('.ts')) {
                    finalUrl = `${finalUrl}?n=1&b=5&vavoo_auth=${token}`;
                }
                
                allStreams.push({
                    url: finalUrl,
                    title: `Flux de Secours ${index + 1}`,
                    _score: 1, // Score moyen
                    _label: 'Vavoo',
                    _isPriority: false
                });
            });
        }
        
        // 3. Tri (Légal prioritaire, puis par Qualité)
        allStreams.sort((a, b) => {
            if (a._isPriority && !b._isPriority) return -1;
            if (!a._isPriority && b._isPriority) return 1;
            return b._score - a._score;
        });

        // 4. Formatage final des étiquettes
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
