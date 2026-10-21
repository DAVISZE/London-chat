import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)) });

const credentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;
if (!admin.apps.length) admin.initializeApp({
  credential: credentials ? admin.credential.cert(credentials) : admin.credential.applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID || credentials?.project_id,
});

const groups = [
  ['familia', 'Família'], ['carro-1', 'Carro 1'], ['carro-2', 'Carro 2'], ['voo', 'Voo'], ['chateiros', 'Chateiros'],
];
const db = admin.firestore();
const users = await admin.auth().listUsers(1000);
if (!users.users.length) throw new Error('Create the family accounts first, then run this seed command.');
const batch = db.batch();
for (const [id, name] of groups) {
  batch.set(db.doc(`groups/${id}`), { name, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  for (const user of users.users) {
    batch.set(db.doc(`groups/${id}/members/${user.uid}`), { uid: user.uid, displayName: user.displayName || user.email?.split('@')[0] || 'Membro', role: 'member', joinedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
}
await batch.commit();
console.log(`Created five family groups for ${users.users.length} account(s).`);
console.warn('Review memberships before production if not every registered account belongs in these groups.');
