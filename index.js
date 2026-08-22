const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');

const app = express();
app.use(cors());

let isUpdatingEPG = false;
let lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
let epgData = {}; 
let channelsCache = {}; 

const DEFAULT_POSTER = 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/api/images/stremio-placeholder.jpg';

const BLACKLIST = [
    'ALACARTE', 'DISNEYPLUS', 'NETFLIX', 'PRIMEVIDEO', 'APPLETV',
    'TEST', 'MIRROR', 'BACKUPCHANNEL', 'BOXOFFICE1', 'BOXOFFICE2', 'CANALPLAY', 'AFRIQUE', 'DEUTSCH', 'GERMAN'
];

// Logos VIP (Optionnels via le bouton ON/OFF)
const LOGOS = {
    'hyb_tnt_1': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/TF1_2013_logo.svg/512px-TF1_2013_logo.svg.png',
    'hyb_tnt_2': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/France_2_logo_2018.svg/512px-France_2_logo_2018.svg.png',
    'hyb_tnt_3': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/France_3_logo_2018.svg/512px-France_3_logo_2018.svg.png',
    'hyb_tnt_4': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/France_4_logo_2018.svg/512px-France_4_logo_2018.svg.png',
    'hyb_tnt_5': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/67/France_5_logo_2018.svg/512px-France_5_logo_2018.svg.png',
    'hyb_tnt_6': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/M6_logo_2020.svg/512px-M6_logo_2020.svg.png',
    'hyb_tnt_7': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/Arte_logo_2017.svg/512px-Arte_logo_2017.svg.png',
    'hyb_tnt_8': 'https://upload.wikimedia.org/wikipedia/commons/0/07/C8_t%C3%A9l%C3%A9.png',
    'hyb_tnt_9': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/62/W9-Logo.svg/512px-W9-Logo.svg.png',
    'hyb_tnt_10': 'https://upload.wikimedia.org/wikipedia/fr/thumb/a/a8/TMC_logo_2016.svg/512px-TMC_logo_2016.svg.png',
    'hyb_tnt_11': 'https://upload.wikimedia.org/wikipedia/fr/thumb/8/83/TFX_logo_2018.svg/512px-TFX_logo_2018.svg.png',
    'hyb_tnt_12': 'https://upload.wikimedia.org/wikipedia/fr/4/44/NRJ12-Logo.png',
    'hyb_tnt_13': 'https://upload.wikimedia.org/wikipedia/fr/thumb/b/b3/LCP_Assemblée_Nationale_logo_2018.svg/512px-LCP_Assemblée_Nationale_logo_2018.svg.png',
    'hyb_tnt_17': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Logo_CStar_2016.svg/512px-Logo_CStar_2016.svg.png',
    'hyb_jeu_gulli': 'https://focus.telerama.fr/500x500/0000/00/01/clear-43.png',
    'hyb_tnt_20': 'https://upload.wikimedia.org/wikipedia/fr/thumb/4/4b/TF1_S%C3%A9ries_Films_logo_2020.svg/512px-TF1_S%C3%A9ries_Films_logo_2020.svg.png',
    'hyb_tnt_22': 'https://upload.wikimedia.org/wikipedia/fr/a/a9/6ter_2012.png',
    'hyb_tnt_23': 'https://upload.wikimedia.org/wikipedia/fr/thumb/8/8a/RMC_Story_logo_2018.svg/512px-RMC_Story_logo_2018.svg.png',
    'hyb_tnt_24': 'https://upload.wikimedia.org/wikipedia/fr/thumb/c/c6/RMC_Découverte_logo_2018.svg/512px-RMC_Découverte_logo_2018.svg.png',
    'hyb_tnt_25': 'https://logowik.com/content/uploads/images/cherie-255806.logowik.com.webp',
    'hyb_tnt_rtl9': 'https://www.rtl9.com/upload/media/logo-rtl9-rvb-64784327dd675.png',
    'hyb_tnt_13rue': 'https://www.lyngsat.com/logo/tv/num/13eme_rue_fr.png',
    'hyb_tnt_teva': 'https://focus.telerama.fr/500x500/0000/00/01/clear-197.png',
    'hyb_tnt_ab1': 'https://upload.wikimedia.org/wikipedia/fr/9/9a/Logo_AB1_2021.png',
    
    'hyb_info_1': 'https://upload.wikimedia.org/wikipedia/commons/4/40/BFM_TV_logo.png',
    'hyb_info_biz': 'https://upload.wikimedia.org/wikipedia/fr/thumb/c/ca/BFM_Business_logo_2019.svg/512px-BFM_Business_logo_2019.svg.png',
    'hyb_info_2': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/CNews_logo_2017.svg/512px-CNews_logo_2017.svg.png',
    'hyb_info_3': 'https://upload.wikimedia.org/wikipedia/fr/b/b4/LCI_logo_%282016%29.png',
    'hyb_info_4': 'https://upload.wikimedia.org/wikipedia/fr/thumb/c/c2/Franceinfo_logo_2016.svg/512px-Franceinfo_logo_2016.svg.png',
    'hyb_info_5': 'https://i.postimg.cc/TPwp9d9B/640px-France24.png',
    'hyb_info_meteo': 'https://focus.telerama.fr/500x500/0000/00/01/clear-158.png',
    'hyb_info_vosges': 'https://focus.telerama.fr/500x500/0000/00/01/clear-1776.png',
    'hyb_info_tlm': 'https://upload.wikimedia.org/wikipedia/fr/0/0a/TLM_logo.png',
    'hyb_info_lille': 'https://upload.wikimedia.org/wikipedia/fr/thumb/1/15/BFM_Grand_Lille_logo_2022.svg/512px-BFM_Grand_Lille_logo_2022.svg.png',
    'hyb_info_lyon': 'https://upload.wikimedia.org/wikipedia/fr/thumb/f/f7/BFM_Lyon_logo_2022.svg/512px-BFM_Lyon_logo_2022.svg.png',
    'hyb_info_paris': 'https://upload.wikimedia.org/wikipedia/fr/thumb/8/8c/BFM_Paris_Île-de-France_logo_2022.svg/512px-BFM_Paris_Île-de-France_logo_2022.svg.png',
    
    'hyb_canal_cplus': 'https://upload.wikimedia.org/wikipedia/commons/3/39/Canal%2B_Film_HD.png',
    'hyb_canal_cinema': 'https://upload.wikimedia.org/wikipedia/fr/e/eb/C%2B_Cin%C3%A9ma%28s%29.png',
    'hyb_canal_grandecran': 'https://upload.wikimedia.org/wikipedia/fr/d/da/C%2B_Grand_%C3%89cran.png',
    'hyb_canal_series': 'https://upload.wikimedia.org/wikipedia/fr/e/e3/C%2B_S%C3%A9ries.png',
    'hyb_canal_kids': 'https://upload.wikimedia.org/wikipedia/commons/0/0c/Canal%2B_Kids.png',
    'hyb_canal_docs': 'https://upload.wikimedia.org/wikipedia/commons/2/27/Canal%2B_Docs.png',
    'hyb_canal_premier': 'https://upload.wikimedia.org/wikipedia/commons/7/73/Canalplus_fr_cine_plus_premier_hd.png',
    'hyb_canal_frisson': 'https://focus.telerama.fr/500x500/0000/00/01/clear-147.png',
    'hyb_canal_boxoffice': 'https://upload.wikimedia.org/wikipedia/fr/5/55/C%2B_Box_Office.png',
    'hyb_cine_comedie': 'https://upload.wikimedia.org/wikipedia/commons/3/3e/Com%C3%A9die%2B_logo_%C3%A0_l%27antenne.png',
    'hyb_canal_family': 'http://schedulesdirect-api20141201-logos.s3.amazonaws.com/stationLogos/s87283_dark_360w_270h.png',
    'hyb_canal_decale': 'https://www.staderochelais.com/sites/stade-rochelais/files/logos/canal-decale-1622622027.png',
    'hyb_jeu_canalj': 'https://upload.wikimedia.org/wikipedia/fr/6/69/Logo_canal_J.png',
    
    'hyb_sport_ligue1plus': 'https://focus.telerama.fr/500x500/0000/00/01/clear-1845.png',
    'hyb_canal_sport': 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Canal%2B_Sport_2015.png',
    'hyb_canal_foot': 'https://upload.wikimedia.org/wikipedia/commons/e/eb/Canal%2BFoot.png',
    'hyb_canal_sport360': 'https://upload.wikimedia.org/wikipedia/commons/6/64/Canal%2BSport_360.png',
    'hyb_sport_bein1': 'https://c0.klipartz.com/pngpicture/320/259/gratis-png-bein-sports-1-logo-bein-taquilla-bein-media-group-canal-de-television.png',
    'hyb_sport_bein2': 'https://upload.wikimedia.org/wikipedia/commons/c/c9/Logo_bein_sports_2.png',
    'hyb_sport_bein3': 'https://upload.wikimedia.org/wikipedia/commons/c/c4/Logo_bein_sports_3.png',
    'hyb_sport_rmc1': 'https://upload.wikimedia.org/wikipedia/commons/3/3b/Logo_RMC_Sport_1_2018.svg.png',
    'hyb_sport_euro1': 'https://upload.wikimedia.org/wikipedia/commons/d/d0/Eurosport_1_Logo_2015.svg.png',
    'hyb_sport_lequipe': 'https://focus.telerama.fr/500x500/0000/00/01/clear-46.png',
    'dazn_generic': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/06/DAZN_Logo_Master.svg/512px-Logo_Master.svg.png',

    'hyb_cine_emotion': 'https://thumb.canalplus.pro/http/unsafe/epg.canal-plus.com/mycanal/img/CHN43FN/PNG/213X160/CHN43FB_396.PNG',
    'hyb_cine_famiz': 'https://static.wikia.nocookie.net/logo-chaines/images/6/64/CinePlusFamiz_Logo.svg.png',
    'hyb_cine_club': 'https://upload.wikimedia.org/wikipedia/fr/7/77/Cin%C3%A9Cin%C3%A9ma_Club_logo_2008.png',
    'hyb_cine_classic': 'https://upload.wikimedia.org/wikipedia/fr/f/f3/Cin%C3%A9_Cin%C3%A9ma_Classic.png',
    'hyb_cine_action': 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRPdxSas0cWbgadzbAuhDjqLEd_Y4iMG0odsUoZy8ch1NJYK3ZVez_yrHCoAA&s',
    'hyb_cine_paramount': 'https://upload.wikimedia.org/wikipedia/fr/5/59/Paramount_Channel.svg.png',

    'hyb_dec_crime': 'https://www.lyngsat.com/logo/tv/cc/crime_district_fr.png',
    'hyb_dec_natgeo': 'https://focus.telerama.fr/500x500/0000/00/01/clear-243.png',
    'hyb_dec_discovery': 'https://upload.wikimedia.org/wikipedia/commons/2/27/Discovery_Channel_-_Logo_2019.svg.png',
    'hyb_dec_planete': 'https://focus.telerama.fr/500x500/0000/00/01/clear-147.png',
    'hyb_dec_histoire': 'https://upload.wikimedia.org/wikipedia/fr/thumb/5/5c/Histoire_TV_logo_2019.svg/512px-Histoire_TV_logo_2019.svg.png',
    
    'hyb_jeu_cartoon': 'https://upload.wikimedia.org/wikipedia/commons/f/fe/CARTOON_NETWORK_logo.png',
    'hyb_jeu_disney': 'https://upload.wikimedia.org/wikipedia/commons/7/78/Disney_Channel_Germany_Logo_2014.png',
    'hyb_jeu_nick': 'https://upload.wikimedia.org/wikipedia/commons/f/fa/Nickelodeon_logo_2009.png',
    'hyb_jeu_gameone': 'https://upload.wikimedia.org/wikipedia/fr/thumb/a/a0/Game_One_%281998%29_Logo.svg/512px-Game_One_%281998%29_Logo.svg.png',
    'hyb_jeu_boom': 'https://focus.telerama.fr/500x500/0000/00/01/clear-321.png',
    'hyb_jeu_boing': 'https://upload.wikimedia.org/wikipedia/commons/9/91/Boing_logo_2016_%28France%29.svg.png',
    'hyb_jeu_disneyjr': 'https://upload.wikimedia.org/wikipedia/fr/3/36/Disney_Junior_2011.png',
    'hyb_jeu_tiji': 'https://focus.telerama.fr/500x500/0000/00/01/clear-229.png',
    'hyb_jeu_piwi': 'https://focus.telerama.fr/500x500/0000/00/01/clear-344.png',
    'hyb_jeu_mangas': 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQrBITj8D4ehy326isxvvHDFUivw37wiREtViWbndOOtqIoq8ykrTbVbQQADg&s',

    'hyb_mus_mtv': 'https://upload.wikimedia.org/wikipedia/commons/0/0d/MTV-2021.svg.png',
    'hyb_mus_mcm': 'https://upload.wikimedia.org/wikipedia/fr/a/ab/MCM_logo_2017.svg.png'
};

function parseConfig(encodedConfig) {
    try {
        if (!encodedConfig || encodedConfig === 'manifest.json') return { sources: [], epg: true, logos: true };
        const jsonStr = Buffer.from(encodedConfig, 'base64').toString('utf8');
        return JSON.parse(jsonStr);
    } catch (e) {
        return { sources: [], epg: true, logos: true };
    }
}

// === MOTEUR D'EXTRACTION ADN ===
function getChannelData(rawName) {
    if (!rawName) return null;
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    n = n.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ');
    n = n.replace(/^(?:FR|BE|CH|CA|VIP|VAVOO)\s*[:|/-]+\s*/i, '');
    n = n.replace(/DURING EVENT ONLY/g, '').replace(/EVENT ONLY/g, '');
    
    const tags = ['FHD', 'HD', 'SD', '4K', 'UHD', '1080P', '720P', '1080', '720', 'HEVC', 'H265', 'VOD', 'BACKUP', 'SECOURS', 'VIP', 'DIRECT', 'RAW', 'ACCESS'];
    tags.forEach(tag => { n = n.replace(new RegExp(`\\b${tag}\\b`, 'gi'), ''); });

    // --- 0. LIGUE 1+ ISOLÉ AU SOMMET ---
    if (n.includes('LIGUE 1+') || n.includes('LIGUE1+') || n === 'LIGUE 1+') {
        return { id: 'hyb_sport_ligue1plus', name: 'Ligue 1+', categories: ['sports'], index: 1 };
    }

    let c = n.replace(/[^A-Z0-9+]/g, '');
    if (!c || c.length < 2) return null;

    if (BLACKLIST.some(b => c.includes(b))) return null;

    // --- 1. TNT ---
    if (c.startsWith('TF1')) {
        if (c.includes('SERIE') || c.includes('FILM')) return { id: 'hyb_tnt_20', name: 'TF1 Séries Films', categories: ['tnt', 'cinema'], index: 20 };
        return { id: 'hyb_tnt_1', name: 'TF1', categories: ['tnt'], index: 1 };
    }
    if (c.startsWith('FRANCE2') || c === 'FR2' || c === 'FRANCETV2') return { id: 'hyb_tnt_2', name: 'France 2', categories: ['tnt'], index: 2 };
    if (c.startsWith('FRANCE3') || c === 'FR3' || c === 'FRANCETV3') return { id: 'hyb_tnt_3', name: 'France 3', categories: ['tnt'], index: 3 };
    if (c.startsWith('FRANCE4') || c === 'FR4' || c === 'FRANCETV4') return { id: 'hyb_tnt_4', name: 'France 4', categories: ['tnt'], index: 4 };
    if (c.startsWith('FRANCE5') || c === 'FR5' || c === 'FRANCETV5') return { id: 'hyb_tnt_5', name: 'France 5', categories: ['tnt'], index: 5 };
    if (c.startsWith('M6')) {
        if (c.includes('MUSIC')) return { id: 'hyb_mus_m6', name: 'M6 Music', categories: ['musique'], index: 1 };
        return { id: 'hyb_tnt_6', name: 'M6', categories: ['tnt'], index: 6 };
    }
    if (c.startsWith('ARTE')) return { id: 'hyb_tnt_7', name: 'Arte', categories: ['tnt'], index: 7 };
    if (c.startsWith('C8')) return { id: 'hyb_tnt_8', name: 'C8', categories: ['tnt'], index: 8 };
    if (c.startsWith('W9')) return { id: 'hyb_tnt_9', name: 'W9', categories: ['tnt'], index: 9 };
    if (c.startsWith('TMC')) return { id: 'hyb_tnt_10', name: 'TMC', categories: ['tnt'], index: 10 };
    if (c.startsWith('TFX') || c === 'NT1') return { id: 'hyb_tnt_11', name: 'TFX', categories: ['tnt'], index: 11 };
    if (c.startsWith('NRJ12') || c.startsWith('NRJ')) return { id: 'hyb_tnt_12', name: 'NRJ 12', categories: ['tnt'], index: 12 };
    if (c.includes('LCP') || c.includes('PUBLICSENAT')) return { id: 'hyb_tnt_13', name: 'LCP / Public Sénat', categories: ['tnt', 'info'], index: 13 };
    if (c.includes('CSTAR')) return { id: 'hyb_tnt_17', name: 'CStar', categories: ['tnt', 'musique'], index: 17 };
    if (c.includes('GULLI')) return { id: 'hyb_jeu_gulli', name: 'Gulli', categories: ['jeunesse', 'tnt'], index: 3 };
    if (c.includes('6TER')) return { id: 'hyb_tnt_22', name: '6ter', categories: ['tnt'], index: 22 };
    if (c.includes('RMCSTORY') || c.includes('NUMERO23')) return { id: 'hyb_tnt_23', name: 'RMC Story', categories: ['tnt', 'decouverte'], index: 23 };
    if (c.includes('RMCDECOUVERTE')) return { id: 'hyb_tnt_24', name: 'RMC Découverte', categories: ['tnt', 'decouverte'], index: 24 };
    if (c.includes('CHERIE25') || c.includes('CHERIE')) return { id: 'hyb_tnt_25', name: 'Chérie 25', categories: ['tnt'], index: 25 };
    if (c.includes('13EMERUE') || c.includes('13RUE')) return { id: 'hyb_tnt_13rue', name: '13ème Rue', categories: ['tnt', 'cinema'], index: 30 };
    if (c.includes('TEVA')) return { id: 'hyb_tnt_teva', name: 'Téva', categories: ['tnt'], index: 31 };
    if (c.includes('RTL9')) return { id: 'hyb_tnt_rtl9', name: 'RTL9', categories: ['tnt', 'cinema'], index: 32 };
    if (c.includes('AB1')) return { id: 'hyb_tnt_ab1', name: 'AB1', categories: ['tnt'], index: 33 };

    // --- 2. INFORMATION ---
    if (c === 'BFMTV' || c === 'BFM') return { id: 'hyb_info_1', name: 'BFMTV', categories: ['info'], index: 1 };
    if (c.includes('BFMBUSINESS')) return { id: 'hyb_info_biz', name: 'BFM Business', categories: ['info'], index: 2 };
    if (c.includes('CNEWS')) return { id: 'hyb_info_2', name: 'CNews', categories: ['info'], index: 3 };
    if (c === 'LCI') return { id: 'hyb_info_3', name: 'LCI', categories: ['info'], index: 4 };
    if (c.includes('FRANCEINFO')) return { id: 'hyb_info_4', name: 'France Info', categories: ['info'], index: 5 };
    if (c.includes('FRANCE24')) return { id: 'hyb_info_5', name: 'France 24', categories: ['info'], index: 6 };
    if (c.includes('METEO')) return { id: 'hyb_info_meteo', name: 'La Chaîne Météo', categories: ['info'], index: 7 };
    if (c.includes('VOSGESTV') || c.includes('VOSGE')) return { id: 'hyb_info_vosges', name: 'Vosges TV', categories: ['info'], index: 8 };
    if (c === 'TLM' || c.includes('TELELYON')) return { id: 'hyb_info_tlm', name: 'Télé Lyon Métropole (TLM)', categories: ['info'], index: 9 };
    if (c.includes('BFMLILLE') || c.includes('GRANDLILLE')) return { id: 'hyb_info_lille', name: 'BFM Grand Lille', categories: ['info'], index: 50 };
    if (c.includes('BFMLYON')) return { id: 'hyb_info_lyon', name: 'BFM Lyon', categories: ['info'], index: 51 };
    if (c.includes('BFMPARIS')) return { id: 'hyb_info_paris', name: 'BFM Paris Île-de-France', categories: ['info'], index: 52 };

    // --- 3. SPORTS ---
    if (c.includes('DAZNLIGUE1') || c.includes('DAZNLIVE')) {
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        if (parseInt(num) > 8) return null; 
        return { id: 'hyb_sport_daznlive'+num, name: 'DAZN Live '+num, categories: ['sports'], index: 20 + parseInt(num) };
    }
    if (c.includes('DAZN')) {
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        return { id: 'hyb_sport_dazn'+num, name: 'DAZN '+num, categories: ['sports'], index: 10 + parseInt(num) };
    }
    if (c.includes('BEINSPORT') || c.includes('BEIN')) {
        let isMax = c.includes('MAX');
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        return { id: 'hyb_sport_bein' + (isMax?'max':'') + num, name: isMax ? 'beIN SPORTS MAX '+num : 'beIN SPORTS '+num, categories: ['sports'], index: isMax ? 40 + parseInt(num) : 30 + parseInt(num) };
    }
    if (c.includes('RMCSPORT')) {
        let isLive = c.includes('LIVE');
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        if (isLive) return { id: 'hyb_sport_rmclive'+num, name: 'RMC Sport Live '+num, categories: ['sports'], index: 60 + parseInt(num) };
        return { id: 'hyb_sport_rmc'+num, name: 'RMC Sport '+num, categories: ['sports'], index: 50 + parseInt(num) };
    }
    if (c.includes('EUROSPORT')) {
        let is360 = c.includes('360');
        let m = c.match(/\d+/g); let num = m ? m[m.length-1] : '1';
        if (is360) return { id: 'hyb_sport_euro360_'+num, name: 'Eurosport 360 - '+num, categories: ['sports'], index: 80 + parseInt(num) };
        return { id: 'hyb_sport_euro'+num, name: 'Eurosport '+num, categories: ['sports'], index: 70 + parseInt(num) };
    }
    if (c === 'LEQUIPE' || c === 'LEQUIPETV') return { id: 'hyb_sport_lequipe', name: "L'Équipe", categories: ['sports', 'tnt'], index: 95 };

    // --- 4. CANAL+ ---
    if (c.startsWith('CANAL') || c === 'CPLUS') {
        if (c.includes('J') || c === 'CANALJ') return { id: 'hyb_jeu_canalj', name: 'Canal J', categories: ['jeunesse', 'canal'], index: 99 };
        if (c.includes('CINEMA') || c.includes('CNEMA')) return { id: 'hyb_canal_cinema', name: 'Canal+ Cinéma', categories: ['canal', 'cinema'], index: 2 };
        if (c.includes('GRANDECRAN') || c.includes('ECRAN')) return { id: 'hyb_canal_grandecran', name: 'Canal+ Grand Écran', categories: ['canal', 'cinema'], index: 3 };
        if (c.includes('SERIES')) return { id: 'hyb_canal_series', name: 'Canal+ Séries', categories: ['canal', 'cinema'], index: 4 };
        if (c.includes('BOXOFFICE')) return { id: 'hyb_canal_boxoffice', name: 'Canal+ Box Office', categories: ['canal', 'cinema'], index: 5 };
        if (c.includes('DOC')) return { id: 'hyb_canal_docs', name: 'Canal+ Docs', categories: ['canal', 'decouverte'], index: 6 };
        if (c.includes('KIDS')) return { id: 'hyb_canal_kids', name: 'Canal+ Kids', categories: ['canal', 'jeunesse'], index: 7 };
        
        if (c.includes('SPORT360')) return { id: 'hyb_canal_sport360', name: 'Canal+ Sport 360', categories: ['canal', 'sports'], index: 90 };
        if (c.includes('FOOT')) return { id: 'hyb_canal_foot', name: 'Canal+ Foot', categories: ['canal', 'sports'], index: 91 };
        if (c.includes('FORMULA1') || c.includes('F1')) return { id: 'hyb_canal_f1', name: 'Canal+ Formula 1', categories: ['canal', 'sports'], index: 93 };
        if (c.includes('SPORT')) return { id: 'hyb_canal_sport', name: 'Canal+ Sport', categories: ['canal', 'sports'], index: 94 };
        
        if (c.includes('DECALE')) return { id: 'hyb_canal_decale', name: 'Canal+ Décalé', categories: ['canal'], index: 14 };
        if (c.includes('FAMILY')) return { id: 'hyb_canal_family', name: 'Canal+ Family', categories: ['canal'], index: 15 };
        
        return { id: 'hyb_canal_cplus', name: 'Canal+', categories: ['canal'], index: 1 };
    }

    if (c.includes('COMEDIE') || c.includes('COMEDY')) return { id: 'hyb_cine_comedie', name: 'Comédie+', categories: ['canal', 'cinema'], index: 10 };

    // --- 5. CINEMA ---
    if (c.includes('CINE') || c.includes('CINA')) {
        if (c.includes('PREMIER')) return { id: 'hyb_cine_premier', name: 'Ciné+ Premier', categories: ['cinema', 'canal'], index: 11 };
        if (c.includes('FRISSON') || c.includes('ISSON')) return { id: 'hyb_cine_frisson', name: 'Ciné+ Frisson', categories: ['cinema', 'canal'], index: 12 };
        if (c.includes('EMOTION')) return { id: 'hyb_cine_emotion', name: 'Ciné+ Émotion', categories: ['cinema', 'canal'], index: 13 };
        if (c.includes('FAMIZ')) return { id: 'hyb_cine_famiz', name: 'Ciné+ Famiz', categories: ['cinema', 'canal'], index: 14 };
        if (c.includes('CLUB') && !c.includes('SERIE')) return { id: 'hyb_cine_club', name: 'Ciné+ Club', categories: ['cinema', 'canal'], index: 15 };
        if (c.includes('CLASSIC')) return { id: 'hyb_cine_classic', name: 'Ciné+ Classic', categories: ['cinema', 'canal'], index: 16 };
        if (c.includes('ACTION')) return { id: 'hyb_cine_action', name: 'Action', categories: ['cinema'], index: 30 };
        return { id: 'hyb_cine_plus', name: 'Ciné+', categories: ['cinema', 'canal'], index: 19 };
    }
    if (c.includes('ACTION')) return { id: 'hyb_cine_action', name: 'Action', categories: ['cinema'], index: 30 };
    if (c.includes('PARAMOUNT')) return { id: 'hyb_cine_paramount', name: 'Paramount Channel', categories: ['cinema'], index: 32 };
    if (c.includes('WARNER')) return { id: 'hyb_cine_warner', name: 'Warner TV', categories: ['cinema'], index: 34 };
    if (c.includes('SYFY') || c.includes('SCIFI')) return { id: 'hyb_cine_syfy', name: 'Syfy', categories: ['cinema'], index: 35 };

    // --- 6. DECOUVERTE ---
    if (c.includes('CRIMEDISTRICT') || c.includes('CRIMED')) return { id: 'hyb_dec_crime', name: 'Crime District', categories: ['decouverte'], index: 1 };
    if (c.includes('NATGEO') || c.includes('NATIONALGEO')) {
        if (c.includes('WILD')) return { id: 'hyb_dec_natgeowild', name: 'Nat Geo Wild', categories: ['decouverte'], index: 2 };
        return { id: 'hyb_dec_natgeo', name: 'National Geographic', categories: ['decouverte'], index: 1 };
    }
    if (c.includes('PLANET')) {
        if (c.includes('CRIME') || c.includes('CI') || c.includes('JUSTICE')) return { id: 'hyb_dec_planetecrime', name: 'Planète+ Crime', categories: ['decouverte', 'canal'], index: 211 };
        if (c.includes('AVENTURE') || c.includes('AE')) return { id: 'hyb_dec_planeteaventure', name: 'Planète+ Aventure', categories: ['decouverte', 'canal'], index: 212 };
        return { id: 'hyb_dec_planete', name: 'Planète+', categories: ['decouverte', 'canal'], index: 210 };
    }
    if (c.includes('DISCOVERY')) return { id: 'hyb_dec_discovery', name: 'Discovery Channel', categories: ['decouverte'], index: 20 };
    if (c.includes('USHUAIA')) return { id: 'hyb_dec_ushuaia', name: 'Ushuaïa TV', categories: ['decouverte'], index: 30 };
    if (c.includes('HISTOIRE')) return { id: 'hyb_dec_histoire', name: 'Histoire TV', categories: ['decouverte'], index: 32 };
    if (c.includes('CHASSE') || c.includes('PECHE')) return { id: 'hyb_dec_chasse', name: 'Chasse et Pêche', categories: ['decouverte'], index: 34 };
    if (c.includes('ANIMAUX')) return { id: 'hyb_dec_animaux', name: 'Animaux', categories: ['decouverte'], index: 35 };

    // --- 7. JEUNESSE ---
    if (c.includes('CARTOON')) return { id: 'hyb_jeu_cartoon', name: 'Cartoon Network', categories: ['jeunesse'], index: 1 };
    if (c.includes('DISNEY') && !c.includes('JR') && !c.includes('JUNIOR')) return { id: 'hyb_jeu_disney', name: 'Disney Channel', categories: ['jeunesse'], index: 2 };
    if (c === 'GULLI' || c.includes('GULLI')) return { id: 'hyb_jeu_gulli', name: 'Gulli', categories: ['jeunesse', 'tnt'], index: 3 };
    if (c.includes('NICKELODEON') || c.includes('NICK')) return { id: 'hyb_jeu_nick', name: 'Nickelodeon', categories: ['jeunesse'], index: 4 };
    if (c.includes('CANALJ')) return { id: 'hyb_jeu_canalj', name: 'Canal J', categories: ['jeunesse', 'canal'], index: 5 };
    if (c.includes('GAMEONE') || c === 'G1') return { id: 'hyb_jeu_gameone', name: 'Game One', categories: ['jeunesse'], index: 6 };
    if (c.includes('BOOMERANG')) return { id: 'hyb_jeu_boom', name: 'Boomerang', categories: ['jeunesse'], index: 7 };
    if (c.includes('BOING')) return { id: 'hyb_jeu_boing', name: 'Boing', categories: ['jeunesse'], index: 9 };
    if (c.includes('JR') || c.includes('JUNIOR')) return { id: 'hyb_jeu_disneyjr', name: 'Disney Junior', categories: ['jeunesse'], index: 10 };
    if (c.includes('TIJI')) return { id: 'hyb_jeu_tiji', name: 'Tiji', categories: ['jeunesse'], index: 12 };
    if (c.includes('PIWI')) return { id: 'hyb_jeu_piwi', name: 'Piwi+', categories: ['jeunesse'], index: 13 };
    if (c.includes('MANGAS')) return { id: 'hyb_jeu_mangas', name: 'Mangas', categories: ['jeunesse'], index: 14 };
    if (c.includes('PITCHOUN')) return { id: 'hyb_jeu_pitchoun', name: 'Pitchoun TV', categories: ['jeunesse'], index: 15 };

    // --- 8. MUSIQUE ---
    if (c.includes('MTV')) return { id: 'hyb_mus_mtv', name: 'MTV', categories: ['musique'], index: 10 };
    if (c.includes('MCM')) return { id: 'hyb_mus_mcm', name: 'MCM', categories: ['musique'], index: 20 };

    // --- 9. FALLBACK INTELLIGENT ---
    let cat = 'autres';
    let idx = 300;

    if (c.includes('SPORT') || c.includes('FOOT') || c.includes('GOLF') || c.includes('MOTO') || c.includes('TENNIS') || c.includes('EQUIDIA')) { cat = 'sports'; }
    else if (c.includes('CINE') || c.includes('FILM') || c.includes('MOVIE') || c.includes('SERIE') || c.includes('ACTION') || c.includes('PARAMOUNT') || c.includes('WARNER') || c.includes('SYFY') || c.includes('OCS') || c.includes('COMEDIE')) { cat = 'cinema'; }
    else if (c.includes('INFO') || c.includes('NEWS') || c.includes('24') || c.includes('METEO')) { cat = 'info'; }
    else if (c.includes('DOC') || c.includes('GEO') || c.includes('NATURE') || c.includes('HISTOIRE') || c.includes('ANIMAUX') || c.includes('SCIENCE') || c.includes('VOYAGE') || c.includes('CHASSE') || c.includes('PECHE') || c.includes('CRIME')) { cat = 'decouverte'; }
    else if (c.includes('KIDS') || c.includes('JUNIOR') || c.includes('TOON') || c.includes('BABY') || c.includes('DISNEY') || c.includes('NICKELODEON') || c.includes('GULLI') || c.includes('BOING')) { cat = 'jeunesse'; }
    else if (c.includes('MUSIC') || c.includes('HIT') || c.includes('POP') || c.includes('ROCK') || c.includes('MTV') || c.includes('MCM') || c.includes('MELODY') || c.includes('TRACE')) { cat = 'musique'; }

    let prettyName = rawName.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\b(?:FHD|HD|SD|4K|1080P|720P)\b/gi, '').trim();
    prettyName = prettyName.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
    
    return { id: 'hyb_id_' + c, name: prettyName, categories: [cat], index: idx };
}

function toSyncId(rawName) {
    if (!rawName) return '';
    let n = rawName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return n.replace(/[^A-Z0-9]/g, ''); 
}

function parseXmltvDate(str) {
    if (!str || str.length < 14) return 0;
    const y = str.substring(0,4), m = str.substring(4,6), d = str.substring(6,8);
    const h = str.substring(8,10), min = str.substring(10,12), s = str.substring(12,14);
    let offset = str.substring(15).trim() || '+0200';
    if (!offset.includes(':') && offset.length >= 5) offset = offset.slice(0,3) + ':' + offset.slice(3);
    else if (offset.length < 5) offset = '+02:00';
    const ts = new Date(`${y}-${m}-${d}T${h}:${min}:${s}${offset}`).getTime();
    return isNaN(ts) ? 0 : ts;
}

function formatTime(timestamp) {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)).replace(':', 'h');
}

async function fetchAndParseEPG(url, isGz) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await axios.get(url, { responseType: 'stream', timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            let stream = response.data;
            if (isGz) { const unzip = zlib.createGunzip(); stream = stream.pipe(unzip); }

            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
            let localChannels = {}; let localEpg = {};      
            let inChannel = false, chanBlock = '';
            let inProgramme = false, progBlock = '';

            rl.on('line', (line) => {
                if (line.includes('<desc') || line.includes('<icon')) return;

                if (line.includes('<channel ')) { inChannel = true; chanBlock = line; }
                else if (inChannel) { chanBlock += '\n' + line; }
                
                if (inChannel && chanBlock.includes('</channel>')) {
                    const idM = chanBlock.match(/id=["']([^"']+)["']/);
                    const nameM = chanBlock.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
                    if (idM && nameM) {
                        let cData = getChannelData(nameM[1]);
                        if (cData) localChannels[idM[1]] = cData.id; 
                    }
                    inChannel = false; chanBlock = '';
                }

                if (line.includes('<programme ')) { inProgramme = true; progBlock = line; }
                else if (inProgramme) { progBlock += '\n' + line; }

                if (inProgramme && progBlock.includes('</programme>')) {
                    const startM = progBlock.match(/start=["']([^"']+)["']/);
                    const stopM = progBlock.match(/stop=["']([^"']+)["']/);
                    const chanM = progBlock.match(/channel=["']([^"']+)["']/);
                    const titleM = progBlock.match(/<title[^>]*>([^<]+)<\/title>/);
                    
                    if (startM && stopM && chanM && titleM) {
                        const syncId = localChannels[chanM[1]];
                        if (syncId) {
                            if (!localEpg[syncId]) localEpg[syncId] = [];
                            localEpg[syncId].push({
                                start: parseXmltvDate(startM[1]), stop: parseXmltvDate(stopM[1]),
                                title: titleM[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim()
                            });
                        }
                    }
                    inProgramme = false; progBlock = '';
                }
            });

            const timeoutId = setTimeout(() => { stream.destroy(); reject(new Error("Timeout")); }, 60000);
            rl.on('close', () => { clearTimeout(timeoutId); resolve(localEpg); });
            rl.on('error', (err) => { clearTimeout(timeoutId); reject(err); });
        } catch (err) { reject(err); }
    });
}

async function updateEPG() {
    if (isUpdatingEPG) return;
    isUpdatingEPG = true; 
    let tempEpgData = {};
    const sources = [
        { url: 'https://xmltvfr.fr/xmltv/xmltv_francophone.xml', isGz: false },
        { url: 'https://epgshare01.online/epgshare01/epg_ripper_FR1.xml.gz', isGz: true }
    ];

    try {
        for (const source of sources) {
            try {
                const parsedEpg = await fetchAndParseEPG(source.url, source.isGz);
                for (const channelId in parsedEpg) {
                    if (!tempEpgData[channelId] && parsedEpg[channelId].length > 0) tempEpgData[channelId] = parsedEpg[channelId];
                }
                if (Object.keys(tempEpgData).length > 100) break;
            } catch (err) {}
        }
        if (Object.keys(tempEpgData).length > 10) {
            epgData = tempEpgData;
            lastUpdate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
        }
    } finally { isUpdatingEPG = false; }
}

async function fetchCatalogFromSource(sourceInput) {
    let metas = [];
    let cleanInput = sourceInput.trim();
    if (!cleanInput) return metas;

    if (cleanInput.endsWith('.m3u') || cleanInput.endsWith('.m3u8') || cleanInput.includes('get.php') || cleanInput.includes('/live/')) {
        try {
            const res = await axios.get(cleanInput, { timeout: 10000 });
            const lines = res.data.split('\n');
            let currentLogo = DEFAULT_POSTER;
            let currentName = '';

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                if (line.startsWith('#EXTINF:')) {
                    let logoMatch = line.match(/tvg-logo="([^"]+)"/);
                    if (logoMatch) currentLogo = logoMatch[1];
                    let parts = line.split(',');
                    if (parts.length > 1) currentName = parts[parts.length - 1].trim();
                } else if (line && !line.startsWith('#')) {
                    if (currentName) {
                        let streamUrl = line;
                        let metaId = Buffer.from(streamUrl).toString('base64');
                        metas.push({
                            id: metaId,
                            name: currentName,
                            poster: currentLogo,
                            _isDirectStream: true,
                            _directUrl: streamUrl
                        });
                    }
                    currentLogo = DEFAULT_POSTER;
                    currentName = '';
                }
            }
        } catch (e) {
            console.error("Erreur lecture M3U :", e.message);
        }
        return metas;
    }

    try {
        let cleanUrl = cleanInput;
        if (!cleanUrl.endsWith('manifest.json')) cleanUrl = cleanUrl.replace(/\/$/, '') + '/manifest.json';
        const base = cleanUrl.replace(/\/manifest\.json$/, '');

        const manifestRes = await axios.get(cleanUrl, { timeout: 4000 });
        const catalogs = manifestRes.data.catalogs || [];
        
        const catalogPromises = catalogs.map(async (catalog) => {
            let catMetas = []; let skip = 0; let hasMore = true; let pageCount = 0;
            while (hasMore && pageCount < 4) {
                pageCount++;
                try {
                    let url = skip > 0 ? `${base}/catalog/${catalog.type}/${catalog.id}/skip=${skip}.json` : `${base}/catalog/${catalog.type}/${catalog.id}.json`;
                    let res = await axios.get(url, { timeout: 4000 });
                    if (res.data && res.data.metas && res.data.metas.length > 0) {
                        catMetas.push(...res.data.metas); skip += res.data.metas.length;
                    } else { hasMore = false; }
                } catch (e) { hasMore = false; }
            }
            return catMetas;
        });

        const results = await Promise.all(catalogPromises);
        results.flat().forEach(m => {
            if (m && m.id) metas.push({ ...m, _providerBase: base, _isDirectStream: false });
        });
    } catch (err) {}

    return metas;
}

async function getChannelsForSources(sourcesList, enableLogos) {
    const cacheKey = sourcesList.join('|') + '|' + enableLogos;
    if (channelsCache[cacheKey] && (Date.now() - channelsCache[cacheKey].timestamp < 3600000)) return channelsCache[cacheKey].data;

    let tempChannelsMap = {};
    for (let i = 0; i < sourcesList.length; i++) {
        const sourceInput = sourcesList[i].trim();
        if (!sourceInput) continue;
        
        const metas = await fetchCatalogFromSource(sourceInput);
        let cleanUrl = sourceInput.replace(/\/manifest\.json$/, '').trim();

        metas.forEach(meta => {
            let channelInfo = getChannelData(meta.name || '');
            if (!channelInfo) return; 

            const id = channelInfo.id;
            
            let finalPoster = DEFAULT_POSTER;
            if (enableLogos) {
                let forceLogo = LOGOS[id];
                if (id.startsWith('hyb_sport_dazn')) forceLogo = LOGOS['dazn_generic'];
                finalPoster = forceLogo || meta.poster || DEFAULT_POSTER;
            } else {
                finalPoster = meta.poster || DEFAULT_POSTER;
            }

            if (!tempChannelsMap[id]) {
                tempChannelsMap[id] = { 
                    id: id, 
                    name: channelInfo.name, 
                    displayName: channelInfo.name, 
                    categories: channelInfo.categories,
                    sortIndex: channelInfo.index,
                    sources: [], 
                    poster: finalPoster 
                };
            } else if (enableLogos && !LOGOS[id] && meta.poster && tempChannelsMap[id].poster === DEFAULT_POSTER) {
                tempChannelsMap[id].poster = meta.poster; 
            }
            
            if (meta._isDirectStream) {
                const sourceExists = tempChannelsMap[id].sources.find(s => s.directUrl === meta._directUrl);
                if (!sourceExists) {
                    tempChannelsMap[id].sources.push({ type: 'm3u', directUrl: meta._directUrl, sourceIndex: i });
                }
            } else {
                const sourceExists = tempChannelsMap[id].sources.find(s => s.metaId === meta.id && s.providerBase === cleanUrl);
                if (!sourceExists) {
                    tempChannelsMap[id].sources.push({ type: 'addon', metaId: meta.id, providerBase: cleanUrl, sourceIndex: i });
                }
            }
        });
    }

    let tempChannelsData = Object.values(tempChannelsMap).filter(ch => ch.sources.length > 0);
    tempChannelsData.sort((a, b) => {
        if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
        return a.displayName.localeCompare(b.displayName);
    });

    channelsCache[cacheKey] = { data: tempChannelsData, timestamp: Date.now() };
    return tempChannelsData;
}

app.get('/', async (req, res) => {
    let sourcesParam = req.query.sources;
    let sourcesList = sourcesParam ? sourcesParam.split(',') : ['', ''];
    let epgCount = Object.keys(epgData).length;
    let epgStatus = epgCount > 0 ? `✅ Programme téléchargé pour <b>${epgCount}</b> chaînes` : `⏳ Programme TV en cours de chargement...`;

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>HybridTV</title>
        <style>
            body { font-family: -apple-system, sans-serif; background: #141414; color: #fff; text-align: center; padding: 40px 20px; }
            .container { max-width: 650px; margin: 0 auto; background: #1f1f1f; padding: 40px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-top: 4px solid #e50914; }
            h1 { color: #fff; font-size: 32px; margin-bottom: 10px; }
            .intro-desc { font-size: 14px; color: #bbb; margin-bottom: 25px; line-height: 1.6; background: #111; padding: 15px; border-radius: 6px; border: 1px solid #333; text-align: left; }
            .section { background: #111; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #333; text-align: left; }
            .source-row { display: flex; gap: 6px; margin-bottom: 10px; align-items: center; }
            .source-num { font-size: 13px; font-weight: bold; color: #e50914; min-width: 24px; text-align: center; }
            .source-row input { flex: 1; padding: 10px; background: #222; border: 1px solid #444; color: #fff; border-radius: 6px; font-size: 13px; }
            .btn { display: inline-block; background: #e50914; color: #fff; padding: 12px 24px; text-decoration: none; font-size: 14px; font-weight: bold; border-radius: 8px; margin: 5px; cursor: pointer; border: none; transition: 0.2s; }
            .btn:hover { background: #f40612; transform: scale(1.02); }
            .btn-secondary { background: #333; }
            .btn-secondary:hover { background: #444; }
            .btn-small { background: #444; padding: 8px 10px; font-size: 12px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .btn-small:hover { background: #555; }
            .btn-danger { background: #800; padding: 8px 10px; font-size: 12px; border-radius: 6px; cursor: pointer; color: #fff; border: none; }
            .btn-danger:hover { background: #a00; }
            .stats { margin-top: 25px; font-size: 14px; color: #888; background: #111; padding: 15px; border-radius: 6px; line-height: 1.8; text-align: left; }
            input[type="text"].main-link { width: 100%; padding: 12px; margin-top: 15px; background: #111; color: #fff; border: 1px solid #444; border-radius: 6px; text-align: center; font-size: 14px; box-sizing: border-box; }
            textarea.export-box { width: 100%; height: 60px; padding: 8px; background: #222; border: 1px solid #444; color: #aaa; border-radius: 6px; font-size: 12px; box-sizing: border-box; resize: none; margin-top: 5px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📺 HybridTV</h1>
            <div class="intro-desc">
                <b>HybridTV</b> centralise vos sources (Add-ons Stremio ou liens de playlists <b>.m3u/.m3u8</b>) en une bibliothèque francophone propre, triée et dotée d'un guide TV.
            </div>
            
            <div class="section">
                <label style="font-size: 14px; color: #ccc; font-weight: bold;">Sources de flux (Add-on manifest.json ou .m3u) :</label><br>
                <div id="sourcesContainer"></div>
                <button type="button" onclick="addSourceField()" class="btn btn-small">+ Ajouter une source</button>
            </div>

            <div class="section" style="text-align: center;">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="logosToggle" checked style="width: 18px; height: 18px; cursor: pointer;">
                    <b style="font-size: 15px;">Activer les Logos VIP (ON / OFF)</b>
                </label>
            </div>

            <div class="section" style="text-align: center;">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="epgToggle" checked style="width: 18px; height: 18px; cursor: pointer;">
                    <b style="font-size: 15px;">Activer le Programme TV</b>
                </label>
            </div>

            <div class="section">
                <label style="font-size: 14px; color: #ccc; font-weight: bold;">🔑 Code de Sauvegarde / Partage :</label><br>
                <textarea id="exportTokenBox" class="export-box" placeholder="Code de configuration..."></textarea>
                <button type="button" onclick="importToken()" class="btn btn-small" style="margin-top: 5px;">📥 Importer le code</button>
            </div>
            
            <button type="button" onclick="generateLink()" class="btn">⚡ Générer le lien de l'Add-on</button>
            <br>
            <input type="text" id="manifestLink" class="main-link" placeholder="Cliquez sur 'Générer' pour afficher le lien..." readonly>
            <br>
            <button type="button" onclick="copyLink()" class="btn btn-secondary" style="margin-top: 10px;">📋 Copier le lien</button>
            
            <div class="stats">
                <b>État du service :</b><br>
                ✅ Serveur actif et opérationnel<br>
                ${epgStatus}<br>
                🕒 Dernière synchronisation : ${lastUpdate}
            </div>
        </div>

        <script>
            let sources = ${JSON.stringify(sourcesList)};

            function renderSources() {
                const container = document.getElementById('sourcesContainer');
                container.innerHTML = '';
                sources.forEach((src, index) => {
                    if (index >= 5) return;
                    const div = document.createElement('div');
                    div.className = 'source-row';
                    div.innerHTML = \`
                        <span class="source-num">#\${index + 1}</span>
                        <input type="text" id="src_\${index}" value="\${src}" placeholder="https://.../manifest.json ou lien .m3u">
                        \${index > 0 ? '<button type="button" onclick="moveSource(' + index + ', -1)" class="btn-small">▲</button>' : ''}
                        \${index < sources.length - 1 ? '<button type="button" onclick="moveSource(' + index + ', 1)" class="btn-small">▼</button>' : ''}
                        \${sources.length > 1 ? '<button type="button" onclick="removeSource(' + index + ')" class="btn-danger">✕</button>' : ''}
                    \`;
                    container.appendChild(div);
                });
                updateExportToken();
            }

            function moveSource(index, direction) {
                saveInputs();
                const newIndex = index + direction;
                if (newIndex < 0 || newIndex >= sources.length) return;
                const temp = sources[index];
                sources[index] = sources[newIndex];
                sources[newIndex] = temp;
                renderSources();
            }
            function addSourceField() { if (sources.length < 5) { saveInputs(); sources.push(''); renderSources(); } }
            function removeSource(index) { saveInputs(); sources.splice(index, 1); renderSources(); }
            function saveInputs() {
                sources.forEach((_, index) => { const el = document.getElementById('src_' + index); if (el) sources[index] = el.value.trim(); });
                localStorage.setItem('hybrid_sources', JSON.stringify(sources));
                updateExportToken();
            }
            function updateExportToken() {
                const validSources = sources.filter(s => s.length > 0);
                const isEpg = document.getElementById("epgToggle").checked;
                const isLogos = document.getElementById("logosToggle").checked;
                const configObj = { sources: validSources, epg: isEpg, logos: isLogos };
                document.getElementById('exportTokenBox').value = btoa(JSON.stringify(configObj));
            }
            function importToken() {
                try {
                    const jsonStr = atob(document.getElementById('exportTokenBox').value.trim());
                    const config = JSON.parse(jsonStr);
                    if (config.sources && Array.isArray(config.sources)) {
                        sources = config.sources; if (sources.length === 0) sources = ['', ''];
                        if (config.epg !== undefined) document.getElementById("epgToggle").checked = config.epg;
                        if (config.logos !== undefined) document.getElementById("logosToggle").checked = config.logos;
                        renderSources(); alert("Configuration importée avec succès !");
                    } else alert("Code invalide.");
                } catch(e) { alert("Erreur : Ce code est corrompu."); }
            }
            function generateLink() {
                saveInputs();
                const validSources = sources.filter(s => s.length > 0);
                if (validSources.length === 0) return alert("Veuillez entrer au moins un lien de source !");
                const token = document.getElementById('exportTokenBox').value;
                document.getElementById("manifestLink").value = window.location.protocol + "//" + window.location.host + "/" + token + "/manifest.json";
                alert("Lien généré avec succès !");
            }

            let savedSources = localStorage.getItem('hybrid_sources');
            if (savedSources && !${sourcesParam ? 'true' : 'false'}) sources = JSON.parse(savedSources);
            renderSources();

            function copyLink() {
                var copyText = document.getElementById("manifestLink");
                if (!copyText.value) return alert("Veuillez d'abord générer le lien !");
                copyText.select(); document.execCommand("copy"); alert("Lien copié dans le presse-papier !");
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.get('/:config/manifest.json', (req, res) => {
    const config = parseConfig(req.params.config);
    const confName = config.epg ? 'epg-on' : 'epg-off';
    
    res.setHeader('Cache-Control', 'max-age=86400, public'); 
    res.json({
        id: 'org.hybridtv.meta.' + confName, 
        version: '2.0.9',
        name: config.epg ? 'HybridTV' : 'HybridTV (Sans Programme TV)',
        description: 'L\'expérience IPTV ultime. Édition Meta-Addon dynamique.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            { type: 'tv', id: 'tnt', name: '📺 TNT' },
            { type: 'tv', id: 'info', name: '📰 Information' },
            { type: 'tv', id: 'jeunesse', name: '👶 Jeunesse' },
            { type: 'tv', id: 'decouverte', name: '🔬 Découverte & Docu' },
            { type: 'tv', id: 'cinema', name: '🍿 Cinéma & Séries' },
            { type: 'tv', id: 'musique', name: '🎵 Musique' },
            { type: 'tv', id: 'canal', name: '🎟️ Bouquet Canal' },
            { type: 'tv', id: 'sports', name: '⚽ Sports' },
            { type: 'tv', id: 'autres', name: '📂 Autres' }
        ]
    });
});

app.get(['/:config/catalog/tv/:id.json', '/:config/catalog/tv/:id/:extra'], async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ metas: [] });
    
    let channelsData = await getChannelsForSources(config.sources, config.logos);
    if (channelsData.length === 0) { res.setHeader('Cache-Control', 'no-cache'); return res.json({ metas: [] }); }
    
    res.setHeader('Cache-Control', 'max-age=14400, public'); 
    const requestedCatalog = req.params.id; 
    let skip = 0;
    if (req.params.extra) {
        const match = req.params.extra.match(/skip=(\d+)/);
        if (match) skip = parseInt(match[1], 10);
    }

    const validCatalogs = ['tnt', 'info', 'jeunesse', 'decouverte', 'cinema', 'musique', 'canal', 'sports', 'autres'];
    if (!validCatalogs.includes(requestedCatalog)) return res.json({ metas: [] });
    
    const filteredChannels = channelsData.filter(ch => ch.categories.includes(requestedCatalog));
    const paginatedMetas = filteredChannels.slice(skip, skip + 100).map(ch => ({
        id: ch.id, type: 'tv', name: ch.displayName, poster: ch.poster, posterShape: 'square'
    }));
    res.json({ metas: paginatedMetas });
});

app.get('/:config/meta/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ meta: {} });
    
    let channelsData = await getChannelsForSources(config.sources, config.logos);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); 
    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ meta: {} });
    
    let descriptionText = `▶ Diffusion en cours sur ${channel.displayName}...`;
    
    if (config.epg) {
        if (Object.keys(epgData).length === 0) {
            descriptionText = `▶ Le Programme TV est en cours de chargement...`;
        } else {
            const epgList = epgData[channel.id]; 
            if (epgList && epgList.length > 0) {
                const now = Date.now();
                epgList.sort((a, b) => a.start - b.start);
                
                const currentIndex = epgList.findIndex(p => now >= p.start && now <= p.stop);
                
                if (currentIndex !== -1) {
                    const currentProg = epgList[currentIndex];
                    const sTime = formatTime(currentProg.start);
                    const eTime = formatTime(currentProg.stop);
                    
                    descriptionText = `🔴 EN DIRECT (${sTime} - ${eTime}) : ${currentProg.title}`;
                    
                    const rawUpcoming = epgList.slice(currentIndex + 1);
                    let filteredUpcoming = [];
                    let seenTimes = new Set();
                    seenTimes.add(sTime); 
                    
                    for (let p of rawUpcoming) {
                        const uTime = formatTime(p.start);
                        if (!seenTimes.has(uTime)) {
                            seenTimes.add(uTime);
                            filteredUpcoming.push(`${uTime} ${p.title}`);
                        }
                        if (filteredUpcoming.length === 4) break; 
                    }
                    
                    if (filteredUpcoming.length > 0) {
                        descriptionText += `\n📺 À SUIVRE :\n`;
                        descriptionText += filteredUpcoming.join('  |  ');
                    }
                }
            }
        }
    }

    res.json({
        meta: { id: channel.id, type: 'tv', name: channel.displayName, poster: channel.poster, posterShape: 'square', description: descriptionText }
    });
});

app.get('/:config/stream/tv/:id.json', async (req, res) => {
    const config = parseConfig(req.params.config);
    if (!config.sources || config.sources.length === 0) return res.json({ streams: [] });
    
    let channelsData = await getChannelsForSources(config.sources, config.logos);
    res.setHeader('Cache-Control', 'max-age=1800, public'); 
    const rawIp = req.headers['x-forwarded-for'];
    const clientIp = rawIp ? rawIp.split(',')[0].trim() : req.socket.remoteAddress;

    const channel = channelsData.find(c => c.id === req.params.id);
    if (!channel) return res.json({ streams: [] });
    
    try {
        let streamPromises = channel.sources.map(async (source) => {
            if (source.type === 'm3u') {
                return [{
                    url: source.directUrl,
                    name: `▶ Flux direct M3U`,
                    title: `Haute Qualité (1080p)`,
                    _score: 1000
                }];
            }

            try {
                const streamRes = await axios.get(`${source.providerBase}/stream/tv/${source.metaId}.json`, {
                    headers: { 'X-Forwarded-For': clientIp }, timeout: 4000 
                });
                if (streamRes.data && streamRes.data.streams) {
                    return streamRes.data.streams.map((s, idx) => {
                        let qual = "Qualité Standard (SD)";
                        let score = 0;
                        let up = (s.title || '').toUpperCase() + ' ' + (s.name || '').toUpperCase();
                        
                        // ANTI-INTOXICATION CHIRURGICALE DES CHAINES CANAL+ & CINEMA
                        if (channel.id === 'hyb_canal_cplus') {
                            // Canal+ de base rejette tout ce qui est Cinéma, Sport, Séries, Docs, etc.
                            if (up.match(/(SPORT|FOOT|CINEMA|CNEMA|DECALE|KIDS|DOC|BOX|GRAND|SERIE|F1|MOTO|360|FAMILY|LIGUE|\bJ\b|CANALJ|LIVE|PREMIER|FRISSON|EMOTION|COMEDIE)/)) {
                                score -= 100000;
                            }
                        } else if (channel.id.startsWith('hyb_canal_') || channel.id.startsWith('hyb_cine_')) {
                            // Si on demande une chaîne spécifique (ex: Canal+ Cinéma), on s'assure qu'elle ne récupère pas le flux d'une autre
                            let targetKey = channel.id.replace('hyb_canal_', '').replace('hyb_cine_', '').toUpperCase();
                            if (up.includes('SPORT') && !targetKey.includes('SPORT')) score -= 50000;
                        }

                        // SCORING DE QUALITÉ (1080p > 720p > 4K > SD)
                        if (up.includes('FHD') || up.includes('1080')) { qual = "Haute Qualité (1080p)"; score += 1000; } 
                        else if (up.includes('HD') || up.includes('720')) { qual = "Haute Qualité (720p)"; score += 800; } 
                        else if (up.includes('4K') || up.includes('2160') || up.includes('UHD')) { qual = "Ultra Haute Qualité (4K)"; score += 600; } 
                        else { score += 400; } 

                        if (up.match(/\bFR\b/) || up.match(/\bVF\b/) || up.includes('FRENCH') || up.includes('FRANCE')) {
                            score += 200;
                        }
                        
                        if (up.includes('360P') || up.includes('480P') || up.includes('LQ')) score -= 100;
                        if (up.includes('BACKUP') || up.includes('SECOURS') || up.includes('ALT') || up.includes('TEST')) score -= 150;
                        
                        // Conserve l'ordre d'origine de la source (évite d'envoyer les bons flux en bas)
                        score -= idx; 
                        score += (10 - source.sourceIndex) * 10;

                        return { ...s, _qualText: qual, _score: score };
                    });
                }
            } catch (err) {}
            return [];
        });

        let results = await Promise.all(streamPromises);
        let allStreams = [].concat(...results);

        allStreams.sort((a, b) => b._score - a._score);
        const limitedStreams = allStreams.slice(0, 15);

        const finalStreams = limitedStreams.map((s, idx) => ({
            url: s.url, name: `▶ Source ${idx + 1}`, title: s._qualText
        }));
        
        res.json({ streams: finalStreams });
    } catch (err) { res.json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    console.log(`HybridTV Server démarré sur le port ${PORT}`);
    updateEPG(); 
    setInterval(updateEPG, 3600000); 
});
