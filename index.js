const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const TVVOO_BASE = 'https://tvvoo.hayd.uk/cfg-fr';
let channelsData = []; // On utilise un tableau maintenant pour gérer l'ordre
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

// Le dictionnaire strict pour forcer l'ordre et le regroupement
const MASTER_CHANNELS = [
    { id: 'tnt_01', name: 'TF1', match: (n) => n.includes('TF1') && !n.includes('SERIES') && !n.includes('FILM') },
    { id: 'tnt_02', name: 'France 2', match: (n) => n.includes('FRANCE 2') || n.includes('FRANCE2') || n.includes('FR 2') },
    { id: 'tnt_03', name: 'France 3', match: (n) => n.includes('FRANCE 3') || n.includes('FRANCE3') || n.includes('FR 3') },
    { id: 'tnt_04', name: 'Canal+', match: (n) => (n.includes('CANAL+') || n.includes('CANAL PLUS')) && !n.includes('SPORT') && !n.includes('CINEMA') && !n.includes('SERIES') && !n.includes('DOC') },
    { id: 'tnt_05', name: 'France 5', match: (n) => n.includes('FRANCE 5') || n.includes('FRANCE5') || n.includes('FR 5') },
    { id: 'tnt_06', name: 'M6', match: (n) => (n.includes('M6') || n.includes('M 6')) && !n.includes('MUSIC') },
    { id: 'tnt_07', name: 'Arte', match: (n) => n.includes('ARTE') },
    { id: 'tnt_08', name: 'C8', match: (n) => n.includes('C8') || n.includes('C 8') },
    { id: 'tnt_09', name: 'W9', match: (n) => n.includes('W9') || n.includes('W 9') },
    { id: 'tnt_10', name: 'TMC', match: (n) => n.includes('TMC') },
    { id: 'tnt_11', name: 'TFX', match: (n) => n.includes('TFX') },
    { id: 'tnt_12', name: 'NRJ 12', match: (n) => n.includes('NRJ') && n.includes('12') },
    { id: 'tnt_13', name: 'LCP / Public Sénat', match: (n) => n.includes('LCP') || n.includes('SENAT') },
    { id: 'tnt_14', name: 'France 4', match: (n) => n.includes('FRANCE 4') || n.includes('FRANCE4') || n.includes('FR 4') },
    { id: 'tnt_15', name: 'BFMTV', match: (n) => n.includes('BFM') && n.includes('TV') },
    { id: 'tnt_16', name: 'CNEWS', match: (n) => n.includes('CNEWS') || n.includes('C NEWS') },
    { id: 'tnt_17', name: 'CSTAR', match: (n) => n.includes('CSTAR') || n.includes('C STAR') },
    { id: 'tnt_18', name: 'Gulli', match: (n) => n.includes('GULLI') },
    { id: 'tnt_20', name: 'TF1 Séries Films', match: (n) => n.includes('TF1') && (n.includes('SERIES') || n.includes('FILM')) },
    { id: 'tnt_21', name: 'L\'Équipe', match: (n) => n.includes('EQUIPE') },
    { id: 'tnt_22', name: '6ter', match: (n) => n.includes('6TER') || n.includes('6 TER') },
    { id: 'tnt_23', name: 'RMC Story', match: (n) => n.includes('RMC') && n.includes('STORY') },
    { id: 'tnt_24', name: 'RMC Découverte', match: (n) => n.includes('RMC') && n.includes('DECOUVERTE') },
    { id: 'tnt_25', name: 'Chérie 25', match: (n) => n.includes('CHERIE') && n.includes('25') },
    { id: 'tnt_26', name: 'LCI', match: (n) => n.includes('LCI') },
    { id: 'tnt_27', name: 'France Info', match: (n) => (n.includes('FRANCE') && n.includes('INFO')) || n.includes('FRANCEINFO') }
];

async function updateStreams() {
    try {
        console.log('[TvVoo Proxy] Début de la récupération (Mode Ordre Strict)...');
        const manifestRes = await axios.get(`${TVVOO_BASE}/manifest.json`, { timeout: 10000 });
        const catalogId = manifestRes.data.catalogs[0].id;
        const catalogRes = await axios.get(`${TVVOO_BASE}/catalog/tv/${catalogId}.json`, { timeout: 15000 });
        const metas = catalogRes.data.metas || [];
        
        let channelsMap = {};

        // 1. On initialise notre carte avec l'ordre parfait de la TNT
        MASTER_CHANNELS.forEach((mc, index) => {
            channelsMap[mc.id] = {
                id: mc.id,
                name: mc.name,
                originalIds: [],
                poster: DEFAULT_POSTER,
                sortIndex: index // Permet de garder l'ordre de 1 à 27
            };
        });

        // 2. On trie chaque flux reçu dans la bonne case
        metas.forEach(meta => {
            let rawName = (meta.name || "").toUpperCase();
            let matched = false;

            // Essaye de ranger dans une des cases TNT
            for (let mc of MASTER_CHANNELS) {
                if (mc.match(rawName)) {
                    if (!channelsMap[mc.id].originalIds.includes(meta.id)) {
                        channelsMap[mc.id].originalIds.push(meta.id);
                        if (meta.poster && channelsMap[mc.id].poster === DEFAULT_POSTER) {
                            channelsMap[mc.id].poster = meta.poster; // Garde le premier logo trouvé
                        }
                    }
                    matched = true;
                    break;
                }
            }

            // Si c'est une autre chaîne (ex: RTL9, Paris Première), on la nettoie et on l'ajoute à la fin
            if (!matched) {
                let cleanName = meta.name
                    .replace(/^(?:FR|FRANCE|BE|CH|CA|VIP)\s*[:|/-]\s*/i, '')
                    .replace(/\[.*?\]|\(.*?\)/g, ' ')
                    .replace(/\b(FHD|HD|SD|4K|1080P|720P|1080|720|HEVC|H265|VOD|BACKUP|SECOURS|VIP|VAVOO)\b/gi, '')
                    .replace(/[^\p{L}\p{N}+]/gu, ' ').replace(/\s+/g, ' ').trim();

                if (cleanName) {
                    let fallbackId = 'other_fr_' + cleanName.toUpperCase().replace(/[^A-Z0-9]/g, '');
                    if (!channelsMap[fallbackId]) {
                        channelsMap[fallbackId] = {
                            id: fallbackId,
                            name: cleanName,
                            originalIds: [],
                            poster: meta.poster || DEFAULT_POSTER,
                            sortIndex: 999 // Sera mis tout à la fin
                        };
                    }
                    if (!channelsMap[fallbackId].originalIds.includes(meta.id)) {
                        channelsMap[fallbackId].originalIds.push(meta.id);
                    }
                }
            }
        });

        // 3. On convertit en tableau et on trie (TNT en premier de 1 à 27, puis le reste par ordre alphabétique)
        channelsData = Object.values(channelsMap).filter(ch => ch.originalIds.length > 0);
        channelsData.sort((a, b) => {
            if (a.sortIndex !== b.sortIndex) {
                return a.sortIndex - b.sortIndex;
            }
            return a.name.localeCompare(b.name);
        });

        console.log(`[TvVoo Proxy] Succès : Catalogue trié. ${channelsData.length} chaînes uniques prêtes.`);
    } catch (err) {
        console.error('[TvVoo Proxy] Erreur :', err.message);
    }
}

// Notation des flux pour mettre la meilleure qualité tout en haut du choix
function getStreamScore(title) {
    const t = (title || '').toUpperCase();
    if (t.includes('4K') || t.includes('2160')) return 4;
    if (t.includes('FHD') || t.includes('1080')) return 3;
    if (t.includes('HD') || t.includes('720')) return 2;
    if (t.includes('SD')) return 0;
    return 1;
}

app.get('/', (req, res) => {
    res.send(`<h1>Vavoo FR (v4.0 - Bouquet TNT) est en ligne !</h1><p>Nombre total de chaînes : <strong>${channelsData.length}</strong></p>`);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.vavooproxy.fr.live',
        version: '4.0.0',
        name: 'Vavoo FR TNT',
        description: 'Bouquet français officiel avec choix de flux',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            {
                type: 'tv',
                id: 'vavoo_fr_tnt',
                name: 'TV Française'
            }
        ]
    });
});

app.get('/catalog/tv/vavoo_fr_tnt.json', (req, res) => {
    const metas = channelsData.map(ch => ({
        id: ch.id,
        type: 'tv',
        name: ch.name,
        poster: ch.poster,
        posterShape: 'square'
    }));
    res.json({ metas });
});

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
            description: `${channel.originalIds.length} sources disponibles. Cliquez sur un flux pour lancer.`
        }
    });
});

app.get('/stream/tv/:id.json', async (req, res) => {
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        let allStreams = [];
        
        // On récupère les flux de tous les doublons regroupés
        for (let i = 0; i < channel.originalIds.length; i++) {
            const originalId = channel.originalIds[i];
            const streamRes = await axios.get(`${TVVOO_BASE}/stream/tv/${originalId}.json`, {
                headers: { 'X-Forwarded-For': clientIp }
            });
            
            if (streamRes.data && streamRes.data.streams) {
                allStreams = allStreams.concat(streamRes.data.streams);
            }
        }
        
        // On trie les flux du meilleur au moins bon (4K -> 1080p -> 720p)
        allStreams.sort((a, b) => getStreamScore(b.title) - getStreamScore(a.title));

        const finalStreams = allStreams.map((s, idx) => ({
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
