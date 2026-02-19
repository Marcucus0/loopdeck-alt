# Loopdeck Alt

Application locale Node.js pour piloter un Loupedeck Live avec une UI web.

## Fonctionnalites

- 8 profils (`HOME`, `1..7`)
- 12 touches tactiles par profil
- widgets/action types:
  - `url`
  - `command`
  - `app`
  - `app_volume` (mixer volume par application via potards)
  - `key_press` (inserer une touche)
  - `paste_text` (coller texte via clavier)
  - `macro` (suite de touches avec delai)
  - `multi_action` (chaine de plusieurs widgets)
- icones:
  - favicon de site web
  - icones app Windows
  - icones perso upload
- couleurs de touches + rendu sur device
- switch profil via boutons physiques du bas (HOME + 1..7)
- auto-save UI

## Prerequis

- Windows (flux clavier et ouverture apps testes pour Windows)
- Node.js 20+
- Loupedeck Live branche en USB
- App officielle Loupedeck fermee (eviter conflit HID/COM)

## Installation

```bash
npm install
```

## Lancement

```bash
npm start
```

UI: `http://localhost:3210`

## Outil de test visuel

```bash
npm run fill
```

## Structure du projet

- `app.mjs`: point d'entree minimal
- `src/server.mjs`: orchestration serveur HTTP/API + logique device
- `src/server/config-store.mjs`: normalisation/validation/persistance config
- `src/server/keyboard-actions.mjs`: execution clavier (`key_press`, `paste_text`, `macro`, `multi_action`)
- `public/`: frontend (UI, styles, logique widgets)
- `config/shortcuts.json`: configuration persistante
- `config/icons/`: cache d'icones personnalisees
- `backups/`: snapshots manuels

## API locale

- `GET /api/status`
- `GET /api/config`
- `POST /api/config`
- `POST /api/trigger`
- `POST /api/profile`
- `GET /api/apps`
- `POST /api/icon`
- `DELETE /api/icon`

## Notes

- Les actions clavier (`key_press`, `paste_text`, `macro`) ciblent la fenetre active Windows.
- En cas de comportement etrange, verifier qu'une seule instance `node app.mjs` tourne.
