const express = require('express');
const fetch = require('node-fetch');
const m3uParser = require('m3u-parser-generator');
const cors = require('cors');

const app = express();
app.use(cors());

const VAVOO_URL = 'httpvavoo.toplaylist.m3u';
let channelsData = {};  Cache local

 1. Récupération et parsing des flux Vavoo
async function updateStreams() {
    try {
        const response = await fetch(VAVOO_URL);
        const m3uData = await response.text();
        const playlist = m3uParser.parse(m3uData);

        const frenchStreams = playlist.medias.filter(media = 
            media.title.toLowerCase().includes('fr')  media.title.toLowerCase().includes('france')
        );

        const channels = {};
        frenchStreams.forEach(stream = {
            const cleanName = stream.title.replace(s(.)sg, '').trim();
            const id = 'vavoo_fr_' + cleanName.toLowerCase().replace([^a-z0-9]g, '_');
            
            if (!channels[id]) {
                channels[id] = { id, name cleanName, streams [] };
            }
            channels[id].streams.push(stream.location);
        });

        channelsData = channels;
        console.log(`[Vavoo] ${Object.keys(channelsData).length} chaînes françaises chargées.`);
    } catch (err) {
        console.error('Erreur chargement Vavoo', err);
    }
}

 2. Manifest
app.get('manifest.json', (req, res) = {
    res.json({
        id 'org.vavoo.fr.live',
        version '1.0.0',
        name 'Vavoo FR Live',
        description 'Flux TV français issus de Vavoo',
        resources ['catalog', 'stream'],
        types ['tv'],
        catalogs [
            {
                type 'tv',
                id 'vavoo_fr_catalog',
                name 'Vavoo FR TV'
            }
        ]
    });
});

 3. Catalogue des chaînes
app.get('catalogtvvavoo_fr_catalog.json', (req, res) = {
    const metas = Object.values(channelsData).map(ch = ({
        id ch.id,
        type 'tv',
        name ch.name,
        posterShape 'square'
    }));
    res.json({ metas });
});

 4. Flux multiples pour une chaîne sélectionnée
app.get('streamtvid.json', (req, res) = {
    const channel = channelsData[req.params.id];
    if (!channel) return res.json({ streams [] });

    const streams = channel.streams.map((url, idx) = ({
        title `Flux ${idx + 1}`,
        url url
    }));

    res.json({ streams });
});

const PORT = process.env.PORT  7000;
app.listen(PORT, async () = {
    await updateStreams();
    console.log(`Addon en ligne sur le port ${PORT}`);
});