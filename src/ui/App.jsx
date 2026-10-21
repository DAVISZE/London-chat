import { useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, limit, onSnapshot, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { Room, RoomEvent, Track } from 'livekit-client';
import { Activity, ArrowRight, Bell, CarFront, Check, ChevronDown, CircleHelp, Compass, Crosshair, Eye, EyeOff, Forward, KeyRound, LogIn, LogOut, LockKeyhole, MapPin, Menu, MessageCircle, Mic, MicOff, Navigation, Phone, Plane, Send, ShieldCheck, SignalHigh, Sun, Users, X } from 'lucide-react';
import { auth, db, firebaseConfigured } from '../firebase.js';
import MapView from './MapView.jsx';

const GROUPS = [
  { id: 'familia', name: 'Família', icon: Users, color: '#766cf3', text: 'Todos juntos, onde estiverem.' },
  { id: 'carro-1', name: 'Carro 1', icon: CarFront, color: '#61dec0', text: 'Suzuki Vitara · Equipe azul' },
  { id: 'carro-2', name: 'Carro 2', icon: CarFront, color: '#79a4ff', text: 'Carro 2 · Equipe verde' },
  { id: 'voo', name: 'Voo', icon: Plane, color: '#f5bd69', text: 'Acompanhamento do voo' },
  { id: 'chateiros', name: 'Chateiros', icon: MessageCircle, color: '#e08cb5', text: 'A central da família' },
];

function timeLabel(value) {
  if (!value) return 'agora';
  const date = value.toDate ? value.toDate() : new Date(value);
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
}
function isFresh(value) {
  if (!value) return false;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isFinite(date.getTime()) && Date.now() - date.getTime() < 120000;
}

function firestoreMessage(error, feature) {
  if (error?.code === 'permission-denied') return `O Firebase bloqueou ${feature}. Entre com a senha da família novamente após reiniciar o backend; se continuar, publique as regras de firestore.rules.`;
  if (error?.code === 'unavailable' || error?.code === 'deadline-exceeded') return 'Conexão com o Firebase instável. Verifique a internet e tente novamente.';
  return `Não foi possível carregar ${feature}. Tente novamente em instantes.`;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [familyAccess, setFamilyAccess] = useState('checking');
  const [familyAccessEndsAt, setFamilyAccessEndsAt] = useState(0);
  const [familyPassword, setFamilyPassword] = useState('');
  const [showFamilyPassword, setShowFamilyPassword] = useState(false);
  const [familyAccessBusy, setFamilyAccessBusy] = useState(false);
  const [familyAccessError, setFamilyAccessError] = useState('');
  const [active, setActive] = useState('familia');
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [callState, setCallState] = useState('idle');
  const [callMenu, setCallMenu] = useState(false);
  const [callTarget, setCallTarget] = useState(null);
  const [muted, setMuted] = useState(false);
  const [vehicleRole, setVehicleRole] = useState('pessoa');
  const [speakers, setSpeakers] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [credentials, setCredentials] = useState({ name: '', email: '', password: '' });
  const [remoteAudio, setRemoteAudio] = useState([]);
  const [wakeLockStatus, setWakeLockStatus] = useState('requesting');
  const [activePanel, setActivePanel] = useState(null);
  const roomRef = useRef(null);
  const watchRef = useRef(null);
  const messageEndRef = useRef(null);
  const group = useMemo(() => GROUPS.find(item => item.id === active) || GROUPS[0], [active]);

  useEffect(() => {
    if (!firebaseConfigured) { setAuthReady(true); return; }
    return onAuthStateChanged(auth, current => { setUser(current); setAuthReady(true); });
  }, []);

  useEffect(() => {
    if (!('wakeLock' in navigator)) { setWakeLockStatus('unsupported'); return; }
    let disposed = false;
    let pending = false;
    let sentinel = null;
    async function acquireWakeLock() {
      if (disposed || pending || sentinel || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (disposed) { await lock.release(); return; }
        sentinel = lock;
        setWakeLockStatus('active');
        lock.addEventListener('release', () => {
          if (sentinel === lock) {
            sentinel = null;
            setWakeLockStatus('inactive');
          }
        }, { once: true });
      } catch {
        if (!disposed) setWakeLockStatus('inactive');
      } finally { pending = false; }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') acquireWakeLock();
      else if (sentinel) setWakeLockStatus('inactive');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    acquireWakeLock();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      const lock = sentinel;
      sentinel = null;
      if (lock && !lock.released) lock.release().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!user) { setFamilyAccess('locked'); return; }
    let cancelled = false;
    setFamilyAccess('checking');
    user.getIdToken().then(idToken => fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api/family/session`, { credentials: 'include', headers: { Authorization: `Bearer ${idToken}` } }))
      .then(async response => { const payload = await response.json().catch(() => ({})); if (!cancelled) { setFamilyAccess(response.ok ? 'unlocked' : 'locked'); setFamilyAccessEndsAt(response.ok ? payload.expiresAt || 0 : 0); } })
      .catch(() => { if (!cancelled) { setFamilyAccess('locked'); setFamilyAccessError('Não foi possível verificar o acesso agora. Tente novamente.'); } });
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    if (familyAccess !== 'unlocked' || !familyAccessEndsAt) return;
    const remaining = familyAccessEndsAt - Date.now();
    if (remaining <= 0) { setFamilyAccess('locked'); setFamilyAccessError('Sua sessão expirou. Entre novamente com a senha da família.'); return; }
    const timeout = window.setTimeout(() => { setFamilyAccess('locked'); setFamilyAccessError('Sua sessão expirou. Entre novamente com a senha da família.'); }, remaining);
    return () => window.clearTimeout(timeout);
  }, [familyAccess, familyAccessEndsAt]);

  useEffect(() => {
    if (familyAccess === 'unlocked') return;
    if (watchRef.current !== null) { navigator.geolocation?.clearWatch(watchRef.current); watchRef.current = null; setSharing(false); }
    if (roomRef.current) { roomRef.current.disconnect(); roomRef.current = null; setCallState('idle'); }
  }, [familyAccess]);

  useEffect(() => {
    if (!user || !db || familyAccess !== 'unlocked') return;
    // Filter on the indexed groupId field and sort locally. This keeps chat
    // usable before the optional groupId+createdAt composite index is deployed.
    const msgQuery = query(collection(db, 'messages'), where('groupId', '==', active), limit(100));
    setError('');
    const stopMessages = onSnapshot(msgQuery, snapshot => setMessages(snapshot.docs.map(item => ({ id: item.id, ...item.data() })).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0))), e => setError(firestoreMessage(e, 'as mensagens')));
    const memberQuery = query(collection(db, 'groups', active, 'members'));
    const stopMembers = onSnapshot(memberQuery, snapshot => setMembers(snapshot.docs.map(item => ({ id: item.id, ...item.data() }))), e => setError(firestoreMessage(e, 'este grupo')));
    const locationQuery = collection(db, 'groups', active, 'locations');
    const stopLocations = onSnapshot(locationQuery, snapshot => setLocations(snapshot.docs.map(item => ({ id: item.id, ...item.data() }))), e => setError(firestoreMessage(e, 'as localizações')));
    return () => { stopMessages(); stopMembers(); stopLocations(); };
  }, [user, active, familyAccess]);

  useEffect(() => {
    if (!activePanel) return;
    const closeOnEscape = event => { if (event.key === 'Escape') setActivePanel(null); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [activePanel]);

  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages]);
  useEffect(() => () => { if (watchRef.current !== null) navigator.geolocation?.clearWatch(watchRef.current); roomRef.current?.disconnect(); }, []);

  async function authenticate(event) {
    event.preventDefault(); setError('');
    try {
      if (authMode === 'signup') {
        const result = await createUserWithEmailAndPassword(auth, credentials.email, credentials.password);
        await updateProfile(result.user, { displayName: credentials.name });
      } else await signInWithEmailAndPassword(auth, credentials.email, credentials.password);
    } catch (e) { setError(e.code === 'auth/invalid-credential' ? 'E-mail ou senha incorretos.' : e.message); }
  }

  async function enterFamilyAccess(event) {
    event.preventDefault();
    if (!user || !familyPassword || familyAccessBusy) return;
    setFamilyAccessBusy(true); setFamilyAccessError('');
    try {
      const idToken = await user.getIdToken();
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api/family/access`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ password: familyPassword }) });
      const payload = await response.json().catch(() => ({}));
      setFamilyPassword('');
      if (!response.ok) {
        if (payload.code === 'FAMILY_PASSWORD_INCORRECT') throw new Error('A senha da família está incorreta. Tente novamente.');
        if (payload.code === 'FIREBASE_ADMIN_AUTH_UNAVAILABLE') throw new Error(payload.error);
        if (payload.code === 'AUTH_REQUIRED') throw new Error('Sua sessão individual expirou. Saia e entre novamente.');
        if (response.status === 429) throw new Error('Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.');
        if (response.status === 503) throw new Error(`A proteção ainda precisa de configuração no servidor: ${(payload.missing || []).join(', ')}.`);
        throw new Error(payload.error || 'Não foi possível liberar o acesso agora.');
      }
      const profileRef = doc(db, 'users', user.uid);
      if (!(await getDoc(profileRef)).exists()) await setDoc(profileRef, { displayName: user.displayName || user.email.split('@')[0], email: user.email, createdAt: serverTimestamp() });
      setFamilyAccessEndsAt(payload.expiresAt || Date.now() + 8 * 60 * 60 * 1000);
      setFamilyAccess('unlocked');
    } catch (e) { setFamilyAccessError(e.message || 'Não foi possível verificar o acesso agora.'); }
    finally { setFamilyAccessBusy(false); }
  }

  async function exitAccount() {
    try {
      if (user) {
        const idToken = await user.getIdToken();
        await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api/family/session/end`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: '{}' });
      }
    } catch { /* A local sign-out still proceeds when the API is unreachable. */ }
    setFamilyAccess('locked');
    await signOut(auth);
  }

  async function sendMessage(event) {
    event.preventDefault(); const body = text.trim();
    if (!body || !user || sending) return;
    setSending(true); setError('');
    try {
      await addDoc(collection(db, 'messages'), { groupId: active, text: body, senderId: user.uid, senderName: user.displayName || user.email.split('@')[0], createdAt: serverTimestamp() });
      setText('');
    } catch (e) { setError(e?.code === 'permission-denied' ? firestoreMessage(e, 'enviar mensagens neste grupo') : e.message); }
    finally { setSending(false); }
  }

  async function forwardMessage(message) {
    if (!user || !message.text) return;
    try {
      await addDoc(collection(db, 'messages'), { groupId: 'chateiros', text: message.text, senderId: user.uid, senderName: user.displayName || user.email.split('@')[0], createdAt: serverTimestamp(), forwarded: true, forwardedFrom: group.name });
      setActive('chateiros');
      setError('Mensagem encaminhada para Chateiros.');
    } catch (e) { setError(e?.code === 'permission-denied' ? firestoreMessage(e, 'encaminhar mensagens') : e.message); }
  }

  async function toggleLocation() {
    if (!navigator.geolocation) { setError('Este dispositivo não oferece geolocalização.'); return; }
    if (sharing) { navigator.geolocation.clearWatch(watchRef.current); watchRef.current = null; setSharing(false); return; }
    if (!user) return;
    setError('');
    try {
      watchRef.current = navigator.geolocation.watchPosition(async position => {
        const { latitude, longitude, accuracy, speed } = position.coords;
        try {
          const location = { uid: user.uid, displayName: user.displayName || user.email.split('@')[0], latitude, longitude, accuracy, speed, ...(vehicleRole !== 'pessoa' ? { vehicle: vehicleRole } : {}), updatedAt: serverTimestamp(), online: true };
          await Promise.all(GROUPS.map(item => setDoc(doc(db, 'groups', item.id, 'locations', user.uid), location, { merge: true })));
        } catch (e) { setError(e?.code === 'permission-denied' ? firestoreMessage(e, 'compartilhar localização neste grupo') : e.message); navigator.geolocation.clearWatch(watchRef.current); setSharing(false); }
      }, e => { setError(e.code === 1 ? 'Permissão de localização negada. Ative-a nos ajustes do iPhone.' : 'Não foi possível obter a localização agora.'); setSharing(false); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
      setSharing(true);
    } catch { setError('Não foi possível iniciar o compartilhamento.'); }
  }

  async function startCall(recipientUid = null) {
    if (callState !== 'idle' || !user) return;
    setCallTarget(recipientUid ? members.find(member => member.id === recipientUid)?.displayName || 'Familiar' : null);
    setError(''); setCallState('connecting');
    try {
      const idToken = await user.getIdToken();
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api/livekit/token`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ groupId: active, ...(recipientUid ? { recipientUid } : {}) }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 503) throw new Error(`Configure no backend: ${(payload.missing || []).join(', ') || 'serviço indisponível'}.`);
        if (response.status === 403) throw new Error('Sua conta ainda não foi liberada para este grupo. Entre novamente com a senha da família para preparar seus grupos.');
        throw new Error(payload.error || 'Não foi possível obter acesso à chamada.');
      }
      const { token, url } = payload;
      const room = new Room({ adaptiveStream: true, dynacast: true, publishDefaults: { audioPreset: { maxBitrate: 32000 }, dtx: true, red: true } });
      roomRef.current = room;
      room.on(RoomEvent.ConnectionStateChanged, state => setCallState(state === 'connected' ? 'active' : state === 'reconnecting' ? 'reconnecting' : state === 'disconnected' ? 'idle' : 'connecting'));
      room.on(RoomEvent.ActiveSpeakersChanged, activeSpeakers => setSpeakers(activeSpeakers.map(item => item.identity)));
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => { if (track.kind === Track.Kind.Audio) { const element = track.attach(); element.autoplay = true; element.setAttribute('playsinline', ''); document.body.appendChild(element); setRemoteAudio(items => [...items, element]); } });
      room.on(RoomEvent.Disconnected, () => { setCallState('idle'); roomRef.current = null; });
      await room.connect(url, token, { autoSubscribe: true });
      await room.localParticipant.setMicrophoneEnabled(true, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      setMuted(false); setCallState('active'); setCallMenu(false);
    } catch (e) { setCallState('idle'); setError(e.name === 'NotAllowedError' ? 'Permita o acesso ao microfone para entrar na chamada.' : e.message); }
  }

  async function toggleMute() {
    if (!roomRef.current) return;
    const next = !muted;
    try { await roomRef.current.localParticipant.setMicrophoneEnabled(!next); setMuted(next); }
    catch (e) { setError('Não foi possível alterar o microfone: ' + e.message); }
  }

  async function leaveCall() {
    remoteAudio.forEach(element => { element.pause(); element.remove(); }); setRemoteAudio([]);
    await roomRef.current?.disconnect(); roomRef.current = null; setCallState('idle'); setSpeakers([]); setCallTarget(null);
  }

  if (!authReady) return <div className="loading-screen"><div className="brand-mark">L</div><span>Preparando sua viagem…</span></div>;
  if (!firebaseConfigured) return <SetupScreen />;
  if (!user) return <AuthScreen mode={authMode} setMode={setAuthMode} credentials={credentials} setCredentials={setCredentials} submit={authenticate} error={error} />;
  if (familyAccess === 'checking') return <FamilyAccessLoading />;
  if (familyAccess !== 'unlocked') return <FamilyAccessScreen user={user} password={familyPassword} setPassword={setFamilyPassword} visible={showFamilyPassword} setVisible={setShowFamilyPassword} busy={familyAccessBusy} submit={enterFamilyAccess} error={familyAccessError} signOut={exitAccount} />;

  const currentUserLocation = locations.find(item => item.uid === user.uid);
  const otherLocations = locations.filter(item => item.uid !== user.uid);
  const callLabel = callState === 'connecting' ? 'Conectando…' : callState === 'reconnecting' ? 'Reconectando…' : callState === 'active' ? 'Chamada ativa' : '';

  return <main className="app-shell">
    <nav className="rail" aria-label="Navegação principal">
      <div className="rail-logo">L<span>F</span></div>
      <button className="rail-icon selected" title="Mapa" aria-label="Mapa" onClick={() => { setMenuOpen(false); window.dispatchEvent(new Event('map-recenter')); }}><MapPin size={19} /></button>
      <button className="rail-icon" title="Grupos" onClick={() => setActivePanel('groups')} aria-label="Grupos"><Users size={18} /></button>
      <button className="rail-icon" title="Conversas" onClick={() => { setMenuOpen(true); window.setTimeout(() => document.querySelector('.chat-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 280); }} aria-label="Conversas"><MessageCircle size={18} /></button>
      <div className="rail-spacer" />
      <button className="rail-icon" title="Privacidade" aria-label="Privacidade" onClick={() => setActivePanel('privacy')}><ShieldCheck size={18} /></button>
      <span className={`rail-icon wake-lock-indicator ${wakeLockStatus}`} role="status" aria-label={wakeLockStatus === 'active' ? 'Tela mantida ativa' : wakeLockStatus === 'unsupported' ? 'Este navegador não oferece bloqueio de tela' : wakeLockStatus === 'requesting' ? 'Solicitando tela ativa' : 'Bloqueio de tela indisponível'} title={wakeLockStatus === 'active' ? 'Tela mantida ativa enquanto o site estiver visível' : wakeLockStatus === 'unsupported' ? 'Bloqueio de tela não suportado neste navegador' : wakeLockStatus === 'requesting' ? 'Tentando manter a tela ativa' : 'O dispositivo liberou ou não permitiu o bloqueio de tela'}><Sun size={18} /></span>
      <button className="rail-icon" title="Sair" onClick={exitAccount} aria-label="Sair"><LogOut size={18} /></button>
      <div className="rail-avatar">{(user.displayName || user.email)[0].toUpperCase()}<i /></div>
    </nav>

    <button className={`sidebar-scrim ${menuOpen ? 'visible' : ''}`} aria-label="Fechar painel" onClick={() => setMenuOpen(false)} tabIndex={menuOpen ? 0 : -1} />
    <aside className={`sidebar ${menuOpen ? 'menu-open' : ''}`}>
      <header className="side-heading"><div><div className="eyebrow">ESPAÇO DA FAMÍLIA</div><h1>London<span>✦</span></h1><p>Uma viagem, todos juntos.</p></div><button className="mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? 'Fechar grupos' : 'Abrir grupos'} aria-expanded={menuOpen}><Menu size={19}/></button></header>
      <button type="button" className="trip-strip" onClick={() => setActivePanel('trip')}><div className="trip-date"><Plane size={16}/></div><div><b>Próxima viagem</b><span>Planejamento da família</span></div><div className="trip-dot" /></button>

      <section className="group-section"><div className="section-heading"><span>SEUS GRUPOS</span><button title="Ver todos os grupos" aria-label="Ver todos os grupos" onClick={() => setActivePanel('groups')}><ChevronDown size={15}/></button></div>
        {GROUPS.map(item => <button key={item.id} onClick={() => { setActive(item.id); setMenuOpen(false); }} className={`group-row ${active === item.id ? 'active' : ''}`}><span className="group-icon" style={{ '--group-color': item.color }}><item.icon size={16}/></span><span className="group-name">{item.name}</span>{item.id === active && <span className="active-pip"/>}</button>)}
      </section>

      <section className="vehicle-card"><div className="card-title"><span>NO MAPA</span><span className="live-label"><i/> AO VIVO</span></div>
        {[{ name: 'Carro 1', subtitle: 'Localização autorizada', color: '#64ddc0', car: locations.find(v => v.vehicle === 'carro-1') }, { name: 'Carro 2', subtitle: 'Localização autorizada', color: '#82a1ff', car: locations.find(v => v.vehicle === 'carro-2') }].map(vehicle => <div className="vehicle-row" key={vehicle.name}><span className="car-icon" style={{ color: vehicle.color }}><CarFront size={19}/></span><div className="vehicle-info"><b>{vehicle.name}</b><span>{vehicle.car ? `Atualizado ${timeLabel(vehicle.car.updatedAt)}` : vehicle.subtitle}</span></div><span className={`vehicle-status ${isFresh(vehicle.car?.updatedAt) ? 'online' : ''}`}>{isFresh(vehicle.car?.updatedAt) ? <><i/> Conectado</> : vehicle.car ? 'Último sinal' : 'Sem sinal'}</span></div>)}
        <div className="location-consent"><MapPin size={13}/><span>{currentUserLocation ? `Sua posição atualizada às ${timeLabel(currentUserLocation.updatedAt)}` : 'Localização compartilhada só com sua autorização.'}</span></div>
        <div className="location-options"><span>Compartilhar como</span><select value={vehicleRole} onChange={e => setVehicleRole(e.target.value)} aria-label="Tipo de localização"><option value="pessoa">Pessoa</option><option value="carro-1">Carro 1</option><option value="carro-2">Carro 2</option></select></div><button className={`location-button ${sharing ? 'sharing' : ''}`} onClick={toggleLocation}><Crosshair size={15}/>{sharing ? 'Parar de compartilhar' : 'Compartilhar minha posição'}</button>
      </section>

      <button type="button" className="journey-card" onClick={() => setActivePanel('trip')}><div className="section-heading"><span>ETAPA DA VIAGEM</span><span className="journey-badge"><Plane size={11}/> VOOS</span></div><div className="flight-route"><div className="airport"><span>ORIGEM</span><i>Detalhes a definir</i></div><div className="flight-line"><span>✈</span></div><div className="airport right"><span>LONDRES</span><i>Destino</i></div></div><div className="flight-foot"><span>Voo da família</span><span>Aguardando detalhes · ver</span></div></button>

      <section className="chat-card"><div className="section-heading"><span>CONVERSA · {group.name.toUpperCase()}</span><span className="message-count">{messages.length}</span></div><div className="chat-scroll">
        {messages.length === 0 ? <div className="chat-empty"><span className="empty-orbit"><MessageCircle size={17}/></span><b>A viagem começa por aqui</b><span>Envie uma mensagem para o grupo.</span></div> : messages.map(message => <article className={`message ${message.senderId === user.uid ? 'mine' : ''}`} key={message.id}><div className="message-meta"><b>{message.senderId === user.uid ? 'Você' : message.senderName || 'Família'}</b><span>{timeLabel(message.createdAt)}</span><button className="forward-button" title="Encaminhar para Chateiros" aria-label="Encaminhar para Chateiros" onClick={() => forwardMessage(message)}><Forward size={11}/></button></div>{message.forwarded && <span className="forwarded-tag">Encaminhada · {message.forwardedFrom}</span>}<p>{message.text}</p></article>)}<div ref={messageEndRef}/>
      </div><form className="message-form" onSubmit={sendMessage}><input value={text} onChange={e => setText(e.target.value)} placeholder="Escreva uma mensagem…" aria-label="Mensagem"/><button disabled={!text.trim() || sending} aria-label="Enviar mensagem"><Send size={16}/></button></form></section>

      <div className="sidebar-footer"><span><ShieldCheck size={13}/> Só a família vê estes dados</span><button onClick={exitAccount}>Sair</button></div>
    </aside>

      <section className="map-area"><div className="map-topbar"><div className="map-title"><span className="map-live"><i/></span><div><b>O mapa da nossa viagem</b><span>{locations.length} {locations.length === 1 ? 'pessoa compartilhando localização' : 'localizações compartilhadas'}</span></div></div><div className="map-top-actions"><div className="member-stack">{members.slice(0, 4).map((member, i) => <span key={member.id} title={member.displayName || 'Membro'} style={{ '--avatar-color': ['#eeb39c', '#b8a5ed', '#83cdb7', '#f0cb85'][i % 4] }}>{(member.displayName || '?')[0].toUpperCase()}</span>)}{members.length === 0 && <span className="stack-empty"><Users size={14}/></span>}</div><button className="map-action" aria-label="Notificações" onClick={() => setActivePanel('notifications')}><Bell size={17}/><i/></button><button className="map-action" aria-label="Ajuda" onClick={() => setActivePanel('help')}><CircleHelp size={17}/></button></div></div>
      <div className="map-wrap"><MapView locations={locations} currentUid={user.uid}/><div className="map-label"><span className="map-label-pin"><Compass size={16}/></span><div><b>Área de viagem</b><span>Londres e arredores</span></div><span className="label-chevron">⌄</span></div><div className="map-legend"><span><i className="legend-dot me"/> Você</span><span><i className="legend-dot car1"/> Carro 1</span><span><i className="legend-dot car2"/> Carro 2</span></div><div className="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></div><button className="recenter" onClick={() => window.dispatchEvent(new Event('map-recenter'))} title="Centralizar localizações" aria-label="Centralizar mapa"><Navigation size={18}/></button></div>
      <div className="map-bottom"><span className="secure-note"><ShieldCheck size={15}/> Localização apenas com consentimento</span><span className="map-signal"><SignalHigh size={15}/> Atualização ao vivo</span></div></section>

    {error && <div className="toast" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Fechar"><X size={16}/></button></div>}
    {callState !== 'idle' && <div className="call-dock" role="status"><span className={`call-wave ${callState}`}><Activity size={19}/></span><div className="call-info"><b>{callLabel}</b><span>{callTarget || group.name} · {speakers.length ? `${speakers.length} falando` : 'Conecte-se com a família'}</span></div><button className={`call-control ${muted ? 'is-muted' : ''}`} onClick={toggleMute} title={muted ? 'Ativar microfone' : 'Silenciar microfone'}>{muted ? <MicOff size={18}/> : <Mic size={18}/>}</button><button className="hangup" onClick={leaveCall} title="Sair da chamada"><Phone size={18}/></button></div>}
    <div className={`call-fab-wrap ${callState !== 'idle' ? 'in-call' : ''}`}>{callMenu && callState === 'idle' && <div className="call-menu"><b>Iniciar chamada de áudio</b><button onClick={() => { setCallTarget(null); startCall(); }}><Users size={15}/><span>Chamar grupo <small>{group.name}</small></span></button>{members.filter(member => member.id !== user.uid).map(member => <button key={member.id} onClick={() => { setCallTarget(member.displayName || 'Familiar'); startCall(member.id); }}><Phone size={14}/><span>{member.displayName || 'Familiar'} <small>Chamada individual</small></span></button>)}</div>}<span className="fab-hint">Ligue para o grupo</span><button className="call-fab" onClick={callState === 'idle' ? () => setCallMenu(!callMenu) : leaveCall} aria-label="Iniciar chamada de áudio"><Phone size={19} fill="currentColor"/></button></div>
    {activePanel && <div className="panel-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setActivePanel(null); }}><section className="info-panel" role="dialog" aria-modal="true" aria-labelledby="info-panel-title"><button className="info-panel-close" onClick={() => setActivePanel(null)} aria-label="Fechar painel"><X size={18}/></button>
      {activePanel === 'groups' && <><span className="eyebrow">ESPAÇO DA FAMÍLIA</span><h2 id="info-panel-title">Seus grupos</h2><p>Escolha uma conversa. Cada grupo tem mensagens e chamada próprias.</p><div className="panel-group-list">{GROUPS.map(item => <button key={item.id} onClick={() => { setActive(item.id); setActivePanel(null); }}><span className="group-icon" style={{ '--group-color': item.color }}><item.icon size={16}/></span><span><b>{item.name}</b><small>{item.text}</small></span><ArrowRight size={15}/></button>)}</div><div className="panel-note"><LockKeyhole size={15}/> A associação aos grupos é feita com segurança depois do login individual e da senha da família.</div></>}
      {activePanel === 'privacy' && <><span className="eyebrow">CONTROLES DA CONTA</span><h2 id="info-panel-title">Privacidade e localização</h2><p>Sua posição só é enviada enquanto você autoriza o compartilhamento. Você pode interromper quando quiser.</p><div className="panel-status"><span className={sharing ? 'status-dot on' : 'status-dot'}/><span>{sharing ? 'Compartilhamento ligado neste aparelho' : 'Sua posição não está sendo compartilhada por este aparelho'}</span></div><button className="panel-primary" onClick={() => { setActivePanel(null); toggleLocation(); }}>{sharing ? 'Parar de compartilhar' : 'Compartilhar minha posição'}</button><small className="panel-caption">A localização de outras pessoas só aparece com permissão e acesso ao grupo.</small></>}
      {activePanel === 'notifications' && <><span className="eyebrow">AVISOS</span><h2 id="info-panel-title">Notificações</h2><p>Notificações push ainda não foram configuradas neste projeto.</p><div className="panel-note"><Bell size={15}/> Para ativá-las é necessário configurar Firebase Cloud Messaging, a chave VAPID e o serviço de envio no backend.</div></>}
      {activePanel === 'help' && <><span className="eyebrow">GUIA RÁPIDO</span><h2 id="info-panel-title">Como usar</h2><ul className="panel-help-list"><li><b>Grupos:</b> escolha uma conversa no painel lateral.</li><li><b>Localização:</b> toque em “Compartilhar minha posição” para iniciar e novamente para parar.</li><li><b>Áudio:</b> use o botão de telefone e escolha chamada em grupo ou individual.</li><li><b>Mapa:</b> o botão de pin centraliza as posições reais disponíveis.</li></ul><div className="panel-note"><ShieldCheck size={15}/> Se aparecer falta de permissão, a conta precisa ser associada aos grupos no Firebase.</div></>}
      {activePanel === 'trip' && <><span className="eyebrow">PLANEJAMENTO</span><h2 id="info-panel-title">Etapa do voo</h2><p>Os dados do voo ainda não foram cadastrados. Nenhum horário ou número foi inventado.</p><div className="panel-note"><Plane size={15}/> Quando os detalhes forem definidos, o administrador poderá adicioná-los à viagem.</div></>}
    </section></div>}
  </main>;
}

function SetupScreen() {
  return <main className="setup-screen"><div className="setup-card"><div className="brand-mark">L</div><span className="eyebrow">LONDON FAMILY TRACKER</span><h1>Um espaço da família,<br/>pronto para Londres.</h1><p>A interface está preparada. Para ativar conversas, login, localização e chamadas reais, adicione os valores do aplicativo Web do Firebase ao arquivo <code>.env</code>.</p><div className="setup-list"><span><Check size={15}/> Site e mapa prontos</span><span><Check size={15}/> Credenciais não inventadas</span><span><Activity size={15}/> Chamadas aguardando o backend seguro</span></div><code className="setup-env">VITE_FIREBASE_API_KEY=…<br/>VITE_FIREBASE_PROJECT_ID=…<br/>VITE_FIREBASE_APP_ID=…</code><small>Você disse que enviará o config. Quando chegar, os campos serão preenchidos e os serviços poderão ser conectados.</small></div></main>;
}

function FamilyAccessLoading() {
  return <main className="family-access-loading"><div className="brand-mark">L</div><span>Verificando o acesso da família…</span></main>;
}

function FamilyAccessScreen({ user, password, setPassword, visible, setVisible, busy, submit, error, signOut: leave }) {
  return <main className="family-access-screen">
    <section className="family-access-art" aria-hidden="true">
      <div className="access-topline"><div className="brand-mark">L</div><span>LONDON FAMILY TRACKER</span></div>
      <div className="access-map-art"><span className="access-ring ring-a"/><span className="access-ring ring-b"/><span className="access-ring ring-c"/><svg className="access-route" viewBox="0 0 520 360" fill="none"><path d="M38 265 123 222l41 15 52-67 76 18 43-73 63 17 86-87" stroke="url(#routeGradient)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="7 9"/><defs><linearGradient id="routeGradient" x1="35" y1="265" x2="478" y2="44" gradientUnits="userSpaceOnUse"><stop stopColor="#65DCC0"/><stop offset="1" stopColor="#929CFF"/></linearGradient></defs></svg><span className="access-map-node node-a"><MapPin size={14}/></span><span className="access-map-node node-b"><CarFront size={14}/></span><span className="access-lock"><LockKeyhole size={27}/></span><span className="access-spark spark-a"/><span className="access-spark spark-b"/></div>
      <div className="access-art-copy"><span className="eyebrow">UM ESPAÇO PRIVADO</span><h2>Perto, mesmo<br/>a muitos quilômetros.</h2><p>Seu mapa, suas mensagens e suas chamadas, só para quem faz parte da viagem.</p><div className="access-art-foot"><ShieldCheck size={14}/> Protegido pela família</div></div>
    </section>
    <section className="family-access-panel"><button className="access-logout" onClick={leave}><LogOut size={14}/> Trocar conta</button><div className="family-access-form-wrap"><span className="access-form-icon"><KeyRound size={19}/></span><div className="eyebrow">MAIS UM PASSO</div><h1>A senha da família.</h1><p>Olá, {user.displayName || user.email}. Entre com a senha compartilhada da família para abrir a viagem.</p><form className="family-access-form" onSubmit={submit}><label htmlFor="family-private-password">Senha privada</label><div className="private-input"><input id="family-private-password" name="family-access-key" type={visible ? 'text' : 'password'} autoComplete="off" autoFocus value={password} onChange={event => setPassword(event.target.value)} placeholder="Digite a senha da família" required/><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}>{visible ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div>{error && <div className="family-access-error" role="alert">{error}</div>}<button className="family-access-submit" disabled={busy || !password}>{busy ? 'Verificando…' : 'Entrar'}{!busy && <ArrowRight size={17}/>}</button></form><div className="family-access-note"><LockKeyhole size={14}/><span>A senha é verificada com segurança e não fica salva neste aparelho.</span></div><div className="family-access-account"><span>Autenticado como <b>{user.email}</b></span><span className="individual-check"><Check size={12}/> Conta individual confirmada</span></div></div><div className="family-access-footer">LONDON FAMILY TRACKER <span>·</span> ESPAÇO PRIVADO DA FAMÍLIA</div></section>
  </main>;
}

function AuthScreen({ mode, setMode, credentials, setCredentials, submit, error }) {
  return <main className="auth-screen"><div className="auth-visual"><div className="auth-top"><div className="brand-mark">L</div><span>UMA VIAGEM. TODOS JUNTOS.</span></div><div className="auth-art"><span className="art-orbit one"/><span className="art-orbit two"/><span className="art-pin"><MapPin size={26}/></span><span className="art-point p1"/><span className="art-point p2"/><span className="art-point p3"/></div><div className="auth-caption"><span className="eyebrow">LONDON · FAMILY TRIP</span><h2>A cidade é grande.<br/><em>Vocês estão perto.</em></h2><p>Um lugar seguro para acompanhar, conversar e se encontrar.</p></div></div><section className="auth-panel"><div className="auth-form-wrap"><div className="eyebrow">LONDON FAMILY TRACKER</div><h1>{mode === 'login' ? 'Bom ter você de volta.' : 'Entre para a família.'}</h1><p className="auth-lede">{mode === 'login' ? 'A viagem fica melhor quando estamos juntos.' : 'Crie sua conta para acompanhar a viagem.'}</p><form onSubmit={submit} className="auth-form">{mode === 'signup' && <label>Como podemos chamar você?<input required autoComplete="name" value={credentials.name} onChange={e => setCredentials({ ...credentials, name: e.target.value })} placeholder="Seu nome"/></label>}<label>Seu e-mail<input required type="email" autoComplete="email" value={credentials.email} onChange={e => setCredentials({ ...credentials, email: e.target.value })} placeholder="voce@email.com"/></label><label>Senha<input required minLength={6} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={credentials.password} onChange={e => setCredentials({ ...credentials, password: e.target.value })} placeholder="Ao menos 6 caracteres"/></label>{error && <div className="auth-error">{error}</div>}<button className="auth-submit">{mode === 'login' ? 'Entrar na viagem' : 'Criar minha conta'}<LogIn size={17}/></button></form><div className="auth-switch">{mode === 'login' ? 'Ainda não tem uma conta?' : 'Já tem uma conta?'} <button onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Criar conta' : 'Fazer login'}</button></div><div className="auth-private"><ShieldCheck size={15}/> Suas conversas e localização são protegidas.</div></div><div className="auth-footer">LONDON FAMILY TRACKER <span>·</span> OUTUBRO 2026</div></section></main>;
}
