import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getMessaging, isSupported } from 'firebase/messaging';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBuDG22bd6LJ0EEeJCk8JVR_sX_KJ1Vxz8",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "projetoimprimir-2f58d.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "projetoimprimir-2f58d",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "projetoimprimir-2f58d.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "781652376822",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:781652376822:web:25388cee0b0ee36c57c0d7"
};

export const firebaseConfigured = Object.values(firebaseConfig).every(Boolean);
const app = firebaseConfigured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export const getMessagingIfSupported = async () => app && await isSupported() ? getMessaging(app) : null;
