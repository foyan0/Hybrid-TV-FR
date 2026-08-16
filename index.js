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
        console.log('[TvVoo Proxy] Début de la récupération...');
        const manifestRes = await axios.get(`${TVVOO_BASE}/manifest.json`, { timeout: 10000 });
        const catalogId = manifestRes.data.catalogs[0].id;

        const catalogRes = await axios.get(`${TVVOO_BASE}/catalog/tv/${catalogId}.json`, { timeout: 15000 });
        const metas = catalogRes.data.metas || [];
        const channels = {};

        const badTags = ['FHD', 'HD', 'SD', '4K', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'VAVOO'];

        metas.forEach(meta => {
            let rawName = meta.name || "";
            
            // 1. Nom propre pour l'affichage (garde les accents et mots légitimes)
            let cleanName = rawName;
            
            // Supprime seulement les préfixes type "FR :" ou "FR |" au tout début
            cleanName = cleanName.replace(/^(?:FR|FRANCE|BE|CH|CA|VIP)\s*[:|/-]\s*/i, '');
            
            // Supprime le contenu entre parenthèses et crochets
            cleanName = cleanName.replace(/\[.*?\]|\(.*?\)/g, ' ');
            
            // Supprime les tags de qualité
            cleanName = cleanName.replace(new RegExp(`\\b(${badTags.join('|')})\\b`, 'gi'), '');
            
            // Ne garde que les lettres (y compris accentuées), chiffres et le +, remplace le reste par des espaces
            cleanName = cleanName.replace(/[^\p{L}\p{N}+]/gu, ' ').replace(/\s+/g, ' ').trim();

            if (!cleanName) return;

            // 2. Création de l'ID pour le regroupement
            let normalizedId = cleanName.toUpperCase().replace(/[^A-Z0-9+]/g, '');
            const id = 'proxy_fr_' + normalizedId.toLowerCase();

            if (!channels[id]) {
                channels[id] = { 
                    id, 
                    name: cleanName, 
                    originalIds: [],
                    poster: meta.poster || DEFAULT_POSTER
                };
            }
            
            if (!channels[id].originalIds.includes(meta.id)) {
                channels[id].originalIds.push(meta.id);
            }
        });

        channelsData = channels;
        console.log(`[TvVoo Proxy] Succès : Réduit à ${Object.keys(channelsData).length} chaînes uniques.`);
    } catch (err) {
        console.error('[TvVoo Proxy] Erreur :', err.message);
    }
}

function getStreamScore(title) {
    const t = (title || '').toUpperCase();
    if (t.includes('4K') || t.includes('2160')) return 4;
    if (t.includes('FHD') || t.includes('1080')) return 3;
    if (t.includes('HD') || t.includes('720')) return 2;
    if (t.includes('SD')) return 0;
    return 1;
}

app.get('/', (req, res) => {
    const count = Object.keys(channelsData).length;
    res.send(`<h1>Vavoo FR (v3.2 - Noms Corrigés) est en ligne !</h1><p>Nombre de chaînes uniques : <strong>${count}</strong></p>`);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.vavooproxy.fr.live',
        version: '3.2.0',
        name: 'Vavoo FR Pro',
        description: 'Chaînes uniques avec accents corrigés',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            {
                type: 'tv',
                id: 'vavoo_fr_pro',
                name: 'TV Française'
            }
        ]
    });
});

app.get('/catalog/tv/vavoo_fr_pro.json', (req, res) => {
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
            description: `${channel.originalIds.length} sources regroupées pour cette chaîne.`
        }
    });
});

app.get('/stream/tv/:id.json', async (req, res) => {
    const channel = channelsData[req.params.id];
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
        
        allStreams.sort((a, b) => getStreamScore(b.title) - getStreamScore(a.title));

        const finalStreams = allStreams.map((s, idx) => ({
            ...s,
            title: `Source ${idx + 1} | ${s.title || 'Auto'}`
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
