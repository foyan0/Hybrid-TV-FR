const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

let isUpdating = true;

const ADDON_PROVIDERS = [
    { id: 'vavoo', base: 'https://tvvoo.hayd.uk/cfg-fr', label: 'Vavoo', isPriority: true },
    { id: 'mio', base: 'https://tvmio.ooguy.com/eyJjb3VudHJpZXMiOlsiRlIiLCJCRV9GUiJdLCJjYXRlZ29yaWVzIjp7IkZSIjpbIkdlbmVyYWwg8J+7oiIsIlNwb3J0cyDimq3igIsiLCJEb2N1bWVudGFpcmVzIPCfijrQuiIsIkZpbG1zIPCfjqwiLCJJbmZvcm1hdGlvbnMg8J+7oiIsIkVuZmFudHMgv5G2IiwiTXVzaWMg8J+OtSJdfSwiZW5hYmxlU2VhcmNoIjpmYWxzZX0', label: 'Mio', isPriority: false }
];

let channelsData = [];
const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

function normalizeChannelName(rawName) {
    let clean = rawName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    
    clean = clean.replace(/\s*\([Tt][Vv]\)\s*/g, '');
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
        if (displayName.includes('MULTICANAL')) return 'RMC Sport (Multicanal)';
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
    
    if (n.includes('MULTICANAL')) {
        return { index: 999, category: 'vavoo_autres' };
    }

    // INFORMATION (Restauration complète de toutes les chaînes info)
    if (n.includes('BFM') || n.includes('CNEWS') || n.includes('LCI') || n.includes('FRANCE INFO') || n.includes('INFO') || n.includes('BFMTV') || n.includes('FRANCEINFO') || n.includes('FRANCE 24') || n.includes('EURONEWS') || n.includes('METEO') || n.includes('20 MINUTES')) {
        let infoIndex = 50;
        if (n.includes('TF1') && n.includes('INFO')) infoIndex = 1;
        if (n.includes('BFMTV')) infoIndex = 2;
        if (n.includes('CNEWS')) infoIndex = 3;
        if (n.includes('LCI')) infoIndex = 4;
        if (n.includes('FRANCE INFO')) infoIndex = 5;
        if (n.includes('FRANCE 24')) infoIndex = 6;
        if (n.includes('BFM BUSINESS')) infoIndex = 7;
        if (n.includes('EURONEWS')) infoIndex = 8;
        if (n.includes('METEO')) infoIndex = 9;
        if (n.includes('20 MINUTES')) infoIndex = 10;
        return { index: infoIndex, category: 'vavoo_info' };
    }

    // JEUNESSE (Ordre exact demandé sans doublon de Canal+ Kids)
    if (n === 'CARTOON NETWORK') return { index: 1, category: 'vavoo_jeunesse' };
    if (n === 'DISNEY CHANNEL') return { index: 2, category: 'vavoo_jeunesse' };
    if (n === 'GULLI') return { index: 3, category: 'vavoo_jeunesse' };
    if (n === 'NICKELODEON' && !n.includes('+1') && !n.includes('14')) return { index: 4, category: 'vavoo_jeunesse' };
    if (n === 'GAME ONE') return { index: 5, category: 'vavoo_jeunesse' };
    if (n.includes('DISNEY XD')) return { index: 6, category: 'vavoo_jeunesse' };
    if (n === 'BOOMERANG') return { index: 7, category: 'vavoo_jeunesse' };
    if (n === 'CANAL J') return { index: 8, category: 'vavoo_jeunesse' };
    if (n.includes('DISNEY JUNIOR') || n.includes('DISNEY JR')) return { index: 9, category: 'vavoo_jeunesse' };
    if (n === 'DISNEY CHANNEL +1') return { index: 50, category: 'vavoo_jeunesse' };
    if (n.includes('NICKELODEON +1') || n.includes('NICKELODEON 14')) return { index: 51, category: 'vavoo_jeunesse' };

    // DECOUVERTE
    if (n.includes('DISCOVERY') || n.includes('CRIME DISTRICT') || n.includes('USHUAIA') || n.includes('CHASSE') || n.includes('ANIMAUX') || n.includes('STAR CHANNEL')) {
        let decIndex = 10;
        if (n.includes('DISCOVERY CHANNEL')) decIndex = 1;
        if (n.includes('DISCOVERY')) decIndex = 2;
        if (n.includes('USHUAIA')) decIndex = 3;
        if (n.includes('CRIME DISTRICT')) decIndex = 4;
        if (n.includes('CHASSE')) decIndex = 5;
        if (n.includes('ANIMAUX')) decIndex = 6;
        if (n.includes('STAR CHANNEL')) decIndex = 7;
        return { index: decIndex, category: 'vavoo_decouverte' };
    }

    // CINEMA
    if (n.includes('PARAMOUNT') || n.includes('WARNER') || n.includes('ACTION') || n.includes('TCM') || n.includes('OCS') || n.includes('CINE+')) {
        let cinIndex = 10;
        if (n.includes('PARAMOUNT')) cinIndex = 1;
        if (n.includes('WARNER')) cinIndex = 2;
        if (n.includes('ACTION')) cinIndex = 3;
        if (n.includes('TCM')) cinIndex = 4;
        return { index: cinIndex, category: 'vavoo_cinema' };
    }

    // MUSIQUE
    if (n.includes('MCM') || n.includes('MEZZO') || n.includes('MTV') || n.includes('NRJ HITS')) {
        return { index: 10, category: 'vavoo_musique' };
    }

    // BOUQUET CANAL
    if (n === 'CANAL+') return { index: 1, category: 'vavoo_canal' };
    if (n === 'CANAL+ FOOT' || n === 'FOOT+') return { index: 2, category: 'vavoo_canal' };
    if (n === 'CANAL+ SPORT') return { index: 3, category: 'vavoo_canal' };
    if (n === 'CANAL+ SPORT 360') return { index: 4, category: 'vavoo_canal' };
    if (n === 'CANAL+ FORMULA 1' || n === 'CANAL+ F1') return { index: 5, category: 'vavoo_canal' };
    if (n === 'CANAL+ CINEMA') return { index: 6, category: 'vavoo_canal' };
    if (n === 'CANAL+ GRAND ECRAN') return { index: 7, category: 'vavoo_canal' };
    if (n === 'CANAL+ BOX OFFICE') return { index: 8, category: 'vavoo_canal' };
    if (n === 'CANAL+ SERIES') return { index: 9, category: 'vavoo_canal' };
    if (n === 'CANAL+ FAMILY') return { index: 10, category: 'vavoo_canal' };
    if (n === 'CANAL+ DOCS') return { index: 11, category: 'vavoo_canal' };
    if (n === 'CANAL+ KIDS') return { index: 12, category: 'vavoo_canal' };
    if (n === 'CANAL+ 4K') return { index: 13, category: 'vavoo_canal' };
    if (n.includes('CSTAR HITS')) return { index: 14, category: 'vavoo_canal' };
    if (n.includes('CANAL')) {
        return { index: 30, category: 'vavoo_canal' };
    }

    // SPORTS
    if (n.startsWith('BEIN SPORTS') || n.includes('BING SPORT')) return { index: 100, category: 'vavoo_sports' };
    if (n.startsWith('RMC SPORT')) return { index: 110, category: 'vavoo_sports' };
    if (n.startsWith('EUROSPORT')) return { index: 120, category: 'vavoo_sports' };
    if (n.startsWith('DAZN')) return { index: 130, category: 'vavoo_sports' };
    if (n.startsWith('AUTOMOTO')) return { index: 140, category: 'vavoo_sports' };
    if (n.includes('GOLF+') || n.includes('GOLF')) return { index: 150, category: 'vavoo_sports' };
    if (n.includes('EQUIDIA')) return { index: 160, category: 'vavoo_sports' };
    if (n.includes('FOOT+') || n.includes('CANAL+ SPORT') || n.includes('CANAL+ FORMULA') || n.includes('CANAL+ FOOT')) {
        return { index: 250, category: 'vavoo_sports' }; 
    }
    if (n.includes('SPORT')) return { index: 199, category: 'vavoo_sports' };

    // TNT FRANÇAISE
    let tntIndex = 500;
    if (n === 'TF1') tntIndex = 1;
    else if (n === 'FRANCE 2') tntIndex = 2;
    else if (n === 'FRANCE 3') tntIndex = 3;
    else if (n === 'FRANCE 4') tntIndex = 4;
    else if (n === 'FRANCE 5') tntIndex = 5;
    else if (n === 'M6') tntIndex = 6;
    else if (n === 'ARTE') tntIndex = 7;
    else if (n === 'C8') tntIndex = 8;
    else if (n === 'W9') tntIndex = 9;
    else if (n === 'TMC') tntIndex = 10;
    else if (n === 'TFX') tntIndex = 11;
    else if (n === 'NRJ 12' || n === 'NRJ12') tntIndex = 12;
    else if (n.includes('LCP') || n.includes('SENAT')) tntIndex = 13;
    else if (n === 'CSTAR') tntIndex = 17;
    else if (n === 'GULLI') tntIndex = 18;
    else if (n.includes('TF1 SERIES')) tntIndex = 20;
    else if (n === "L'ÉQUIPE") tntIndex = 21;
    else if (n === '6TER') tntIndex = 22;
    else if (n.includes('RMC STORY')) tntIndex = 23;
    else if (n.includes('RMC DECOUVERTE')) tntIndex = 24;
    else if (n.includes('CHERIE 25')) tntIndex = 25;

    if (tntIndex !== 500) {
        return { index: tntIndex, category: 'vavoo_tnt' };
    }

    return { index: 500, category: 'vavoo_autres' };
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
            const uName = ch.name.toUpperCase();
            
            if (uName.includes('CANAL') && (uName.includes('SPORT') || uName.includes('FOOT') || uName.includes('FORMULA') || uName.includes('FOOT+'))) {
                let sportCopy = {
                    ...ch,
                    id: ch.id + '_sport',
                    category: 'vavoo_sports',
                    sortIndex: 250
                };
                expandedChannelsMap[sportCopy.id] = sportCopy;
            }

            if (uName === 'CANAL J') {
                let jeunesseCopy = {
                    ...ch,
                    id: ch.id + '_jeunesse_canalj',
                    category: 'vavoo_jeunesse',
                    sortIndex: 8
                };
                expandedChannelsMap[jeunesseCopy.id] = jeunesseCopy;
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
        res.send(`<h1>Hybrid TV FR (v36.0)</h1><p>⏳ Chargement en cours...</p>`);
    } else {
        res.send(`<h1>Hybrid TV FR (v36.0) est en ligne !</h1><p>Chaînes actives : <strong>${channelsData.length}</strong></p>`);
    }
});

app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.hybridproxy.fr.live.v360', 
        version: '36.0.0',
        name: 'Hybrid TV FR',
        description: 'TNT, Information, Jeunesse, Découverte, Cinéma, Musique, Bouquet Canal, Sports et EPG.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            { type: 'tv', id: 'vavoo_tnt', name: 'TNT' },
            { type: 'tv', id: 'vavoo_info', name: 'Information' },
            { type: 'tv', id: 'vavoo_jeunesse', name: 'Jeunesse' },
            { type: 'tv', id: 'vavoo_decouverte', name: 'Découverte & Docu' },
            { type: 'tv', id: 'vavoo_cinema', name: 'Cinéma & Séries' },
            { type: 'tv', id: 'vavoo_musique', name: 'Musique' },
            { type: 'tv', id: 'vavoo_canal', name: 'Bouquet Canal' },
            { type: 'tv', id: 'vavoo_sports', name: 'Sports' },
            { type: 'tv', id: 'vavoo_autres', name: 'Autres Chaînes' }
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

    const validCatalogs = ['vavoo_tnt', 'vavoo_info', 'vavoo_jeunesse', 'vavoo_decouverte', 'vavoo_cinema', 'vavoo_musique', 'vavoo_canal', 'vavoo_sports', 'vavoo_autres'];
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
    const cleanId = req.params.id.replace('_sport', '').replace('_jeunesse_canalj', '').replace('_jeunesse', '');
    const channel = channelsData.find(c => c.id === req.params.id || c.id === cleanId);
    if (!channel) return res.json({ meta: {} });
    
    let descriptionText = "";

    for (const source of channel.sources) {
        if (source.type === 'addon' && source.metaId) {
            try {
                const metaRes = await axios.get(`${source.provider.base}/meta/tv/${source.metaId}.json`, { timeout: 3000 });
                if (metaRes.data && metaRes.data.meta && metaRes.data.meta.description) {
                    let desc = metaRes.data.meta.description;
                    if (!desc.toLowerCase().includes('source') && !desc.toLowerCase().includes('vavoo') && !desc.toLowerCase().includes('legal')) {
                        descriptionText = desc;
                        break;
                    }
                }
            } catch (e) {}
        }
    }

    res.json({
        meta: {
            id: req.params.id,
            type: 'tv',
            name: channel.name,
            poster: channel.poster,
            posterShape: 'square',
            description: descriptionText
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
    const cleanId = req.params.id.replace('_sport', '').replace('_jeunesse_canalj', '').replace('_jeunesse', '');
    const rawIp = req.headers['x-forwarded-for'];
    const clientIp = rawIp ? rawIp.split(',')[0].trim() : req.socket.remoteAddress;

    const channel = channelsData.find(c => c.id === req.params.id || c.id === cleanId);
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
    await updateStreams();
});
