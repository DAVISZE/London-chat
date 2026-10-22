import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)) });

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map(value => value.trim());
const SESSION_COOKIE = 'family_access';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const USER_ATTEMPT_LIMIT = 5;
const IP_ATTEMPT_LIMIT = 20;
const deletionNoticeAttempts = new Map();
const FAMILY_GROUPS = [
  ['familia', 'Família'], ['carro-1', 'Carro 1'], ['carro-2', 'Carro 2'], ['voo', 'Voo'], ['chateiros', 'Chateiros'],
];
const requiredEnvironment = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'FIREBASE_PROJECT_ID', 'FAMILY_ACCESS_PASSWORD', 'FAMILY_SESSION_SECRET'];
const missingEnvironment = () => requiredEnvironment.filter(name => !process.env[name]?.trim());

function originAllowed(req) {
  const origin = req.get('origin');
  return Boolean(origin && allowedOrigins.includes(origin));
}

function sessionHash(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex');
}

function familyCookie(req) {
  const raw = req.headers.cookie || '';
  const value = raw.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!value) return null;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  const [payload, signature, extra] = decoded.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', process.env.FAMILY_SESSION_SECRET || '').update(payload).digest();
  let provided;
  try { provided = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.uid || !data.sid || !Number.isFinite(data.exp) || data.exp <= Date.now()) return null;
    return data;
  } catch { return null; }
}

function makeFamilyCookie(uid, sessionId, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ uid, sid: sessionId, exp: expiresAt })).toString('base64url');
  const signature = createHmac('sha256', process.env.FAMILY_SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function productionCookieMode() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE) || process.env.PUBLIC_HTTPS === 'true';
}

function setFamilyCookie(res, value) {
  const production = productionCookieMode();
  const sameSite = production ? 'None' : 'Lax';
  const secure = production ? '; Secure' : '';
  res.set('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearFamilyCookie(res) {
  const production = productionCookieMode();
  res.set('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${production ? 'None' : 'Lax'}; Max-Age=0${production ? '; Secure' : ''}`);
}

async function authenticatedUser(req) {
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try { return await firebaseAdmin().auth().verifyIdToken(match[1], true); }
  catch { return null; }
}

async function sessionIsActive(req, uid) {
  const cookie = familyCookie(req);
  if (!cookie || cookie.uid !== uid) return false;
  const record = await firebaseAdmin().firestore().doc(`familyAccessSessions/${uid}`).get();
  if (!record.exists) return false;
  const data = record.data();
  return data.active === true && data.sessionHash === sessionHash(cookie.sid)
    && data.expiresAt?.toMillis?.() > Date.now();
}

function rateKey(value) {
  return createHmac('sha256', process.env.FAMILY_SESSION_SECRET).update(value).digest('hex');
}

async function rateLimited(uid, ip) {
  const firestore = firebaseAdmin().firestore();
  const now = Date.now();
  const docs = [
    firestore.doc(`familyAccessAttempts/u_${rateKey(uid)}`),
    firestore.doc(`familyAccessAttempts/i_${rateKey(ip || 'unknown')}`),
  ];
  return firestore.runTransaction(async transaction => {
    const snapshots = await Promise.all(docs.map(ref => transaction.get(ref)));
    return snapshots.some(snapshot => snapshot.exists && snapshot.data().lockedUntil > now);
  });
}

async function registerFailedPassword(uid, ip) {
  const firestore = firebaseAdmin().firestore();
  const now = Date.now();
  const refs = [
    { ref: firestore.doc(`familyAccessAttempts/u_${rateKey(uid)}`), max: USER_ATTEMPT_LIMIT },
    { ref: firestore.doc(`familyAccessAttempts/i_${rateKey(ip || 'unknown')}`), max: IP_ATTEMPT_LIMIT },
  ];
  await firestore.runTransaction(async transaction => {
    const snapshots = await Promise.all(refs.map(item => transaction.get(item.ref)));
    refs.forEach((item, index) => {
      const data = snapshots[index].data() || {};
      const inWindow = Number.isFinite(data.windowStartedAt) && now - data.windowStartedAt < RATE_WINDOW_MS;
      const attempts = inWindow ? (data.attempts || 0) + 1 : 1;
      transaction.set(item.ref, { attempts, windowStartedAt: inWindow ? data.windowStartedAt : now, lockedUntil: attempts >= item.max ? now + RATE_WINDOW_MS : 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  });
}

async function clearRateAttempts(uid, ip) {
  const firestore = firebaseAdmin().firestore();
  await Promise.all([
    firestore.doc(`familyAccessAttempts/u_${rateKey(uid)}`).delete(),
    firestore.doc(`familyAccessAttempts/i_${rateKey(ip || 'unknown')}`).delete(),
  ]);
}

async function startFamilySessionAndJoinGroups(uid, displayName, sessionId, expiresAt) {
  const firestore = firebaseAdmin().firestore();
  const batch = firestore.batch();
  batch.set(firestore.doc(`familyAccessSessions/${uid}`), {
    sessionHash: sessionHash(sessionId), active: true,
    expiresAt: admin.firestore.Timestamp.fromMillis(expiresAt),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  for (const [groupId, name] of FAMILY_GROUPS) {
    batch.set(firestore.doc(`groups/${groupId}`), {
      name, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.set(firestore.doc(`groups/${groupId}/members/${uid}`), {
      uid, displayName, role: 'member',
      joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
}

async function ensureFamilyGroupsForActiveMember(uid, displayName) {
  const firestore = firebaseAdmin().firestore();
  const groupRefs = FAMILY_GROUPS.map(([groupId]) => firestore.doc(`groups/${groupId}`));
  const memberRefs = FAMILY_GROUPS.map(([groupId]) => firestore.doc(`groups/${groupId}/members/${uid}`));
  await firestore.runTransaction(async transaction => {
    const snapshots = await Promise.all([...groupRefs, ...memberRefs].map(ref => transaction.get(ref)));
    FAMILY_GROUPS.forEach(([groupId, name], index) => {
      if (!snapshots[index].exists) transaction.set(groupRefs[index], { name, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      if (!snapshots[FAMILY_GROUPS.length + index].exists) transaction.set(memberRefs[index], {
        uid, displayName, role: 'member', joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  });
}

function passwordMatches(candidate) {
  const expected = createHash('sha256').update(process.env.FAMILY_ACCESS_PASSWORD, 'utf8').digest();
  const provided = createHash('sha256').update(candidate, 'utf8').digest();
  return timingSafeEqual(expected, provided);
}

app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)), credentials: true, methods: ['POST', 'GET'], allowedHeaders: ['Authorization', 'Content-Type'] }));
app.use(express.json({ limit: '8kb' }));
app.use((req, res, next) => { if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store'); next(); });
if (process.env.K_SERVICE) app.set('trust proxy', 1);

function firebaseAdmin() {
  if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({ credential: admin.credential.cert(credentials), projectId: credentials.project_id });
    } else admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
  }
  return admin;
}

app.get('/health', (_req, res) => {
  const missing = missingEnvironment();
  res.status(missing.length ? 503 : 200).json({ status: missing.length ? 'needs_configuration' : 'ok', missing });
});

app.post('/api/account-deletion-status', async (req, res) => {
  if (!originAllowed(req)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email || email.length > 320 || !email.includes('@')) return res.status(400).json({ deleted: false });
  const now = Date.now();
  const key = req.ip || 'unknown';
  const attempt = deletionNoticeAttempts.get(key) || { count: 0, resetAt: now + 10 * 60 * 1000 };
  if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 10 * 60 * 1000; }
  attempt.count += 1;
  deletionNoticeAttempts.set(key, attempt);
  if (attempt.count > 20) return res.status(429).json({ deleted: false });
  try {
    const digest = createHash('sha256').update(email, 'utf8').digest('hex');
    try {
      await firebaseAdmin().auth().getUserByEmail(email);
      res.set('Cache-Control', 'no-store');
      return res.json({ deleted: false });
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    const notice = await firebaseAdmin().firestore().doc(`accountDeletionNotices/${digest}`).get();
    res.set('Cache-Control', 'no-store');
    return res.json({ deleted: notice.exists });
  } catch {
    return res.status(503).json({ deleted: false });
  }
});

app.get('/api/family/session', async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Individual sign-in is required.' });
  try {
    if (!await sessionIsActive(req, user.uid)) return res.status(401).json({ error: 'Family access is required.' });
    await ensureFamilyGroupsForActiveMember(user.uid, String(user.name || user.email?.split('@')[0] || 'Membro').slice(0, 80));
    const cookie = familyCookie(req);
    res.set('Cache-Control', 'no-store');
    res.json({ active: true, expiresAt: cookie.exp });
  } catch {
    res.status(503).json({ error: 'Family access could not be verified.' });
  }
});

app.post('/api/family/access', async (req, res) => {
  if (!originAllowed(req)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  const missing = ['FAMILY_ACCESS_PASSWORD', 'FAMILY_SESSION_SECRET', 'FIREBASE_PROJECT_ID'].filter(name => !process.env[name]?.trim());
  if (missing.length) return res.status(503).json({ error: 'Family access is not configured.', missing });
  if (!/^Bearer\s+.+/i.test(req.headers.authorization || '')) {
    return res.status(401).json({ error: 'Individual sign-in is required.', code: 'AUTH_REQUIRED' });
  }
  const user = await authenticatedUser(req);
  if (!user) return res.status(503).json({ error: 'O servidor não conseguiu validar sua conta Firebase. Configure a credencial Firebase Admin no backend.', code: 'FIREBASE_ADMIN_AUTH_UNAVAILABLE' });
  if (typeof req.body?.password !== 'string' || req.body.password.length > 1024) return res.status(400).json({ error: 'Access could not be verified.' });
  try {
    if (await rateLimited(user.uid, req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!passwordMatches(req.body.password)) {
      await registerFailedPassword(user.uid, req.ip);
      return res.status(401).json({ error: 'A senha da família está incorreta.', code: 'FAMILY_PASSWORD_INCORRECT' });
    }
    const sessionId = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await startFamilySessionAndJoinGroups(user.uid, 'Membro', sessionId, expiresAt);
    await clearRateAttempts(user.uid, req.ip);
    setFamilyCookie(res, makeFamilyCookie(user.uid, sessionId, expiresAt));
    res.set('Cache-Control', 'no-store');
    res.json({ active: true, expiresAt });
  } catch {
    res.status(503).json({ error: 'Family access could not be verified.' });
  }
});

app.post('/api/family/profile', async (req, res) => {
  if (!originAllowed(req)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  if (!await sessionIsActive(req, user.uid)) return res.status(403).json({ error: 'Family access is required.' });
  const displayName = typeof req.body?.displayName === 'string'
    ? req.body.displayName.trim().replace(/\s+/g, ' ').slice(0, 80)
    : '';
  if (!displayName) return res.status(400).json({ error: 'Informe seu nome para continuar.' });
  try {
    const firestore = firebaseAdmin().firestore();
    const batch = firestore.batch();
    batch.set(firestore.doc(`users/${user.uid}`), {
      displayName, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    for (const [groupId] of FAMILY_GROUPS) {
      batch.set(firestore.doc(`groups/${groupId}/members/${user.uid}`), {
        uid: user.uid, displayName, role: 'member',
      }, { merge: true });
    }
    await batch.commit();
    res.set('Cache-Control', 'no-store');
    res.json({ saved: true });
  } catch {
    res.status(503).json({ error: 'Não foi possível salvar seu nome agora.' });
  }
});

app.post('/api/family/session/end', async (req, res) => {
  if (!originAllowed(req)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Individual sign-in is required.' });
  try {
    const cookie = familyCookie(req);
    if (cookie?.uid === user.uid) {
      await firebaseAdmin().firestore().doc(`familyAccessSessions/${user.uid}`).set({ active: false, expiresAt: admin.firestore.Timestamp.fromMillis(Date.now()), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    clearFamilyCookie(res);
    res.json({ active: false });
  } catch {
    res.status(503).json({ error: 'Family access could not be ended.' });
  }
});

app.post('/api/livekit/token', async (req, res) => {
  if (!originAllowed(req)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  const missing = missingEnvironment();
  if (missing.length) return res.status(503).json({ error: 'Configure the listed server environment variables to enable audio calls.', missing });
  let phase = 'firebase-token-verification';
  try {
    const authorization = req.headers.authorization || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Authentication required.' });
    const decoded = await firebaseAdmin().auth().verifyIdToken(match[1], true);
    phase = 'family-session-verification';
    if (!await sessionIsActive(req, decoded.uid)) return res.status(403).json({ error: 'Family access is required.' });
    const { groupId, recipientUid } = req.body || {};
    const group = typeof groupId === 'string' && /^[a-z0-9-]{1,40}$/.test(groupId) ? groupId : '';
    if (!group) return res.status(400).json({ error: 'A valid group is required.' });
    phase = 'group-membership-verification';
    const firestore = firebaseAdmin().firestore();
    const currentMember = await firestore.doc(`groups/${group}/members/${decoded.uid}`).get();
    if (!currentMember.exists) return res.status(403).json({ error: 'You are not a member of this group.' });

    let roomName = `group-${group}`;
    if (recipientUid) {
      if (typeof recipientUid !== 'string' || recipientUid === decoded.uid) return res.status(400).json({ error: 'Choose another family member.' });
      const recipient = await firestore.doc(`groups/${group}/members/${recipientUid}`).get();
      if (!recipient.exists) return res.status(403).json({ error: 'That user is not a member of this group.' });
      roomName = `direct-${[decoded.uid, recipientUid].sort().join('-')}`;
    }

    phase = 'livekit-token-signing';
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: decoded.uid, name: decoded.name || decoded.email || 'Família', ttl: '10m' });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canSubscribe: true, canPublishData: true });
    res.set('Cache-Control', 'no-store');
    res.json({ token: await token.toJwt(), url: LIVEKIT_URL, roomName });
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : typeof error?.name === 'string' ? error.name : 'unknown';
    console.error(`LiveKit token request failed during ${phase} (${code}).`);
    res.status(401).json({ error: 'Could not authorize the audio call.' });
  }
});

app.listen(port, () => {
  const missing = missingEnvironment();
  console.log(`London Family token API listening on port ${port}.`);
  if (missing.length) console.warn(`Server configuration incomplete. Missing: ${missing.join(', ')}`);
});
