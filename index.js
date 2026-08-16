const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const TVVOO_BASE = 'https://tvvoo.hayd.uk/cfg-fr';
let channelsData = []; 
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

// Fonction experte pour nettoyer, corriger et regrouper les chaînes
function normalizeChannelName(rawName) {
    let clean = rawName.toUpperCase();

    // 1. Correction du bug des lettres disparues (on ne supprime FR/BE/CA que si c'est un préfixe isolé)
    clean = clean.replace(/^(?:FR|BE|CH|CA|VIP)\s*[:|/-]+\s*/, '');
    clean = clean.replace(/^FR\s+/, '');
    
    // 2. Protection des caractères importants
    clean = clean.replace(/\+/g, ' PLUS '); 
    clean = clean.replace(/\[.*?\]|\(.*?\)/g, ' '); 
    
    // 3. Suppression des mots parasites (J'ai retiré "FRANCE" et "TV" de la liste noire)
    const badWords = ['FHD', 'HD', 'SD', '4K', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'VAVOO', 'DIRECT', 'RAW'];
    badWords.forEach(w => {
        clean = clean.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
    });

    clean = clean.replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    let displayName = clean.replace(/PLUS/g, '+');

    // 4. Regroupement intelligent (Sports et Disney)
    if (displayName.includes('RMC SPORT')) {
        if (displayName.includes('LIVE') || displayName.match(/RMC SPORT\s*(?:[5-9]|1\d)/)) return 'RMC Sport (Multicanal)';
        return displayName.replace('RMC SPORT', 'RMC Sport'); // Garde RMC Sport 1, 2...
    }
    if (displayName.includes('BEIN SPORT')) {
        if (displayName.includes('MAX')) return 'beIN SPORTS MAX (Multicanal)';
        return displayName.replace('BEIN SPORT', 'beIN SPORTS'); 
    }
    if (displayName.includes('EUROSPORT')) {
        if (displayName.match(/EUROSPORT\s*(?:[3-9]|360)/)) return 'Eurosport (Multicanal)';
        return displayName.replace('EUROSPORT', 'Eurosport');
    }
    if (displayName.includes('DAZN')) {
        if (displayName.match(/DAZN\s*(?:[2-9]|1\d)/)) return 'DAZN (Multicanal)';
        return displayName;
    }
    if (displayName.includes('DISNEY')) {
        if (displayName.includes('CHANNEL')) return 'Disney Channel';
        if (displayName.includes('+') || displayName.includes('PLUS')) return 'Disney+';
    }

    // 5. Corrections esthétiques (Titre propre)
    if (displayName === 'FRANCE 2') return 'France 2';
    if (displayName === 'FRANCE 3') return 'France 3';
    if (displayName === 'FRANCE 4') return 'France 4';
    if (displayName === 'FRANCE 5') return 'France 5';
    if (displayName.includes('FRANCE INFO')) return 'France Info';
    if (displayName === 'CANAL+') return 'Canal+';
    
    return displayName;
}

// Ordre des chaînes
function getSortIndex(channelName) {
    const n = channelName.toUpperCase();
    
    if (n === 'TF1') return 1;
    if (n === 'FRANCE 2') return 2;
    if (n === 'FRANCE 3') return 3;
    if (n === 'CANAL+') return 4;
    if (n === 'FRANCE 5') return 5;
    if (n === 'M6') return 6;
    if (n === 'ARTE') return 7;
    if (n === 'C8') return 8;
    if (n === 'W9') return 9;
    if (n === 'TMC') return 10;
    if (n === 'TFX') return 11;
    if (n === 'NRJ 12' || n === 'NRJ12') return 12;
    if (n.includes('LCP') || n.includes('SENAT')) return 13;
    if (n === 'FRANCE 4') return 14;
    if (n.includes('BFM')) return 15;
    if (n.includes('CNEWS')) return 16;
    if (n.includes('CSTAR')) return 17;
    if (n === 'GULLI') return 18;
    if (n.includes('TF1 SERIES')) return 20;
    if (n.includes('EQUIPE')) return 21;
    if (n === '6TER') return 22;
    if (n.includes('RMC STORY')) return 23;
    if (n.includes('RMC DECOUVERTE')) return 24;
    if (n.includes('CHERIE 25')) return 25;
    if (n === 'LCI') return 26;
    if (n.includes('FRANCE INFO')) return 27;

    if (n.startsWith('CANAL+')) return 30;
    if (n.startsWith('BEIN SPORTS MAX')) return 41;
    if (n.startsWith('BEIN SPORTS')) return 40;
    if (n.startsWith('DAZN (MULTI')) return 43;
    if (n.startsWith('DAZN')) return 42;
    if (n.startsWith('RMC SPORT (MULTI')) return 45;
    if (n.startsWith('RMC SPORT')) return 44;
    if (n.startsWith('EUROSPORT (MULTI')) return 47;
    if (n.startsWith('EUROSPORT')) return 46;
    if (n.startsWith('AUTOMOTO')) return 48;
    if (n.startsWith('GOLF+')) return 49;
    if (n.includes('SPORT')) return 50; 
    
    if (n.startsWith('CINE+')) return 60;
    if (n.startsWith('OCS')) return 61;
    if (n.includes('DISNEY')) return 62;

    return 999;
}

async function updateStreams() {
    try {
        console.log('[TvVoo Proxy] Récupération et application des corrections...');
        const manifestRes = await axios.get(`${TVVOO_BASE}/manifest.json`, { timeout: 10000 });
        const catalogId = manifestRes.data.catalogs[0].id;
        const catalogRes = await axios.get(`${TVVOO_BASE}/catalog/tv/${catalogId}.json`, { timeout: 15000 });
        const metas = catalogRes.data.metas || [];
        
        let channelsMap = {};

        metas.forEach(meta => {
            if (!meta.name) return;
            
            let displayName = normalizeChannelName(meta.name);
            if (!displayName || displayName.length < 2) return; // Ignore les erreurs isolées comme "P", "TV"

            const id = 'vavoo_all_' + displayName.replace(/[^a-zA-Z0-9+]/g, '_').toLowerCase();

            if (!channelsMap[id]) {
                channelsMap[id] = {
                    id: id,
                    name: displayName,
                    originalIds: [],
                    poster: meta.poster || DEFAULT_POSTER,
                    sortIndex: getSortIndex(displayName)
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

        console.log(`[TvVoo Proxy] Succès : ${channelsData.length} chaînes corrigées et triées.`);
    } catch (err) {
        console.error('[TvVoo Proxy] Erreur :', err.message);
    }
}

// Ping amélioré (moins agressif)
async function checkStreamValid(url) {
    try {
        // Un GET rapide (seulement quelques octets) avec 3 secondes de délai au lieu de 1.5s
        await axios.get(url, { 
            headers: { 'Range': 'bytes=0-100' },
            timeout: 3000 
        });
        return true;
    } catch (e) {
        // On n'élimine que si on a une preuve stricte que c'est mort (404) ou planté (502, 503)
        if (e.response && [404, 502, 503].includes(e.response.status)) {
            return false; 
        }
        return true; 
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
    res.send(`<h1>Vavoo FR (v7.0 - Bouquet Parfait) est en ligne !</h1><p>Nombre total de chaînes regroupées : <strong>${channelsData.length}</strong></p>`);
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.vavooproxy.fr.live',
        version: '7.0.0',
        name: 'Vavoo FR Pro',
        description: 'Toutes les chaînes triées, multicanaux regroupés, flux morts filtrés.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            {
                type: 'tv',
                id: 'vavoo_fr_all',
                name: 'TV Française'
            }
        ]
    });
});

const handleCatalog = (req, res) => {
    let skip = 0;
    if (req.params.extra) {
        const match = req.params.extra.match(/skip=(\d+)/);
        if (match) skip = parseInt(match[1], 10);
    }

    const paginatedMetas = channelsData.slice(skip, skip + 100).map(ch => ({
        id: ch.id,
        type: 'tv',
        name: ch.name,
        poster: ch.poster,
        posterShape: 'square'
    }));
    
    res.json({ metas: paginatedMetas });
};

app.get('/catalog/tv/vavoo_fr_all.json', handleCatalog);
app.get('/catalog/tv/vavoo_fr_all/:extra', handleCatalog);

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
            description: `${channel.originalIds.length} sources analysées. Choix par qualité.`
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
        
        const checkedStreams = await Promise.all(allStreams.map(async (s) => {
            const isValid = await checkStreamValid(s.url);
            return isValid ? s : null;
        }));
        
        let validStreams = checkedStreams.filter(s => s !== null);

        if (validStreams.length === 0 && allStreams.length > 0) {
            validStreams = allStreams;
        }

        validStreams.sort((a, b) => getStreamScore(b.title) - getStreamScore(a.title));

        const finalStreams = validStreams.map((s, idx) => ({
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
