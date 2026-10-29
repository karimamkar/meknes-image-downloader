# SIG Meknès — visualisation et téléchargement des photos

Application web **100 % statique** (aucun back-end) pour parcourir les armoires et les points lumineux de l'inventaire SIG, voir leurs photos et les télécharger.

## Utilisation

1. L'inventaire complet (657 armoires, 36 491 points lumineux) est chargé au démarrage depuis `public/data/` (JSON généré à partir des Excel SIG).
2. Onglets **Armoires / Points lumineux**, vue **Liste** ou **Carte** (clusters, fond plan ou satellite). Filtres : recherche texte, armoire, « avec photos ».
3. Clic sur un élément : galerie par type de photo, visionneuse (←/→), attributs, lien vers l'armoire ou ses PL, ZIP de l'élément.
4. **⚙ Paramètres** : URL des images, téléchargements simultanés, chargement d'autres fichiers Excel.

## Photos

URL = `https://streetlighting-audit.lon1.digitaloceanspaces.com/photos/` + nom du fichier.
Les cellules contenant plusieurs noms (séparés par virgules) sont éclatées ; une valeur `0` ou vide = pas de photo.

| Type | Colonnes | Dossier |
|---|---|---|
| Armoires | `Photos extérieures`, `Photos intérieures` | `exterieur`, `interieur` |
| Points lumineux | `photo_poin`, `photos_lum`, `photo_pied` | `point`, `luminaire`, `pied` |

Une photo trouvée dans une autre colonne est classée dans `autres`.

## Téléchargement (sur la sélection filtrée)

- **Télécharger (ZIP)** : découpe la sélection en lots d'environ 1,5 Go (entre 1 et 2 Go), chacun avec son bouton. La taille moyenne des photos est mesurée sur un échantillon. Un élément n'est jamais coupé entre deux lots ; les PL sont triés par armoire, ceux sans armoire en fin.
  Arborescence : `armoires/<FID>/<type>/…` et `points_lumineux/armoire_<FID|sans>/PL_<fid>/<type>/…`.
  Sous Chrome/Edge, le ZIP est écrit directement sur le disque (pas de limite mémoire) ; ailleurs, il est construit en mémoire.
- **Liste des liens (.txt)** : une URL par ligne, pour la sélection ou pour un lot.

### Activer le CORS sur le Space DigitalOcean (pour le ZIP)

Space `streetlighting-audit` > Settings > CORS Configurations : origine = domaine de l'app (domaine du Worker Cloudflare), méthodes `GET`, `HEAD`, en-têtes `*`.

## Structure

```
public/  index.html  css/  js/  assets/ (logos)  data/ (extrait)
wrangler.toml  (Cloudflare Workers : assets statiques servis depuis public/, déploiement `npx wrangler deploy`)
```
Bibliothèques via CDN : Leaflet + MarkerCluster, client-zip (ZIP en streaming), SheetJS (chargé seulement pour importer un Excel).
