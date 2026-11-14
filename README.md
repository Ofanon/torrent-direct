# Torrent Direct

Addon Stremio autonome pour films et épisodes, sans compte ni TorBox. Stremio reçoit l'identifiant BitTorrent v1 et le numéro du fichier dans le torrent. Le serveur ne transporte pas la vidéo.

## Démarrer

Depuis le dossier du projet, avec Docker en marche :

```sh
docker compose up --build -d
```

Ou en local avec Node.js 24, sans dépendance à installer :

```powershell
$env:CATALOG = "catalog/catalog.json"
node server.mjs
```

Ouvrir [le manifeste](http://127.0.0.1:7000/manifest.json) pour vérifier que le serveur répond. Dans Stremio Desktop, ouvrir **Addons → Add addon**, coller `http://127.0.0.1:7000/manifest.json`, puis installer. Dans **Discover → Movie → Torrent Direct**, ouvrir **Big Buck Bunny (2008)** et sélectionner la source **Torrent Direct**. Le résultat fourni est un MP4 720p issu du [torrent public d'Internet Archive](https://archive.org/details/BigBuckBunny_124). Le démarrage de la vidéo dépend des pairs et du client utilisé.

Le port Docker est limité à la machine hôte. Pour une installation depuis un autre appareil, exposer le service derrière un reverse proxy HTTPS. Vérifier la prise en charge du torrent direct sur chaque client cible.

## Alimenter le catalogue

Modifier `catalog/catalog.json`. Chaque entrée indique un fichier .torrent local (chemin relatif au catalogue) ou une URL HTTPS, un libellé, une priorité facultative et une correspondance exacte entre l'identifiant Stremio et le chemin dans le torrent. Utiliser des contenus dont la redistribution est autorisée.

```json
{
  "torrent": "saison.torrent",
  "label": "1080p · VF",
  "priority": 20,
  "media": {
    "tt1234567:1:1": "Saison/S01E01.mp4",
    "tt1234567:1:2": "Saison/S01E02.mp4"
  }
}
```

L'index est reconstruit au démarrage et toutes les 15 minutes. Il conserve l'index précédent si une reconstruction échoue. Les recherches lisent uniquement l'index en mémoire. L'addon classe les résultats par priorité configurée, déduplique par identifiant du torrent et numéro du fichier, puis renvoie jusqu'à 120 résultats. `/health` indique si l'index est prêt.

Les films absents du catalogue local sont recherchés par identifiant IMDb auprès de Public Domain Movies. Le catalogue Torrent Direct prend aussi en charge la recherche Stremio par nom. Les réponses positives sont mises en cache pendant une heure. Les séries utilisent le catalogue local et les addons P2P configurés. Le classement par activité des pairs et la mesure des performances sous charge restent à intégrer.



## Tester Jackett

Activer un indexeur public dans Jackett. Torrent Direct recherche les films par titre et vérifie le titre et l'année ou l'identifiant IMDb. Il résout les magnets des vingt meilleurs résultats par indexeur et par film, puis les stocke dans SQLite. Sur une fiche sans résultat local, l'addon laisse jusqu'à 1,8 seconde aux indexeurs pour fournir une première réponse. L'import continue en arrière-plan. Rouvrir la fiche si aucun résultat n'est prêt ou pour voir les sources ajoutées ensuite. Les résultats enregistrés restent disponibles après un redémarrage ou une panne temporaire de Jackett. Les réponses .torrent servies directement par Jackett sont aussi prises en charge. Les séries restent hors de ce connecteur.
Avant de lancer le serveur Node.js, renseigner les variables suivantes dans PowerShell. Remplacer les exemples par la clé et les identifiants affichés dans Jackett. La clé reste côté serveur.

```powershell
$env:JACKETT_URL = "http://127.0.0.1:9117"
$env:JACKETT_API_KEY = "<clé Jackett>"
$env:JACKETT_INDEXERS = "1337x,limetorrents,yts,thepiratebay,torrentgalaxyclone,torrentdownload,torrentdownloads,torrentproject2,rutor,megapeer,kickasstorrents-ws,kickasstorrents-to"
$env:JACKETT_PREFILL = "tt1254207"
$env:CATALOG = "catalog/catalog.json"
node server.mjs
```

Dans Docker, définir ces variables avant de lancer Compose et utiliser une adresse Jackett accessible depuis ce conteneur. Sur Docker Desktop, un Jackett installé sur l’hôte peut être joint via `host.docker.internal` si son écoute autorise cette connexion.

Les logs du serveur indiquent le temps de recherche par indexeur. Pour mesurer la lecture, chronométrer séparément du clic sur la source jusqu’à la première image dans Stremio.


Les résultats Jackett dont le dernier relevé indique zéro seeder sont masqués, y compris dans les données déjà en base. Ce relevé reste une estimation de la disponibilité. La vitesse de recherche dans SQLite et le temps de démarrage de la lecture sont deux mesures distinctes.

## Sources directes

Pirate Bay, Knaben, Torrents.csv, TheRARBG et EZTVTorrent.co sont activés par défaut pour les films. DIRECT_INDEXERS accepte une liste séparée par des virgules parmi apibay, knaben, torrentscsv, therarbg et eztvtorrent. Une valeur vide désactive les sources directes. Ajouter les identifiants publics configurés dans Jackett à JACKETT_INDEXERS pour les interroger en parallèle. Torrent Direct regroupe les sources partageant un infohash et conserve les trackers communiqués. Torz et Torrentio prennent en charge la recherche par saison et épisode.



## Format des sources

Stremio reçoit les champs RES, Q, ENC, BR, SIZE, DUR, LANG, VT, AT, GRP, ADDON, CACHED et FILE dans cet ordre. SIZE est exprimé en octets. La qualité, le codec, les langues et les balises sont estimés à partir du nom de la release. Les valeurs inconnues restent vides. FILE utilise le nom de la release si le nom du fichier est inconnu. CACHED vaut 0 en torrent direct.


Conserver le même chemin JACKETT_DB et le même volume Docker entre versions pour réutiliser les résultats enregistrés.


## Addons P2P complémentaires

StremThru Torz et Torrentio sont interrogés en arrière-plan pour les films et épisodes et leurs résultats torrent sont stockés dans la même base. P2P_ADDONS accepte stremthru-torz et torrentio, séparés par des virgules. Une valeur vide désactive les deux services externes. Les résultats comportant un numéro de fichier conservent ce numéro pour la lecture. Ces services peuvent appliquer leurs propres limites de débit.



Dans LANG, French indique une piste française annoncée par le nom de la release. VOSTFR indique des sous-titres français annoncés. Multi indique plusieurs pistes annoncées, dont les langues peuvent être inconnues. Les sources French, VOSTFR puis Multi sont affichées en priorité. Ces tags ne vérifient pas les pistes du fichier.

## Déployer sur un VPS Linux

Cloner le dépôt sur le VPS via GitHub avec un accès au dépôt privé. Dans le dossier du dépôt, lancer :

```sh
cp .env.example .env
docker compose up --build -d
curl -fsS http://127.0.0.1:7000/health
```

Les sources directes et les addons P2P fonctionnent sans clé Jackett. Pour activer Jackett, renseigner son URL accessible depuis le conteneur, sa clé et les identifiants des indexeurs dans `.env`, puis relancer Compose. Si Jackett est aussi dans Docker, connecter les deux services à un réseau Docker commun et utiliser le nom de service de Jackett. Le volume Compose `index` conserve la base entre les mises à jour.

Le port 7000 est publié uniquement sur l'interface locale. Configurer le reverse proxy HTTPS du VPS pour transmettre les requêtes vers `http://127.0.0.1:7000`. Par exemple, avec Caddy sur l'hôte :

```caddyfile
torrent.example.com {
    reverse_proxy 127.0.0.1:7000
}
```

Après avoir configuré le DNS et HTTPS, ajouter `https://torrent.example.com/manifest.json` dans une application compatible avec les addons Stremio. Pour le torrent direct, le lecteur doit prendre en charge les résultats `infoHash` et `fileIdx`. Vérifier qu'une requête au manifeste et qu'une requête à `/stream/movie/tt1254207.json` répondent depuis Internet avant de tester le lecteur.

Pour mettre à jour le service :

```sh
git pull --ff-only
docker compose up --build -d
```
