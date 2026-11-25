# Listino 3D

App per telefono (PWA) che calcola costi e prezzi delle stampe 3D.
I dati sono condivisi tra due utenti tramite Firebase Firestore, con un database SQLite locale che funziona anche offline.

- Installazione e configurazione: vedi [LEGGIMI.md](LEGGIMI.md)
- Unico file da personalizzare: `firebase-config.js`
- Regole di sicurezza del database: `firestore.rules`

## Struttura
| File | Contenuto |
| --- | --- |
| `index.html` | interfaccia e stile |
| `app.js` | SQLite locale (sql.js), login, sincronizzazione con Firestore |
| `calc.js` | formule di costo e prezzo, regola di unione dei dati |
| `sw.js` | service worker: installazione e funzionamento offline |
| `manifest.webmanifest`, `icons/` | nome e icone dell'app |
