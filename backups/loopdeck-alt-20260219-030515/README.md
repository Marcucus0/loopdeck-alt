# Loopdeck Alt

Application locale Node.js pour Loupedeck Live:
- 8 profils (`HOME`, `1..7`)
- 12 touches tactiles par profil
- actions `command`, `url`, `app`
- icones site/app/icones perso
- LED des 8 boutons physiques (couleur configurable par profil)

## Lancer

```bash
npm install
npm start
```

UI: `http://localhost:3210`

## Outil visuel

```bash
npm run fill
```

## Structure

- `app.mjs`: serveur + logique Loupedeck
- `public/`: UI web
- `config/shortcuts.json`: configuration persistée
- `config/icons/`: cache icones perso
