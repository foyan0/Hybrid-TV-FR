# 📺 HybridTV - Meta-Addon (Self-Hosted)

HybridTV est un pont technique (parser et proxy de métadonnées) léger et ultra-rapide permettant d'agréger, de trier et d'optimiser vos propres sources (M3U ou Add-ons) pour des lecteurs compatibles. 

Conçu pour être auto-hébergé via Docker, il agit comme un intermédiaire intelligent entre vos listes de flux personnelles et votre lecteur vidéo.

---

## ✨ Fonctionnalités Principales

* **🚀 Smart Cache (45s) :** Réduit drastiquement les requêtes vers vos sources d'origine. Si plusieurs requêtes ciblent la même chaîne dans un court laps de temps, le serveur sert la réponse en mémoire instantanément.
* **🔍 Health Check Synchrone :** Vérifie l'état des flux vidéo en temps réel. Les liens morts ou inaccessibles (Erreur 403, 404, Serveur Injoignable) sont identifiés et rétrogradés.
* **🔒 Isolation Multi-Utilisateurs :** Aucun identifiant ou token n'est codé en dur. Chaque utilisateur configure ses propres sources via le Dashboard et génère un lien d'installation unique (Hash Base64).
* **📊 Dashboard d'Administration :** Interface web intégrée pour configurer ses liens, surveiller les métriques du serveur (Uptime, Cache Hits, Requêtes) et inspecter les flux en direct.

---

## ⚙️ Comment ça fonctionne ?

1. **Déployez** ce conteneur sur votre propre serveur (VPS, AWS, NAS, etc.).
2. **Accédez** au Dashboard via `http://<VOTRE_IP_SERVEUR>:7000`.
3. **Configurez** vos propres sources (URLs de manifestes json ou listes `.m3u`).
4. **Générez** votre lien d'installation sécurisé et ajoutez-le dans votre lecteur vidéo.

---

## 🚀 Installation & Déploiement (Docker)

La méthode recommandée pour déployer HybridTV est d'utiliser Docker.

### 1. Déploiement initial
Clonez le dépôt et lancez le conteneur :
```bash
git clone [https://github.com/VOTRE_NOM/Hybrid-TV-FR.git](https://github.com/VOTRE_NOM/Hybrid-TV-FR.git)
cd Hybrid-TV-FR
docker build -t hybridtv .
docker run -d -p 7000:7000 --name hybridtv-container hybridtv
