# 📺 HybridTV - Meta-Addon (Self-Hosted)

HybridTV est un pont technique (parser et proxy de métadonnées) léger et ultra-rapide permettant d'agréger, de trier et d'optimiser vos propres sources (M3U ou Add-ons) pour des lecteurs compatibles. 

Conçu pour être auto-hébergé via Docker, il agit comme un intermédiaire intelligent entre vos listes de flux personnelles et votre lecteur vidéo.

---

## Fonctionnalités Principales

*Smart Cache (45s) : Réduit drastiquement les requêtes vers vos sources d'origine. Si plusieurs requêtes ciblent la même chaîne dans un court laps de temps, le serveur sert la réponse en mémoire instantanément.
*Health Check Synchrone : Vérifie l'état des flux vidéo en temps réel. Les liens morts ou inaccessibles (Erreur 403, 404, Serveur Injoignable) sont identifiés et rétrogradés.
*Isolation Multi-Utilisateurs : Aucun identifiant ou token n'est codé en dur. Chaque utilisateur configure ses propres sources via le Dashboard et génère un lien d'installation unique (Hash Base64).
*Dashboard d'Administration : Interface web intégrée pour configurer ses liens, surveiller les métriques du serveur (Uptime, Cache Hits, Requêtes) et inspecter les flux en direct.

---

## Installation & Déploiement (Docker)

La méthode recommandée pour déployer HybridTV est d'utiliser Docker.

### 1. Déploiement initial
Clonez le dépôt et lancez le conteneur :
```bash
git clone [https://github.com/foyan0/Hybrid-TV-FR.git](https://github.com/foyan0/Hybrid-TV-FR.git)
cd Hybrid-TV-FR
docker build -t hybridtv .
docker run -d -p 7000:7000 --name hybridtv-container hybridtv
```
### 2. Mise à jour automatisée
Vous pouvez créer un script update.sh pour automatiser les mises à jour en cas de modification du code :

```bash
#!/bin/bash
git pull origin main
docker build -t hybridtv .
docker stop hybridtv-container || true
docker rm hybridtv-container || true
docker run -d -p 7000:7000 --name hybridtv-container hybridtv
```
---

## ⚠️ Avertissement Légal (Disclaimer)

Ce projet (HybridTV) est fourni à des fins purement techniques et éducatives. Il s'agit d'un outil d'agrégation et de tri de flux conçu pour être auto-hébergé (self-hosted) par l'utilisateur final.

Aucun contenu fourni : Le code source de ce projet ne contient, ne fournit, n'héberge et ne distribue aucun flux vidéo, playlist M3U, abonnement IPTV ou contenu multimédia.

Responsabilité de l'utilisateur : L'utilisateur est seul responsable des sources (URL, listes M3U, tokens) qu'il décide d'intégrer à cet outil. Il incombe à l'utilisateur de s'assurer qu'il possède les droits légaux et légitimes d'accès aux flux qu'il configure.

Respect des droits d'auteur : Le développeur de ce projet n'encourage, ne facilite ni ne cautionne le piratage ou la diffusion non autorisée de contenus protégés par le droit d'auteur.

Absence de garantie : Le logiciel est fourni "en l'état", sans aucune garantie. Le développeur décline toute responsabilité quant à l'utilisation ou aux conséquences découlant de l'utilisation de cet outil. En cas de réclamation, le dépôt se conformera aux directives de retrait de la plateforme d'hébergement.
