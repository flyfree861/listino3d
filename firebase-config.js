// Configurazione del progetto Firebase "listino3d" e utenti autorizzati.
// Questi valori non sono segreti: i dati sono protetti dalle regole in firestore.rules.

export const firebaseConfig = {
  apiKey: "AIzaSyDBWX2ThFhxLSHrw_nXA_ntU9-OgYZXloU",
  authDomain: "listino3d.firebaseapp.com",
  projectId: "listino3d",
  storageBucket: "listino3d.firebasestorage.app",
  messagingSenderId: "256995508343",
  appId: "1:256995508343:web:ca4c9abf6dd89131dbc672"
};

export const ALLOWED_EMAILS = [
  "mazzuoccolo.fabio@gmail.com",
  "stefaniapranzo211089@gmail.com"
];
