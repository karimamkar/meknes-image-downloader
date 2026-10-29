# SIG Meknès — visualisation et téléchargement des photos

Application web **100 % statique** (aucun back-end) pour parcourir les armoires et les points lumineux de l'inventaire SIG, voir leurs photos et les télécharger.

## Utilisation

1. Ouvrir `index.html` via un serveur HTTP (GitHub Pages, ou en local : `python -m http.server`). Un extrait (`data/sample_*.xlsx` : 6 armoires, 106 PL) se charge au démarrage.
2. **⚙ Paramètres** : charger les fichiers complets `SIG_Armoires.xlsx` et `SIG_Points_Lumineux.xlsx` (lus dans le navigateur, rien n'est envoyé), modifier l'URL des images si besoin.
3. Onglets **Armoires / Points lumineux**, vue **Liste** ou **Carte** (clusters, fond plan ou satellite). Filtres : recherche texte, armoire, « avec photos ».
4. Clic sur un élément : galerie par type de photo, visionneuse (flèches ←/→), attributs, lien vers l'armoire ou ses PL.

## Photos

URL = `https://streetlighting-audit.lon1.digitaloceanspaces.com/` + nom du fichier.
Les cellules contenant plusieurs noms (séparés par virgules) sont éclatées ; une valeur `0` ou vide = pas de photo.

| Type | Colonnes | Dossier |
|---|---|---|
| Armoires | `Photos extérieures`, `Photos intérieures` | `exterieur`, `interieur` |
| Points lumineux | `photo_poin`, `photos_lum`, `photo_pied` | `point`, `luminaire`, `pied` |

Une photo trouvée dans une autre colonne est classée dans `autres`.

## Téléchargement (sur la sélection filtrée)

- **ZIP** : construit dans le navigateur, arborescence `armoires/<FID>/<type>/…` et `points_lumineux/armoire_<FID>/PL_<fid>/<type>/…`. Nécessite que le bucket autorise le CORS (voir ci-dessous). Au-delà de ~3 000 photos, filtrer par armoire.
- **Script PowerShell** : télécharge toute la sélection avec la même arborescence, reprend là où il s'est arrêté, journalise les erreurs. Recommandé pour les gros volumes (107 000 photos au total).
- **Liste des liens (.txt)** : une URL par ligne (gestionnaire de téléchargement, `wget -i`, etc.).

### Activer le CORS sur le Space DigitalOcean (pour le ZIP)

Space `streetlighting-audit` > Settings > CORS Configurations : origine = domaine de l'app (ex. `https://karimamkar.github.io`), méthodes `GET`, `HEAD`, en-têtes `*`.

## Structure

```
public/  index.html  css/  js/  assets/ (logos)  data/ (extrait)
wrangler.toml  (Cloudflare Pages : dossier de sortie public/, pas de commande de build)
```
Bibliothèques via CDN : SheetJS, Leaflet + MarkerCluster, JSZip.
