# SDAL de la ville de Meknès — photothèque de l'éclairage public

Application web **100 % statique** (aucun back-end) pour consulter les photos des armoires et des points lumineux de l'inventaire du SDAL de Meknès et les télécharger. Réalisé par CETENER et NOVEC.

## Fonctionnement

- **Armoires / Points lumineux** : 657 armoires et 36 491 points lumineux chargés au démarrage.
- **Liste** ou **Carte** : la carte est limitée à la ville de Meknès. Les points sont regroupés jusqu'au zoom 16 puis tous affichés ; la case « Tous les points » supprime le regroupement. Les marqueurs sont dessinés sur canvas.
- **Filtres** : recherche libre, armoire, « Avec photos », et **filtres par colonne** cumulables (contient, égal, différent, supérieur, inférieur, vide, renseigné).
- **Fiche élément** : photos par type, visionneuse plein écran, attributs, lien armoire ↔ points lumineux.
- **Guide pas à pas** sur chaque écran (prise en main, carte, fiche, téléchargement, administration) : il pointe les boutons importants, avec Précédent / Suivant. Affiché automatiquement à la première visite de chaque écran (mémorisé dans le navigateur), relancé par le bouton **? Guide**.
- **Directives SRM** : règles d'utilisation et procédure de téléchargement des photos pour les agents (bouton dédié et dernière étape du guide).

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

## Registre des opérations et des connexions

Chaque visite et chaque opération (consultation de fiche, recherche, filtre, préparation et téléchargement de lots, export de liens…) est enregistrée par le Worker avec l'adresse IP, le pays, la ville, l'opérateur réseau et le navigateur. Une « connexion » regroupe les opérations d'un même onglet de navigateur. Conservation : 365 jours.

Consultation : **`/admin`**, protégée par une clé d'administration (journal filtrable, historique des connexions, indicateurs, export CSV).

Sécurité :
- la clé n'est stockée nulle part ; le Worker ne connaît que son empreinte SHA-256 (`ADMIN_KEY_HASH`), comparée en temps constant ;
- verrouillage 15 min après 5 échecs depuis une même IP, blocage global après 20 échecs par heure ; chaque échec est journalisé ;
- session aléatoire de 256 bits stockée côté serveur (empreinte uniquement), cookie `__Host-` HttpOnly, Secure, SameSite=Strict, durée 8 h, liée au navigateur ;
- contrôle d'origine sur toutes les requêtes POST ; en-têtes CSP stricts, `no-store`, `noindex`, anti-iframe sur l'administration ;
- limitation à 120 opérations/minute par IP sur l'enregistrement.

Changer la clé : générer une nouvelle clé (≥ 48 caractères aléatoires), calculer son SHA-256, remplacer `ADMIN_KEY_HASH` dans `wrangler.toml` (ou le définir en secret dans Cloudflare) et redéployer.

Stockage : Durable Object `AuditLog` avec SQLite, créé automatiquement au déploiement (`src/worker.js`).

## Structure

```
public/            site statique
  index.html  css/  js/app.js  assets/ (logos)
  data/            inventaire (JSON, découpé en fichiers < 25 Mo)
  admin/           page d'administration du registre
src/worker.js      Worker : API du registre, authentification, Durable Object SQLite
wrangler.toml      assets, Durable Object, empreinte de la clé d'administration
```
Bibliothèques via CDN : Leaflet, Leaflet.markercluster, client-zip.
