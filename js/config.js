/* =========================================================
   DEPLOYMENT CONFIG

   FIREBASE_CONFIG — paste your Firebase web-app config object
   here to enable shared trips (the "Create a share link"
   button). Until then the site runs fully in local-only mode:
   everything works, saved to this browser.

   These values are public project identifiers, not secrets —
   what guards the data is the Firestore security rules
   (see README.md for the exact rules + setup steps).

   Example:
   export const FIREBASE_CONFIG = {
     apiKey: "AIza…",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     storageBucket: "your-project.firebasestorage.app",
     messagingSenderId: "…",
     appId: "1:…:web:…"
   };
   ========================================================= */

export const FIREBASE_CONFIG = null;
