const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

let isUpdating = true;

// --- LES SOURCES ---
const ADDON_PROVIDERS = [
    { id: 'vavoo', base: 'https://tvvoo.hayd.uk/cfg-fr', label: 'Vavoo', isPriority: true },
    { id: 'mio', base: 'https://tvmio.ooguy.com/eyJjb3VudHJpZXMiOlsiRlIiLCJCRV9GUiJdLCJjYXRlZ29yaWVzIjp7IkZSIjpbIkdlbmVyYWwg8J+7oiIsIlNwb3J0cyDimq3igIsiLCJEb2N1bWVudGFpcmVzIPCfijrQuiIsIkZpbG1zIPCfjqwiLCJJbmZvcm1hdGlvbnMg8J+7oiIsIkVuZmFudHMgv5G2IiwiTXVzaWMg8J+OtSJdfSwiZW5hYmxlU2VhcmNoIjpmYWxzZX0', label: 'Mio', isPriority: false }
];

let channelsData = [];
let epgData = {}; 
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

function normalizeChannelName(rawName) {
    let clean = rawName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    
    clean = clean.replace(/^(?:FR|BE|CH|CA|VIP)\s*[:|/-]+\s*/, '');
    clean = clean.replace(/^FR\s+/, '');
    clean = clean.replace(/\+/g, ' PLUS '); 
    clean = clean.replace(/\[.*?\]|\(.*?\)/g, ' '); 
    
    const badWords = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'VAVOO', 'DIRECT', 'RAW', 'ACCESS'];
    badWords.forEach(w => clean = clean.replace(new RegExp(`\\b${w}\\b`, 'g'), ' '));

    clean = clean.replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    let displayName = clean.replace(/PLUS/g, '+').replace(/\s+/g, ' ').trim();

    if (displayName.includes('EQUIPE')) return "L'Équipe"; 

    if (displayName.includes('DISNEY')) {
        if (displayName.includes('XD')) return 'Disney XD';
        if (displayName.includes('JUNIOR') || displayName.includes('JR')) return 'Disney Junior';
        if (displayName.includes('CINEMA')) return 'Disney Cinéma';
        if (displayName.includes('+ 1') || displayName.includes('PLUS 1')) return 'Disney Channel +1';
        if (displayName.includes('CHANNEL')) return 'Disney Channel';
        return 'Disney Channel';
    }

    if (displayName.includes('CARTOON') || displayName.includes('CN')) {
        return 'Cartoon Network';
    }

    if (displayName.includes('CANAL')) {
        if (displayName.includes('ULTRA') || displayName.includes('4K')) return 'Canal+ 4K';
        let suffix = displayName.replace(/CANAL\s*\+*/g, '').replace(/PLUS/g, '').trim();
        if (!suffix || suffix === 'LIVE') return 'Canal+';
        return `Canal+ ${suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase()}`;
    }

    if (displayName.includes('BEIN SPORT')) {
        let beinMatch = displayName.match(/BEIN SPORTS?\s*(\d+)/);
        if (beinMatch) return `beIN SPORTS ${beinMatch[1]}`;
        if (displayName.includes('MAX')) return 'beIN SPORTS MAX';
        return 'beIN SPORTS 1'; 
    }

    if (displayName.includes('RMC DECOUVERTE')) return 'RMC Découverte';
    if (displayName.includes('RMC STORY')) return 'RMC Story';
    if (displayName.includes('RMC SPORT')) {
        let rmcMatch = displayName.match(/RMC SPORT\s*(\d+)/);
        if (rmcMatch) {
            let num = parseInt(rmcMatch[1]);
            if (num > 4) return 'RMC Sport (Multicanal)';
            return `RMC Sport ${num}`;
        }
        if (displayName.includes('LIVE') || displayName.includes('MULT')) return 'RMC Sport (Multicanal)';
        return 'RMC Sport 1';
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
    if (!n) return null;
    
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
    if (n.includes('CSTAR')) return { index: 17, category: 'vavoo_tnt' };
    if (n === 'GULLI') return { index: 18, category: 'vavoo_tnt' };
    if (n.includes('TF1 SERIES')) return { index: 20, category: 'vavoo_tnt' };
    if (n === "L'ÉQUIPE") return { index: 21, category: 'vavoo_tnt' };
    if (n === '6TER') return { index: 22, category: 'vavoo_tnt' };
    if (n.includes('RMC STORY')) return { index: 23, category: 'vavoo_tnt' };
    if (n.includes('RMC DECOUVERTE')) return { index: 24, category: 'vavoo_tnt' };
    if (n.includes('CHERIE 25')) return { index: 25, category: 'vavoo_tnt' };

    if (n.includes('BFM') || n.includes('CNEWS') || n.includes('LCI') || n.includes('FRANCE INFO') || n.includes('INFO')) {
        return { index: 1, category: 'vavoo_info' };
    }

    if (n === 'DISNEY CHANNEL') return { index: 1, category: 'vavoo_jeunesse' };
    if (n === 'CARTOON NETWORK') return { index: 2, category: 'vavoo_jeunesse' };
    if (n.includes('DISNEY') || n.includes('CARTOON') || n.includes('BOOMERANG') || n.includes('NICKELODEON') || n.includes('TIJI') || n.includes('CANAL J') || n.includes('TELETOON') || n.includes('PIWI')) {
        return { index: 10, category: 'vavoo_jeunesse' };
    }

    if (n === 'CANAL+') return { index: 1, category: 'vavoo_canal' };
    if (n === 'CANAL+ 360') return { index: 2, category: 'vavoo_canal' };
    if (n === 'CANAL+ 4K') return { index: 3, category: 'vavoo_canal' };
    if (n.includes('CINEMA') || n.includes('BOX OFFICE') || n.includes('SPORT') || n.includes('FOOT') || n.includes('FORMULA') || n.includes('GRAND ECRAN') || n.includes('SERIES') || n.includes('DOCS')) {
        return { index: 10, category: 'vavoo_canal' };
    }
    if (n.startsWith('CANAL+')) return { index: 20, category: 'vavoo_canal' }; 

    if (n.startsWith('BEIN SPORTS')) return { index: 100, category: 'vavoo_sports' };
    if (n.startsWith('RMC SPORT')) return { index: 110, category: 'vavoo_sports' };
    if (n.startsWith('EUROSPORT')) return { index: 120, category: 'vavoo_sports' };
    if (n.startsWith('DAZN')) return { index: 130, category: 'vavoo_sports' };
    if (n.startsWith('AUTOMOTO')) return { index: 140, category: 'vavoo_sports' };
    if (n.includes('GOLF+')) return { index: 150, category: 'vavoo_sports' };
    if (n.includes('EQUIDIA')) return { index: 160, category: 'vavoo_sports' };
    if (n.includes('CANAL+ SPORT') || n.includes('CANAL+ FORMULA') || n.includes('CANAL+ FOOT')) {
        return { index: 250, category: 'vavoo_sports' }; 
    }
    if (n.includes('SPORT')) return { index: 199, category: 'vavoo_sports' };

    return { index: 999, category: 'vavoo_autres' };
}

async function updateEPG() {
    try {
        const res = await axios.get('https://xmltv.ch/xmltv/xmltv-tnt.xml', { timeout: 15000 });
        const xml = res.data;
        let epgChannels = {};
        let match;
        const chRegex = /<channel id="([^"]+)">\s*<display-name[^>]*>(.*?)<\/display-name>/g;
        while ((match = chRegex.exec(xml)) !== null) {
            epgChannels[match[1]] = normalizeChannelName(match[2]);
        }

        const progRegex = /<programme start="(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s?([^"]*)" stop="(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s?([^"]*)" channel="([^"]+)">.*?<title[^>]*>([^<]+)<\/title>(?:.*?<desc[^>]*>([^<]+)<\/desc>)?/gs;
        let newEpgData = {};
        while ((match = progRegex.exec(xml)) !== null) {
            const chName = epgChannels[match[15]];
            if (!chName) continue;
            const startStr = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+02:00`;
            const stopStr = `${match[8]}-${match[9]}-${match[10]}T${match[11]}:${match[12]}:${match[13]}+02:00`;
            const startTs = new Date(startStr).getTime();
            const stopTs = new Date(stopStr).getTime();
            if (!newEpgData[chName]) newEpgData[chName] = [];
            newEpgData[chName].push({ start: startTs, stop: stopTs, title: match[16].trim(), desc: match[17] ? match[17].trim() : '' });
        }
        epgData = newEpgData;
    } catch (err) {}
}

async function fetchAddonCatalog(provider) {
    let allMetas = [];
    try {
        const manifestRes = await axios.get(`${provider.base}/manifest.json`, { timeout: 10000 });
        for (const catalog of manifestRes.data.catalogs) {
            let skip = 0;
            let hasMore = true;
            let maxPages = 15;
            let pageCount = 0;
            let seenIds = new Set(); 
            while (hasMore && pageCount < maxPages) {
                pageCount++;
                try {
                    let url = `${provider.base}/catalog/${catalog.type}/${catalog.id}.json`;
                    if (skip > 0) url = `${provider.base}/catalog/${catalog.type}/${catalog.id}/skip=${skip}.json`;
                    let res = await axios.get(url, { timeout: 10000 });
                    if (res.data && res.data.metas && res.data.metas.length > 0) {
                        let newAdded = 0;
                        res.data.metas.forEach(m => {
                            if (!seenIds.has(m.id)) {
                                seenIds.add(m.id);
                                allMetas.push(m);
                                newAdded++;
                            }
                        });
                        if (newAdded === 0) hasMore = false; 
                        else skip += res.data.metas.length; 
                    } else { hasMore = false; }
                } catch (e) {
                    hasMore = false;
                }
            }
        }
    } catch (err) {}
    return allMetas;
}

async function updateStreams() {
    isUpdating = true;
    try {
        let channelsMap = {};

        for (const provider of ADDON_PROVIDERS) {
            const metas = await fetchAddonCatalog(provider);
            metas.forEach(meta => {
                let dName = normalizeChannelName(meta.name);
                if (!dName || dName.length < 2) return; 
                
                const metaInfo = getChannelMeta(dName) || { index: 500, category: 'vavoo_autres' }; 

                const id = 'hyb_id_' + dName.replace(/[^a-zA-Z0-9+]/g, '_').toLowerCase();

                if (!channelsMap[id]) {
                    channelsMap[id] = { id, name: dName, sources: [], poster: meta.poster || DEFAULT_POSTER, sortIndex: metaInfo.index, category: metaInfo.category };
                }
                
                const sourceExists = channelsMap[id].sources.find(s => s.metaId === meta.id && s.provider && s.provider.id === provider.id);
                if (!sourceExists) channelsMap[id].sources.push({ type: 'addon', metaId: meta.id, provider: provider });
                
                if (meta.poster && channelsMap[id].poster === DEFAULT_POSTER) {
                    channelsMap[id].poster = meta.poster;
                }
            });
        }

        let expandedChannelsMap = {};
        Object.values(channelsMap).forEach(ch => {
            expandedChannelsMap[ch.id] = ch;
            if (ch.name.includes('CANAL+') && (ch.name.includes('SPORT') || ch.name.includes('FOOT') || ch.name.includes('FORMULA'))) {
                let sportCopy = {
                    ...ch,
                    id: ch.id + '_sport',
                    category: 'vavoo_sports',
                    sortIndex: 250
                };
                expandedChannelsMap[sportCopy.id] = sportCopy;
            }
        });

        channelsData = Object.values(expandedChannelsMap).filter(ch => ch.sources && ch.sources.length > 0);

        channelsData.sort((a, b) => {
            if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
            return a.name.localeCompare(b.name);
        });

    } catch (err) {}
    isUpdating = false; 
}

app.get('/', (req, res) => {
    if (isUpdating) {
        res.send(`<h1>Hybrid TV FR (v27.3)</h1><p>⏳ Chargement en cours...</p>`);
    } else {
        res.send(`<h1>Hybrid TV FR (v27.3) est en ligne !</h1><p>Chaînes actives : <strong>${channelsData.length}</strong></p>`);
    }
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.hybridproxy.fr.live.v273', 
        version: '27.3.0',
        name: 'Hybrid TV FR',
        description: 'TNT, Information, Jeunesse, Bouquet Canal, Sports et EPG en direct.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            { type: 'tv', id: 'vavoo_tnt', name: '📺 TNT Française' },
            { type: 'tv', id: 'vavoo_info', name: '📰 Information' },
            { type: 'tv', id: 'vavoo_jeunesse', name: '👶 Jeunesse (Disney & CN)' },
            { type: 'tv', id: 'vavoo_canal', name: '🎟️ Bouquet Canal' },
            { type: 'tv', id: 'vavoo_sports', name: '⚽ Sports' },
            { type: 'tv', id: 'vavoo_autres', name: '📂 Autres Chaînes' }
        ]
    });
});

const handleCatalog = (req, res) => {
    const requestedCatalog = req.params.id; 
    let skip = 0;
    if (req.params.extra) {
        const match = req.params.extra.match(/skip=(\d+)/);
        if (match) skip = parseInt(match[1], 10);
    }

    const validCatalogs = ['vavoo_tnt', 'vavoo_info', 'vavoo_jeunesse', 'vavoo_canal', 'vavoo_sports', 'vavoo_autres'];
    if (!validCatalogs.includes(requestedCatalog)) return res.json({ metas: [] });
    
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

app.get('/meta/tv/:id.json', async (req, res) => {
    const id = req.params.id.replace('_sport', '');
    const channel = channelsData.find(c => c.id === req.params.id || c.id === id);
    if (!channel) return res.json({ meta: {} });
    
    let desc = "🔴 EN DIRECT :\nProgramme TV non disponible actuellement.";
    
    if (epgData[channel.name]) {
        const now = Date.now();
        const currentProg = epgData[channel.name].find(p => now >= p.start && now <= p.stop);
        if (currentProg) {
            desc = `🔴 EN DIRECT : ${currentProg.title}\n\n${currentProg.desc || 'Aucun détail supplémentaire.'}`;
        }
    }

    res.json({
        meta: {
            id: req.params.id,
            type: 'tv',
            name: channel.name,
            poster: channel.poster,
            posterShape: 'square',
            description: desc
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
    const realId = req.params.id.replace('_sport', '');
    const rawIp = req.headers['x-forwarded-for'];
    const clientIp = rawIp ? rawIp.split(',')[0].trim() : req.socket.remoteAddress;

    const channel = channelsData.find(c => c.id === req.params.id || c.id === realId);
    if (!channel) return res.json({ streams: [] });
    
    try {
        let allStreams = [];
        for (const source of channel.sources) {
            if (source.type === 'addon') {
                try {
                    const streamRes = await axios.get(`${source.provider.base}/stream/tv/${source.metaId}.json`, {
                        headers: { 'X-Forwarded-For': clientIp }, timeout: 10000 
                    });
                    if (streamRes.data && streamRes.data.streams) {
                        const mappedStreams = streamRes.data.streams.map(s => ({
                            ...s,
                            _score: getStreamScore(s.title),
                            _label: source.provider.label, 
                            _isPriority: source.provider.isPriority
                        }));
                        allStreams = allStreams.concat(mappedStreams);
                    }
                } catch (err) {}
            }
        }
        
        allStreams.sort((a, b) => {
            if (a._label === 'Vavoo' && b._label === 'Mio') return -1; 
            if (a._label === 'Mio' && b._label === 'Vavoo') return 1;
            return b._score - a._score;
        });

        const finalStreams = allStreams.map((s, idx) => ({
            url: s.url,
            title: `[${s._label}] Choix ${idx + 1} | ${s.title.replace(/\[.*?\]\s*/g, '') || 'Auto'}`
        }));
        
        res.json({ streams: finalStreams });
    } catch (err) {
        res.json({ streams: [] });
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
    await updateEPG(); 
    await updateStreams();
    setInterval(updateEPG, 3600000); 
});
