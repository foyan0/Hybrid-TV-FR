const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const VAVOO_URL = 'http://vavoo.to/playlist.m3u';
let channelsData = {};

// Parseur M3U natif
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

// Récupération des flux
async function updateStreams() {
    try {
        console.log('[Vavoo] Téléchargement de la playlist...');
        const response = await axios.get(VAVOO_URL, {
            headers: {
                'User-Agent': 'VAVOO/2.6'
            },
            timeout: 15000
        });

        const playlist = parseM3U(response.data);
        const frenchStreams = playlist.filter(media => 
            media.title.toLowerCase().includes('fr') || media.title.toLowerCase().includes('france')
        );

        const channels = {};
        frenchStreams.forEach(stream => {
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
        console.error('[Vavoo] Erreur lors de la récupération des flux :', err.message);
    }
}

// Routes Add-on
app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.vavoo.fr.live',
        version: '1.0.0',
        name: 'Vavoo FR Live',
        description: 'Flux TV français issus de Vavoo',
        resources: ['catalog', 'stream'],
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
        posterShape: 'square'
    }));
    res.json({ metas });
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
