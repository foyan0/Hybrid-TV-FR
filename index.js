const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// URL de base de l'add-on source TvVoo
const TVVOO_BASE = 'https://tvvoo.hayd.uk/cfg-fr';
let channelsData = {};
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

async function updateStreams() {
    try {
        console.log('[TvVoo Proxy] Connexion à TvVoo...');
        
        // 1. Découverte du catalogue
        const manifestRes = await axios.get(`${TVVOO_BASE}/manifest.json`, { timeout: 10000 });
        const catalogId = manifestRes.data.catalogs[0].id;

        // 2. Récupération des chaînes
        console.log(`[TvVoo Proxy] Récupération du catalogue...`);
        const catalogRes = await axios.get(`${TVVOO_BASE}/catalog/tv/${catalogId}.json`, { timeout: 15000 });
        
        const metas = catalogRes.data.metas || [];
        const channels = {};

        // 3. Regroupement intelligent
        metas.forEach(meta => {
            // Nettoyer les noms type "TF1 (FHD)" -> "TF1"
            let cleanName = meta.name.replace(/\s*\(.*?\)\s*/g, '').replace(/\b(FHD|HD|SD|4K)\b/gi, '').trim();
            const id = 'proxy_fr_' + cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_');
            
            if (!channels[id]) {
                channels[id] = { 
                    id, 
                    name: cleanName, 
                    originalIds: [],
                    poster: meta.poster || DEFAULT_POSTER
                };
            }
            // On sauvegarde l'ID original de TvVoo pour demander le flux plus tard
            channels[id].originalIds.push(meta.id);
        });

        channelsData = channels;
        console.log(`[TvVoo Proxy] Succès : ${Object.keys(channelsData).length} chaînes regroupées à partir de ${metas.length} sources.`);
    } catch (err) {
        console.error('[TvVoo Proxy] Erreur :', err.message);
    }
}

// Page de diagnostic web
app.get('/', (req, res) => {
    const count = Object.keys(channelsData).length;
    res.send(`<h1>L'Add-on Vavoo FR (Mode Proxy) est en ligne !</h1><p>Nombre de chaînes françaises regroupées : <strong>${count}</strong></p>`);
});

// Manifest Stremio/Nuvio
app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.vavooproxy.fr.live',
        version: '2.0.0',
        name: 'Vavoo FR Groupé',
        description: 'Chaînes françaises avec choix des sources',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            {
                type: 'tv',
                id: 'vavoo_fr_grouped',
                name: 'TV Française'
            }
        ]
    });
});

app.get('/catalog/tv/vavoo_fr_grouped.json', (req, res) => {
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
            description: `Regarder ${channel.name} en direct (${channel.originalIds.length} sources disponibles)`
        }
    });
});

// Récupération des flux en temps réel lors du clic !
app.get('/stream/tv/:id.json', async (req, res) => {
    const channel = channelsData[req.params.id];
    if (!channel) return res.json({ streams: [] });

    // Transférer ton adresse IP à TvVoo pour éviter les blocages de sécurité
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        let allStreams = [];
        
        // On interroge l'add-on TvVoo pour chaque source trouvée
        for (let i = 0; i < channel.originalIds.length; i++) {
            const originalId = channel.originalIds[i];
            const streamRes = await axios.get(`${TVVOO_BASE}/stream/tv/${originalId}.json`, {
                headers: { 'X-Forwarded-For': clientIp } // Envoi de l'IP du lecteur
            });
            
            if (streamRes.data && streamRes.data.streams) {
                const streams = streamRes.data.streams.map(s => ({
                    ...s,
                    title: `Source ${i + 1} | ${s.title || 'Direct'}`
                }));
                allStreams = allStreams.concat(streams);
            }
        }
        
        res.json({ streams: allStreams });
    } catch (err) {
        console.error('Erreur flux:', err.message);
        res.json({ streams: [] });
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
    await updateStreams(); // Charge le catalogue au démarrage
});
