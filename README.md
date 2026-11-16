# Hikaku 🎧

Lecteur de musique pour iPhone (web-app installable) : tes MP3 + la radio en direct,
avec **lecture en arrière-plan** et contrôles sur l’écran verrouillé.

## Fonctions

- **Import de MP3** depuis l’app Fichiers (iCloud Drive, Téléchargements…), plusieurs d’un coup.
  Titre, artiste, album, n° de piste, pochette et paroles sont lus automatiquement dans les tags.
- **Lecture en arrière-plan**, écran verrouillé, Centre de contrôle (lecture/pause, suivant/précédent, barre de progression).
- Accueil : **Mix du jour**, écoutés récemment, tes préférés, ajoutés récemment, albums, tes radios.
- Bibliothèque : titres (tri), albums, artistes, playlists.
- **Playlists** perso + playlists auto (Titres likés, Les plus écoutés, Ajoutés récemment).
- **File d’attente** : lire ensuite, ajouter à la file, réordonner, retirer.
- Aléatoire, répéter tout / un titre, **minuteur de mise en veille**, **vitesse de lecture**.
- **Paroles** (lues dans le MP3 ou collées à la main), modification des infos d’un titre.
- **Radio** : stations populaires par pays, par genre, recherche, favoris, ajout d’un flux perso.
- Recherche dans toute la bibliothèque, fonctionne hors-ligne.

Tout reste sur le téléphone : rien n’est envoyé sur Internet (sauf la recherche de radios).

## Installer sur l’iPhone

1. Ouvre l’adresse de l’appli dans **Safari**.
2. Touche **Partager** → **Sur l’écran d’accueil** → **Ajouter**.
3. Ouvre Hikaku depuis l’icône : la musique continue quand tu changes d’appli ou verrouilles l’écran.

> Ne ferme pas Hikaku en la balayant dans le sélecteur d’apps, sinon iOS coupe la lecture.

## Mise en ligne (GitHub Pages)

Settings → Pages → *Build and deployment* → Source : **Deploy from a branch** →
choisir la branche et le dossier `/ (root)` → Save. L’adresse sera
`https://<utilisateur>.github.io/Hikaku/`.

## Développement

Aucune dépendance ni étape de build : HTML/CSS/JS pur.

```
python3 -m http.server 8000   # puis http://localhost:8000
```

| Fichier | Rôle |
|---|---|
| `js/player.js` | moteur de lecture (file, aléatoire, radio, écran verrouillé) |
| `js/app.js` | interface et navigation |
| `js/id3.js` | lecture des tags ID3 et durée des MP3 |
| `js/db.js` | stockage local (IndexedDB) |
| `js/radio.js` | annuaire radio-browser.info |
| `sw.js` | fonctionnement hors-ligne |
