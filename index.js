const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const TVVOO_BASE = 'https://tvvoo.hayd.uk/cfg-fr';
let channelsData = {};
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

async function updateStreams() {
    try {
        console.log('[TvVoo Proxy] Début de la récupération et du nettoyage...');
        const manifestRes = await axios.get(`${TVVOO_BASE}/manifest.json`, { timeout: 10000 });
        const catalogId = manifestRes.data.catalogs[0].id;

        const catalogRes = await axios.get(`${TVVOO_BASE}/catalog/tv/${catalogId}.json`, { timeout: 15000 });
        const metas = catalogRes.data.metas || [];
        const channels = {};

        // 1. Regroupement agressif des doublons
        metas.forEach(meta => {
            let rawName = meta.name || "";
            
            // Création d'un ID de comparaison radical (ex: "FR : TF1 (FHD)" devient "TF1")
            let normalizedId = rawName.toUpperCase()
                .replace(/^(FR|FRANCE|BE|CH|CA)\s*[:|-]?\s*/i, '') // Retire les préfixes pays
                .replace(/\s*\(.*?\)\s*/g, ' ') // Retire le texte entre parenthèses
                .replace(/\b(FHD|HD|SD|4K|1080P|720P|HEVC|VOD|TV)\b/gi, '') // Retire les tags qualité
                .replace(/[^A-Z0-9+]/g, ''); // Ne garde que lettres, chiffres et '+'

            if (!normalizedId) return;

            const id = 'proxy_fr_' + normalizedId.toLowerCase();
            
            // Nom propre pour l'affichage visuel dans Nuvio
            let cleanName = rawName
                .replace(/^(FR|FRANCE|BE|CH|CA)\s*[:|-]?\s*/i, '')
                .replace(/\s*\(.*?\)\s*/g, '')
                .replace(/\b(FHD|HD|SD|4K|1080P|720P|HEVC|VOD|TV)\b/gi, '')
                .replace(/[-_]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (!channels[id]) {
                channels[id] = { 
                    id, 
                    name: cleanName, 
                    originalIds: [],
                    poster: meta.poster || DEFAULT_POSTER
                };
            }
            
            // Évite d'ajouter l'ID original s'il y est déjà
            if (!channels[id].originalIds.includes(meta.id)) {
                channels[id].originalIds.push(meta.id);
            }
        });

        channelsData = channels;
        console.log(`[TvVoo Proxy] Succès : Réduit à ${Object.keys(channelsData).length} chaînes uniques (depuis ${metas.length} sources).`);
    } catch (err) {
        console.error('[TvVoo Proxy] Erreur :', err.message);
    }
}

// Notation des flux pour le tri
function getStreamScore(title) {
    const t = (title || '').toUpperCase();
    if (t.includes('4K') || t.includes('2160')) return 4;
    if (t.includes('FHD') || t.includes('1080')) return 3;
    if (t.includes('HD') || t.includes('720')) return 2;
    if (t.includes('SD')) return 0;
    return 1; // Qualité standard/inconnue
}

app.get('/', (req, res) => {
    const count = Object.keys(channelsData).length;
    res.send(`<h1>Vavoo FR (v3 - Anti-Doublons) est en ligne !</h1><p>Nombre de chaînes uniques : <strong>${count}</strong></p>`);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.vavooproxy.fr.live',
        version: '3.0.0',
        name: 'Vavoo FR Opti',
        description: 'Chaînes françaises uniques avec tri par qualité',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            {
                type: 'tv',
                id: 'vavoo_fr_opti',
                name: 'TV Française'
            }
        ]
    });
});

app.get('/catalog/tv/vavoo_fr_opti.json', (req, res) => {
    const metas = Object.values(channelsData).map(ch => ({
        id: ch.id,
        type: 'tv',
        name: ch.name,
        poster: ch.poster,
        posterShape: 'square'
    }));
    res.json({ metas });
});

app.get('/meta/tv/:id.json', (req, res) => {
    const channel = channelsData[req.params.id];
    if (!channel) return res.json({ meta: {} });

    res.json({
        meta: {
            id: channel.id,
            type: 'tv',
            name: channel.name,
            poster: channel.poster,
            posterShape: 'square',
            description: `${channel.originalIds.length} sources trouvées pour cette chaîne.`
        }
    });
});

app.get('/stream/tv/:id.json', async (req, res) => {
    const channel = channelsData[req.params.id];
    if (!channel) return res.json({ streams: [] });

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        let allStreams = [];
        
        // Récupération de tous les flux
        for (let i = 0; i < channel.originalIds.length; i++) {
            const originalId = channel.originalIds[i];
            const streamRes = await axios.get(`${TVVOO_BASE}/stream/tv/${originalId}.json`, {
                headers: { 'X-Forwarded-For': clientIp }
            });
            
            if (streamRes.data && streamRes.data.streams) {
                allStreams = allStreams.concat(streamRes.data.streams);
            }
        }
        
        // 2. Tri automatique des flux (les meilleurs scores en premier)
        allStreams.sort((a, b) => getStreamScore(b.title) - getStreamScore(a.title));

        // 3. Renommage propre pour Nuvio
        const finalStreams = allStreams.map((s, idx) => ({
            ...s,
            title: `Choix ${idx + 1} | ${s.title || 'Qualité Inconnue'}`
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
