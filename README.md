# SDAL de la ville de Meknès — photothèque de l'éclairage public

Application web **100 % statique** (aucun back-end) pour consulter les photos des armoires et des points lumineux de l'inventaire du SDAL de Meknès et les télécharger. Réalisé par CETENER et NOVEC.

## Fonctionnement

- **Armoires / Points lumineux** : 657 armoires et 36 491 points lumineux chargés au démarrage.
- **Liste** ou **Carte** : la carte est limitée à la ville de Meknès. Les points sont regroupés jusqu'au zoom 16 puis tous affichés ; la case « Tous les points » supprime le regroupement. Les marqueurs sont dessinés sur canvas.
- **Filtres** : recherche libre, armoire, « Avec photos », et **filtres par colonne** cumulables (contient, égal, différent, supérieur, inférieur, vide, renseigné).
- **Fiche élément** : photos par type, visionneuse plein écran, attributs, lien armoire ↔ points lumineux.
- **Mode d'emploi** affiché au premier usage, puis accessible par le bouton « ? Mode d'emploi ».

## Photos

L'adresse du stockage des photos est fixée dans `public/js/app.js` (`IMAGE_BASE`) ; elle n'est pas modifiable depuis l'interface.
Les cellules contenant plusieurs noms (séparés par virgules) sont éclatées ; `0` ou vide = pas de photo.

| Type | Colonnes | Dossier dans le ZIP |
|---|---|---|
| Armoires | `Photos extérieures`, `Photos intérieures` | `exterieur`, `interieur` |
| Points lumineux | `photo_poin`, `photos_lum`, `photo_pied` | `point`, `luminaire`, `pied` |

## Téléchargement (sur la sélection filtrée)

- **Télécharger les photos des armoires / des points lumineux** : lots ZIP d'environ 1,5 Go (entre 1 et 2 Go), un bouton par lot. Un élément n'est jamais coupé entre deux lots ; les PL sont triés par armoire, ceux sans armoire en fin.
  Arborescence : `armoires/<FID>/<type>/…` et `points_lumineux/armoire_<FID|sans>/PL_<fid>/<type>/…`.
  Sous Chrome/Edge, chaque ZIP est écrit directement sur le disque.
- **Liens (.txt)** : une URL de photo par ligne, pour la sélection ou pour un lot.

Le ZIP nécessite le CORS sur le Space DigitalOcean : Settings > CORS Configurations, origine = domaine du Worker Cloudflare, méthodes `GET`, `HEAD`.

## Structure

```
public/            site servi par Cloudflare Workers
  index.html  css/  js/app.js  assets/ (logos)
  data/            inventaire (JSON, découpé en fichiers < 25 Mo)
wrangler.toml      [assets] directory = "./public"
```
Bibliothèques via CDN : Leaflet, Leaflet.markercluster, client-zip.
