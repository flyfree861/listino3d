# Listino 3D – installazione (costo zero)

App per calcolare costi e prezzi delle stampe 3D, condivisa tra due telefoni.
Ogni telefono salva i dati in un database **SQLite locale**, quindi l'app funziona anche senza internet.
Quando c'è connessione si sincronizza con **Firebase Firestore**, il database comune su cloud (piano gratuito "Spark", senza carta di credito).
Se lo stesso dato viene modificato su entrambi i telefoni, resta la modifica più recente.

Ci vogliono circa 20 minuti, da fare una volta sola dal computer.

---

## 1. Crea il progetto Firebase
1. Vai su https://console.firebase.google.com e accedi con il tuo account Google.
2. **Aggiungi progetto** → scegli un nome (es. `listino3d`) → Google Analytics puoi **disattivarlo** → Crea.
3. Il piano resta **Spark (gratuito)**: non attivare Blaze e non inserire la carta.

## 2. Crea gli account per voi due
1. Menu a sinistra **Build → Authentication → Inizia**.
2. Scheda **Metodo di accesso** → **Email/password** → Attiva → Salva.
3. Scheda **Utenti** → **Aggiungi utente**: inserisci la tua email e una password. Ripeti per la tua compagna.

## 3. Crea il database
1. **Build → Firestore Database → Crea database**.
2. Posizione: `europe-west8 (Milano)` oppure `eur3 (Europe)`. Scegli **Modalità produzione**.
3. Apri la scheda **Regole**, cancella tutto e incolla il contenuto del file `firestore.rules`,
   **mettendo le vostre due email** al posto di quelle di esempio → **Pubblica**.
   In questo modo solo voi due potete leggere e scrivere i dati.

## 4. Collega l'app al progetto
1. Clicca sull'ingranaggio ⚙️ → **Impostazioni progetto** → in basso **Le tue app** → icona **</>** (Web).
2. Dai un nome (es. `listino`), **non** spuntare Firebase Hosting → Registra.
3. Firebase ti mostra un blocco `const firebaseConfig = { ... }`. Copia i valori dentro il file
   **`firebase-config.js`** e scrivi le vostre due email nella lista `ALLOWED_EMAILS`.
   È l'unico file da modificare.

## 5. Metti l'app online (GitHub Pages, gratis)
1. Crea un account su https://github.com, se non ce l'hai.
2. **New repository** → nome es. `listino3d` → **Public** → Create.
3. **Add file → Upload files** → trascina **tutti i file e la cartella `icons`** → Commit.
4. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, cartella `/ (root)` → Save.
5. Dopo 1–2 minuti l'app è su `https://TUONOME.github.io/listino3d/`.
6. Torna su Firebase: **Authentication → Impostazioni → Domini autorizzati → Aggiungi dominio** → `TUONOME.github.io`.

> **Il repository è pubblico: è un problema?** No. I dati di `firebase-config.js` non sono una password,
> servono solo a trovare il progetto. A proteggere i dati sono le regole del punto 3 e i vostri account.

## 6. Installa l'app sui telefoni
- **Android (Chrome):** apri il link → menu ⋮ → **Installa app** (o "Aggiungi a schermata Home").
- **iPhone (Safari):** apri il link → tasto Condividi → **Aggiungi alla schermata Home**.

Al primo avvio servono internet e il login. Dopo l'app funziona anche offline.
In alto a destra vedi lo stato: *Sincronizzato*, *N da inviare* oppure *Offline*. Tocca lo stato per sincronizzare subito.

---

## Uso
- **Progetti:** ogni progetto passa da *Bozza* (puoi usarla anche solo come preventivo) a *In produzione* e poi a *Completato*. Quando lo metti in produzione i costi si bloccano e filamento e accessori vengono scalati dal magazzino. Quando lo completi finisce nello Storico.
- **Bobine e accessori:** in ogni progetto scegli una o più bobine con i grammi di ciascuna, e gli accessori con la quantità totale (es. 15 tag NFC).
- **Regali:** spunta *È un regalo*. Con 0 pezzi di recupero il costo resta una perdita; con un numero (es. 30) quel costo viene aggiunto a rate al prezzo suggerito dei prossimi 30 pezzi che metti in produzione.
- **Scarti e vendite:** sui progetti in produzione o completati indichi i pezzi venuti male e registri le vendite (pezzi, prezzo, data).
- **Data di consegna (facoltativa):** nell'elenco compare quanto manca; in rosso se è oggi o scaduta, in arancione se mancano 3 giorni o meno. I progetti con consegna più vicina stanno in cima.
- **Storico:** i progetti completati, con i prezzi. Puoi registrare altre vendite, riaprirli o duplicarli come nuovo progetto.
- **Magazzino:** le bobine (colore, materiale, marca, peso, prezzo pagato, grammi rimasti; per quelle già iniziate scrivi i grammi che restano) e gli accessori comprati all'ingrosso (costo unitario e pezzi rimasti).
- **Guadagni:** il bilancio (incassato meno stampante, bobine, accessori ed energia, più il valore di ciò che hai in magazzino), quanto hai ripagato della stampante, il grafico per mese e i dettagli su regali, recuperi e scarti.
- **Impostazioni:** energia, consumo, €/kg di riserva, stampante, ore di ammortamento, % di fallite e ricarichi. Valgono per entrambi i telefoni.

**Formula:** Nel progetto inserisci i pezzi da produrre (es. 100) e i dati di un piatto dallo slicer (pezzi, grammi, tempo): l'app calcola grammi e tempo totali in proporzione.
costo pezzo = (filamento + energia + ammortamento) × (1 + % fallite) + accessori, il tutto ÷ pezzi totali.
I prezzi suggeriti sono il costo × il ricarico (+ l'eventuale quota di recupero regali), arrotondati ai 10 centesimi.

## Aggiornare l'app
Se modifichi un file, ricaricalo su GitHub. I telefoni prendono la nuova versione alla successiva apertura con internet.

## Costi
Con due utenti e qualche centinaio di prodotti restate molto sotto i limiti gratuiti di Firebase Spark.
Senza piano Blaze non esiste un modo per farvi pagare: nel caso peggiore il servizio si fermerebbe fino al giorno dopo.
