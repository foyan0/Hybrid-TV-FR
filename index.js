const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const VAVOO_URL = 'https://tvvoo.hayd.uk/cfg-fr';
let channelsData = {};
// Image par défaut pour forcer l'affichage dans Nuvio/Stremio
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

function parseM3U(content) {
    const lines = content.split('\n');
    const items = [];
    let currentName = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const parts = line.split(',');
            currentName = parts.length > 1 ? parts.slice(1).join(',').trim() : 'Inconnu';
        } else if (line && !line.startsWith('#')) {
            items.push({
                title: currentName,
                url: line
            });
            currentName = '';
        }
    }
    return items;
}

async function updateStreams() {
    try {
        console.log('[Vavoo] Téléchargement de la nouvelle playlist...');
        const response = await axios.get(VAVOO_URL, { timeout: 15000 });

        const playlist = parseM3U(response.data);

        const channels = {};
        playlist.forEach(stream => {
            const cleanName = stream.title.replace(/\s*\(.*?\)\s*/g, '').trim();
            const id = 'vavoo_fr_' + cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_');
            
            if (!channels[id]) {
                channels[id] = { id, name: cleanName, streams: [] };
            }
            channels[id].streams.push(stream.url);
        });

        channelsData = channels;
        console.log(`[Vavoo] Succès : ${Object.keys(channelsData).length} chaînes chargées.`);
    } catch (err) {
        console.error('[Vavoo] Erreur :', err.message);
    }
}

// Route de diagnostic (pour tester directement dans le navigateur)
app.get('/', (req, res) => {
    const count = Object.keys(channelsData).length;
    res.send(`<h1>L'Add-on Vavoo FR est en ligne !</h1><p>Nombre de chaînes actuellement chargées en mémoire : <strong>${count}</strong></p>`);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.vavoo.fr.live',
        version: '1.0.3',
        name: 'Vavoo FR Live',
        description: 'Flux TV français',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            {
                type: 'tv',
                id: 'vavoo_fr_catalog',
                name: 'Vavoo FR TV'
            }
        ]
    });
});

app.get('/catalog/tv/vavoo_fr_catalog.json', (req, res) => {
    const metas = Object.values(channelsData).map(ch => ({
        id: ch.id,
        type: 'tv',
        name: ch.name,
        poster: DEFAULT_POSTER,
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
            poster: DEFAULT_POSTER,
            posterShape: 'square',
            description: `Regarder ${channel.name} en direct`
        }
    });
});

app.get('/stream/tv/:id.json', (req, res) => {
    const channel = channelsData[req.params.id];
    if (!channel) return res.json({ streams: [] });

    const streams = channel.streams.map((url, idx) => ({
        title: `Flux ${idx + 1}`,
        url: url
    }));

    res.json({ streams });
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
    await updateStreams();
});
