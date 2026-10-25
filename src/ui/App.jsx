import { useEffect, useMemo, useRef, useState } from 'react';
import { inMemoryPersistence, onAuthStateChanged, setPersistence, signInAnonymously, signOut, updateProfile } from 'firebase/auth';
import { addDoc, collection, doc, limit, onSnapshot, query, serverTimestamp, where, writeBatch } from 'firebase/firestore';
import { AudioPresets, ConnectionQuality, LocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client';
import { Activity, ArrowRight, Bell, CarFront, Check, ChevronDown, CircleHelp, Compass, Crosshair, Eye, EyeOff, Forward, LogIn, LogOut, LockKeyhole, MapPin, Menu, MessageCircle, Mic, MicOff, Music2, Navigation, Pause, Phone, PhoneOff, Plane, Play, Send, ShieldCheck, SignalHigh, Sun, Trash2, Users, Volume2, X } from 'lucide-react';
import { auth, db, firebaseConfigured } from '../firebase.js';
import MapView from './MapView.jsx';

const GROUPS = [
  { id: 'familia', name: 'Família', icon: Users, color: '#766cf3', text: 'Todos juntos, onde estiverem.' },
  { id: 'carro-1', name: 'Carro 1', icon: CarFront, color: '#61dec0', text: 'Suzuki Vitara · Equipe azul' },
  { id: 'carro-2', name: 'Carro 2', icon: CarFront, color: '#79a4ff', text: 'Carro 2 · Equipe verde' },
  { id: 'voo', name: 'Voo', icon: Plane, color: '#f5bd69', text: 'Acompanhamento do voo' },
  { id: 'chateiros', name: 'Chateiros', icon: MessageCircle, color: '#e08cb5', text: 'A central da família' },
];
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
const API_NOT_CONFIGURED = 'O servidor seguro ainda não está conectado. Configure a URL HTTPS do backend em VITE_API_BASE_URL e publique o site novamente.';
function backendUrl(path) {
  if (import.meta.env.PROD && !API_BASE_URL) throw new Error(API_NOT_CONFIGURED);
  return `${API_BASE_URL}${path}`;
}

function queueAccountDeletion(closeToken) {
  if (!closeToken) return;
  try {
    const url = backendUrl('/api/family/session/close');
    const body = JSON.stringify({ token: closeToken });
    if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
    void fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body, keepalive: true }).catch(() => {});
  } catch { /* The browser may be closing while the network is unavailable. */ }
}

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
  if (error?.code === 'permission-denied') return feature.includes('localização')
    ? 'O GPS encontrou sua posição, mas o Firestore recusou salvá-la. Saia e entre novamente com a senha da família para renovar a sessão; as regras ativas já foram conferidas.'
    : `O Firebase bloqueou ${feature}. Entre com a senha da família novamente após reiniciar o backend; se continuar, publique as regras de firestore.rules.`;
  if (error?.code === 'unavailable' || error?.code === 'deadline-exceeded') return 'Conexão com o Firebase instável. Verifique a internet e tente novamente.';
  return `Não foi possível carregar ${feature}. Tente novamente em instantes.`;
}

function MapFocusControl({ locations, currentUid, focusedUid, onFocus, onLocateAll }) {
  const [open, setOpen] = useState(false);
  const candidates = locations.filter(location => Number.isFinite(location.latitude) && Number.isFinite(location.longitude));
  const focused = candidates.find(location => location.uid === focusedUid);
  const labelFor = location => location.uid === currentUid ? `Você · ${location.displayName || 'este aparelho'}` : location.displayName || (location.vehicle ? location.vehicle.replace('-', ' ') : 'Familiar');

  return <div className="map-focus-control">
    <button type="button" className="map-focus-button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-haspopup="listbox">
      <Crosshair size={15}/><span>Focar em:</span><b>{focused ? labelFor(focused) : 'Escolher pessoa'}</b><ChevronDown size={13}/>
    </button>
    {open && <div className="map-focus-menu" role="listbox" aria-label="Pessoas com localização no mapa">
      <button type="button" role="option" aria-selected="false" className="focus-all-option" disabled={!candidates.length} onClick={() => { onLocateAll(); setOpen(false); }}>
        <span className="focus-avatar focus-all-avatar"><Users size={15}/></span>
        <span className="focus-person"><b>Localizar todos</b><small>{candidates.length ? `${candidates.length} ${candidates.length === 1 ? 'posição real disponível' : 'posições reais disponíveis'}` : 'Ninguém compartilhando agora'}</small></span>
        <Navigation size={15}/>
      </button>
      {candidates.map(location => <button type="button" role="option" aria-selected={focusedUid === location.uid} key={location.uid} onClick={() => { onFocus(location.uid); setOpen(false); }}>
        <span className={`focus-avatar ${location.vehicle || (location.uid === currentUid ? 'self' : '')}`}>{location.vehicle ? <CarFront size={14}/> : (location.displayName || '?').slice(0, 1).toUpperCase()}</span>
        <span className="focus-person"><b>{labelFor(location)}</b><small>{location.vehicle ? 'Localização do carro' : 'Localização compartilhada'}</small></span>
        {focusedUid === location.uid && <Check size={15}/>}
      </button>)}
    </div>}
  </div>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [familyAccess, setFamilyAccess] = useState('checking');
  const [familyAccessEndsAt, setFamilyAccessEndsAt] = useState(0);
  const [familyPassword, setFamilyPassword] = useState('');
  const [familyAccessBusy, setFamilyAccessBusy] = useState(false);
  const [active, setActive] = useState('familia');
  const [focusedUid, setFocusedUid] = useState('');
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [locationStatus, setLocationStatus] = useState('idle');
  const [locationPermission, setLocationPermission] = useState('unknown');
  const [callState, setCallState] = useState('idle');
  const [callMenu, setCallMenu] = useState(false);
  const [callTarget, setCallTarget] = useState(null);
  const [muted, setMuted] = useState(false);
  const [callQuality, setCallQuality] = useState(ConnectionQuality.Unknown);
  const [callParticipants, setCallParticipants] = useState(1);
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [sharedMusic, setSharedMusic] = useState(null);
  const [musicVolume, setMusicVolume] = useState(0.72);
  const [vehicleRole, setVehicleRole] = useState('pessoa');
  const [speakers, setSpeakers] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [credentials, setCredentials] = useState({ name: '' });
  const [authPasswordVisible, setAuthPasswordVisible] = useState(false);
  const [familyName, setFamilyName] = useState('');
  const [wakeLockStatus, setWakeLockStatus] = useState('requesting');
  const [activePanel, setActivePanel] = useState(null);
  const roomRef = useRef(null);
  const musicFileInputRef = useRef(null);
  const remoteAudioElementsRef = useRef(new Map());
  const sharedMusicRef = useRef(null);
  const musicElementRef = useRef(null);
  const musicContextRef = useRef(null);
  const musicGainRef = useRef(null);
  const musicTrackRef = useRef(null);
  const musicUrlRef = useRef('');
  const musicVolumeTimerRef = useRef(null);
  const watchRef = useRef(null);
  const locationRequestRef = useRef(0);
  const locationWriteRef = useRef(false);
  const lastLocationWriteRef = useRef(0);
  const closeTokenRef = useRef('');
  const messageEndRef = useRef(null);
  const group = useMemo(() => GROUPS.find(item => item.id === active) || GROUPS[0], [active]);

  function setMusicState(value) {
    sharedMusicRef.current = value;
    setSharedMusic(value);
    if (Number.isFinite(value?.volume)) setMusicVolume(value.volume);
  }

  async function publishMusicPacket(packet) {
    const room = roomRef.current;
    if (!room || room.state !== 'connected') throw new Error('Entre numa chamada para compartilhar música com a família.');
    await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(packet)), { reliable: true, topic: 'lft-family-music' });
  }

  async function broadcastMusicState(value = sharedMusicRef.current) {
    if (!value) return;
    await publishMusicPacket({ type: 'state', ...value });
  }

  function disposeLocalMusic() {
    if (musicVolumeTimerRef.current) window.clearTimeout(musicVolumeTimerRef.current);
    musicVolumeTimerRef.current = null;
    musicElementRef.current?.pause();
    if (musicElementRef.current) {
      musicElementRef.current.removeAttribute('src');
      musicElementRef.current.load();
    }
    musicElementRef.current = null;
    musicGainRef.current = null;
    musicTrackRef.current?.stop();
    musicTrackRef.current = null;
    const context = musicContextRef.current;
    musicContextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    if (musicUrlRef.current) URL.revokeObjectURL(musicUrlRef.current);
    musicUrlRef.current = '';
  }

  async function stopSharedMusic(broadcast = true) {
    const current = sharedMusicRef.current;
    const room = roomRef.current;
    if (broadcast && current && room?.state === 'connected') {
      await publishMusicPacket({ type: 'state', action: 'ended', ownerUid: current.ownerUid, title: current.title }).catch(() => {});
    }
    const track = musicTrackRef.current;
    if (track && room?.state === 'connected') await room.localParticipant.unpublishTrack(track).catch(() => {});
    disposeLocalMusic();
    setMusicState(null);
  }

  async function applyMusicControl(action, value) {
    const audio = musicElementRef.current;
    const current = sharedMusicRef.current;
    if (!audio || !current || current.ownerUid !== user?.uid) return;
    try {
      if (action === 'play') {
        await musicContextRef.current?.resume();
        await audio.play();
      } else if (action === 'pause') audio.pause();
      else if (action === 'volume') {
        const nextVolume = Math.max(0, Math.min(1, Number(value)));
        if (!Number.isFinite(nextVolume)) return;
        if (musicGainRef.current && musicContextRef.current) musicGainRef.current.gain.setTargetAtTime(nextVolume, musicContextRef.current.currentTime, 0.025);
      } else if (action === 'stop') {
        await stopSharedMusic(true);
        return;
      } else return;

      const next = { ...current, playing: !audio.paused, volume: musicGainRef.current?.gain.value ?? current.volume };
      setMusicState(next);
      await broadcastMusicState(next);
    } catch {
      setError('Não foi possível controlar a música agora. Confira a chamada e tente novamente.');
    }
  }

  function requestMusicControl(action, value) {
    const current = sharedMusicRef.current;
    if (!current) return;
    if (current.ownerUid === user?.uid) {
      if (action === 'volume') {
        setMusicVolume(value);
        if (musicVolumeTimerRef.current) window.clearTimeout(musicVolumeTimerRef.current);
        musicVolumeTimerRef.current = window.setTimeout(() => void applyMusicControl('volume', value), 120);
      } else void applyMusicControl(action, value);
      return;
    }
    if (action === 'volume') setMusicVolume(value);
    void publishMusicPacket({ type: 'control', action, value }).catch(() => setError('A chamada perdeu a conexão. Tente controlar a música de novo.'));
  }

  async function startSharedMusic(file) {
    const room = roomRef.current;
    if (!file || !room || callState !== 'active') {
      setError('Entre numa chamada ativa em grupo antes de compartilhar um MP3.');
      return;
    }
    if (!/\.mp3$/i.test(file.name) && file.type !== 'audio/mpeg') {
      setError('Escolha um arquivo MP3.');
      return;
    }
    if (sharedMusicRef.current) {
      setError('Já tem uma música compartilhada. Toque em encerrar antes de escolher outra.');
      return;
    }
    if (!window.AudioContext && !window.webkitAudioContext) {
      setError('Este navegador não permite transmitir um MP3 pela chamada. Tente a versão mais recente do Safari ou Chrome.');
      return;
    }

    let context;
    let audio;
    let track;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      context = new AudioContextClass({ latencyHint: 'interactive' });
      audio = new Audio();
      const objectUrl = URL.createObjectURL(file);
      audio.src = objectUrl;
      audio.preload = 'auto';
      audio.loop = false;
      const source = context.createMediaElementSource(audio);
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = musicVolume;
      source.connect(gain);
      gain.connect(destination);
      // Let the person sharing the file hear it too; WebRTC echo cancellation
      // remains enabled on the separate microphone track.
      gain.connect(context.destination);
      musicUrlRef.current = objectUrl;
      musicElementRef.current = audio;
      musicContextRef.current = context;
      musicGainRef.current = gain;

      const resumePromise = context.resume();
      const playPromise = audio.play();
      await Promise.all([resumePromise, playPromise]);
      if (roomRef.current !== room || room.state !== 'connected') throw new Error('A chamada se desconectou.');

      track = new LocalAudioTrack(destination.stream.getAudioTracks()[0], {}, true);
      track.source = Track.Source.Microphone;
      musicTrackRef.current = track;
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
        name: 'family-shared-music',
        audioPreset: AudioPresets.music,
        dtx: false,
        red: true,
        forceStereo: true,
      });
      if (roomRef.current !== room) throw new Error('A chamada se desconectou.');

      const state = { title: file.name.replace(/\.mp3$/i, '').slice(0, 100) || 'Música da família', ownerUid: user.uid, ownerName: familyName || user.displayName || 'Família', playing: true, volume: musicVolume };
      setMusicState(state);
      await broadcastMusicState(state);
      audio.addEventListener('ended', () => { if (musicTrackRef.current === track) void stopSharedMusic(true); }, { once: true });
    } catch (e) {
      if (track && roomRef.current === room && room.state === 'connected') await room.localParticipant.unpublishTrack(track).catch(() => {});
      disposeLocalMusic();
      setMusicState(null);
      setError(e.name === 'NotAllowedError' ? 'O navegador bloqueou o áudio. Toque no botão de música e permita a reprodução.' : e.message || 'Não foi possível compartilhar esse MP3. Confira a chamada e tente de novo.');
    }
  }

  function detachRemoteAudio(track) {
    const element = remoteAudioElementsRef.current.get(track);
    if (!element) return;
    track.detach(element);
    element.pause();
    element.srcObject = null;
    element.remove();
    remoteAudioElementsRef.current.delete(track);
  }

  function clearRemoteAudio(updateUi = true) {
    remoteAudioElementsRef.current.forEach((element, track) => {
      track.detach(element);
      element.pause();
      element.srcObject = null;
      element.remove();
    });
    remoteAudioElementsRef.current.clear();
    if (updateUi) setAudioPlaybackBlocked(false);
  }

  async function unlockCallAudio() {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.startAudio();
      const elements = [...remoteAudioElementsRef.current.values()];
      await Promise.all(elements.map(element => element.play()));
      setAudioPlaybackBlocked(false);
    } catch {
      setAudioPlaybackBlocked(true);
      setError('Toque em “Ativar áudio” novamente ou confira o modo silencioso e a saída de som do iPhone.');
    }
  }

  useEffect(() => {
    if (focusedUid && !locations.some(location => location.uid === focusedUid)) setFocusedUid('');
  }, [locations, focusedUid]);

  useEffect(() => {
    if (!firebaseConfigured) { setAuthReady(true); return; }
    let unsubscribe;
    let cancelled = false;
    // This app uses a shared family password, not persistent personal accounts.
    // Keep Firebase's anonymous identity only in memory so a reload asks again.
    setPersistence(auth, inMemoryPersistence)
      .then(() => signOut(auth))
      .then(() => {
        if (cancelled) return;
        unsubscribe = onAuthStateChanged(auth, current => { setUser(current); setAuthReady(true); });
      })
      .catch(() => { if (!cancelled) setAuthReady(true); });
    return () => { cancelled = true; unsubscribe?.(); };
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
    // Some mobile browsers require a user gesture before granting a screen
    // wake lock. Retry on the first interaction, and expose an explicit retry
    // button in the navigation rail for iPhone users.
    const onUserGesture = () => acquireWakeLock();
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('pointerdown', onUserGesture, { capture: true, passive: true });
    document.addEventListener('keydown', onUserGesture, { capture: true });
    window.addEventListener('lft:request-screen-wake-lock', onUserGesture);
    acquireWakeLock();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('pointerdown', onUserGesture, { capture: true });
      document.removeEventListener('keydown', onUserGesture, { capture: true });
      window.removeEventListener('lft:request-screen-wake-lock', onUserGesture);
      const lock = sentinel;
      sentinel = null;
      if (lock && !lock.released) lock.release().catch(() => {});
    };
  }, []);

  useEffect(() => {
    let permissionStatus;
    let disposed = false;
    const updatePermission = () => { if (!disposed && permissionStatus) setLocationPermission(permissionStatus.state); };
    navigator.permissions?.query?.({ name: 'geolocation' })?.then(status => {
        if (disposed) return;
        permissionStatus = status;
        updatePermission();
        status.addEventListener?.('change', updatePermission);
      })?.catch(() => {}); // Safari may not expose the Permissions API; geolocation still works.
    return () => {
      disposed = true;
      permissionStatus?.removeEventListener?.('change', updatePermission);
    };
  }, []);

  useEffect(() => { if (!user) { setFamilyAccess('locked'); setFamilyName(''); } }, [user]);

  useEffect(() => {
    if (familyAccess !== 'unlocked' || !familyAccessEndsAt) return;
    const remaining = familyAccessEndsAt - Date.now();
    if (remaining <= 0) { void exitAccount(); return; }
    const timeout = window.setTimeout(() => { void exitAccount(); }, remaining);
    return () => window.clearTimeout(timeout);
  }, [familyAccess, familyAccessEndsAt, user]);

  useEffect(() => {
    if (familyAccess === 'unlocked') return;
    // Invalidate a pending one-shot GPS request when the family session ends.
    locationRequestRef.current += 1;
    if (watchRef.current !== null) navigator.geolocation?.clearWatch(watchRef.current);
    watchRef.current = null; setSharing(false); setLocationStatus('idle');
    if (roomRef.current) { const room = roomRef.current; roomRef.current = null; room.disconnect(); clearRemoteAudio(); disposeLocalMusic(); setMusicState(null); setCallState('idle'); setSpeakers([]); setCallParticipants(0); }
  }, [familyAccess]);

  useEffect(() => {
    if (!user || !['name-required', 'unlocked'].includes(familyAccess)) return;
    let closedPageRestored = false;
    const closeOnPageHide = () => {
      closedPageRestored = true;
      const token = closeTokenRef.current;
      queueAccountDeletion(token);
    };
    const reopenFromBackForwardCache = event => {
      if (event.persisted && closedPageRestored) window.location.reload();
    };
    window.addEventListener('pagehide', closeOnPageHide);
    window.addEventListener('pageshow', reopenFromBackForwardCache);
    return () => {
      window.removeEventListener('pagehide', closeOnPageHide);
      window.removeEventListener('pageshow', reopenFromBackForwardCache);
    };
  }, [user, familyAccess]);

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
  useEffect(() => () => {
    locationRequestRef.current += 1;
    if (watchRef.current !== null) navigator.geolocation?.clearWatch(watchRef.current);
    roomRef.current?.disconnect();
    roomRef.current = null;
    clearRemoteAudio(false);
    disposeLocalMusic();
  }, []);

  async function authenticate(event) {
    event.preventDefault(); setError('');
    if (!familyPassword) { setError('Digite a senha da família.'); return; }
    let anonymousUser = null;
    setFamilyAccessBusy(true);
    try {
      setFamilyAccess('checking');
      const result = await signInAnonymously(auth);
      anonymousUser = result.user;
      const idToken = await anonymousUser.getIdToken();
      const response = await fetch(backendUrl('/api/family/access'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ password: familyPassword }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (payload.code === 'FAMILY_PASSWORD_INCORRECT') throw new Error('Senha da família incorreta. Confira e tente de novo.');
        if (response.status === 429) throw new Error('Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.');
        if (response.status === 503) throw new Error(`O servidor precisa de configuração: ${(payload.missing || []).join(', ')}.`);
        throw new Error(payload.error || 'Não foi possível liberar o acesso agora.');
      }
      closeTokenRef.current = payload.closeToken || '';
      setFamilyPassword('');
      setCredentials({ name: '' });
      setFamilyAccessEndsAt(payload.expiresAt || Date.now() + 8 * 60 * 60 * 1000);
      setFamilyAccess('name-required');
    } catch (e) {
      if (anonymousUser) await signOut(auth).catch(() => {});
      setFamilyPassword('');
      setFamilyAccess('locked');
      if (e.code === 'auth/operation-not-allowed') setError('Ative “Anônimo” em Firebase Authentication → Provedores de acesso.');
      else if (e.message?.includes('Failed to fetch') || e instanceof TypeError) setError(API_NOT_CONFIGURED);
      else setError(e.message || 'Não foi possível liberar o acesso agora.');
    } finally { setFamilyAccessBusy(false); }
  }

  async function saveFamilyName(event) {
    event.preventDefault(); setError('');
    const name = credentials.name.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!user || !name || familyAccessBusy) return;
    setFamilyAccessBusy(true);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch(backendUrl('/api/family/profile'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ displayName: name }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Não foi possível salvar seu nome agora.');
      closeTokenRef.current = payload.closeToken || '';
      await updateProfile(user, { displayName: name });
      setFamilyName(name);
      setFamilyAccess('unlocked');
    } catch (e) { setError(e.message || 'Não foi possível salvar seu nome agora.'); }
    finally { setFamilyAccessBusy(false); }
  }

  async function exitAccount() {
    let deleted = false;
    try {
      if (user) {
        const idToken = await user.getIdToken();
        const response = await fetch(backendUrl('/api/family/session/end'), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: '{}' });
        deleted = response.ok;
      }
    } catch { /* A local sign-out still proceeds when the API is unreachable. */ }
    if (!deleted) queueAccountDeletion(closeTokenRef.current);
    closeTokenRef.current = '';
    setFamilyAccess('locked');
    await signOut(auth);
  }

  async function sendMessage(event) {
    event.preventDefault(); const body = text.trim();
    if (!body || !user || sending) return;
    setSending(true); setError('');
    try {
      await addDoc(collection(db, 'messages'), { groupId: active, text: body, senderId: user.uid, senderName: familyName || user.displayName || 'Família', createdAt: serverTimestamp() });
      setText('');
    } catch (e) { setError(e?.code === 'permission-denied' ? firestoreMessage(e, 'enviar mensagens neste grupo') : e.message); }
    finally { setSending(false); }
  }

  async function forwardMessage(message) {
    if (!user || !message.text) return;
    try {
      await addDoc(collection(db, 'messages'), { groupId: 'chateiros', text: message.text, senderId: user.uid, senderName: familyName || user.displayName || 'Família', createdAt: serverTimestamp(), forwarded: true, forwardedFrom: group.name });
      setActive('chateiros');
      setError('Mensagem encaminhada para Chateiros.');
    } catch (e) { setError(e?.code === 'permission-denied' ? firestoreMessage(e, 'encaminhar mensagens') : e.message); }
  }

  async function toggleLocation() {
    if (!navigator.geolocation) { setError('Este dispositivo não oferece geolocalização.'); return; }
    if (sharing) {
      locationRequestRef.current += 1;
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null; setSharing(false); setLocationStatus('idle'); return;
    }
    if (!user) return;
    setError('');
    if (!window.isSecureContext) { setError('A localização exige uma conexão segura (HTTPS). Abra o endereço publicado do site.'); return; }
    const requestId = ++locationRequestRef.current;
    const options = { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 };
    const stopLocationAfterError = e => {
      if (requestId !== locationRequestRef.current) return;
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      const message = e.code === 1
        ? 'O iPhone/Safari bloqueou o GPS. Abra o site no Safari e permita Localização em Ajustes do Site (aA). Confira também Ajustes → Privacidade e Segurança → Serviços de Localização.'
        : e.code === 2
          ? 'O GPS não conseguiu uma posição. Ative Serviços de Localização e Localização Precisa para o Safari; tente novamente perto de uma janela ou ao ar livre.'
          : 'A busca do GPS demorou demais. Confira o sinal, deixe o site aberto e toque para tentar novamente.';
      if (e.code === 1) setLocationPermission('denied');
      setError(message); setSharing(false); setLocationStatus(e.code === 1 ? 'denied' : 'idle');
    };
    const saveLocation = async position => {
      if (requestId !== locationRequestRef.current || locationWriteRef.current) return false;
      // iOS may report several quick fixes. Avoid overlapping writes and
      // keep mobile data usage low while retaining a live position.
      if (Date.now() - lastLocationWriteRef.current < 4000) return true;
      locationWriteRef.current = true;
      const { latitude, longitude, accuracy, speed } = position.coords;
      try {
        const location = { uid: user.uid, displayName: familyName || user.displayName || 'Família', latitude, longitude, accuracy, speed, ...(vehicleRole !== 'pessoa' ? { vehicle: vehicleRole } : {}), updatedAt: serverTimestamp(), online: true };
        const batch = writeBatch(db);
        GROUPS.forEach(item => batch.set(doc(db, 'groups', item.id, 'locations', user.uid), location, { merge: true }));
        await batch.commit();
        if (requestId !== locationRequestRef.current) return false;
        lastLocationWriteRef.current = Date.now();
        setLocationPermission('granted'); setLocationStatus('sharing');
        return true;
      } catch (e) {
        if (requestId === locationRequestRef.current) {
          setError(e?.code === 'permission-denied' ? firestoreMessage(e, 'compartilhar localização neste grupo') : 'O GPS encontrou sua posição, mas não foi possível salvá-la no Firebase. Confira a internet e tente novamente.');
          if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
          watchRef.current = null; setSharing(false); setLocationStatus('idle');
        }
        return false;
      } finally { locationWriteRef.current = false; }
    };
    try {
      setLocationStatus('locating');
      setSharing(true);
      // A one-shot request makes iOS show its permission prompt immediately.
      // Start continuous updates only after the first real fix was saved.
      navigator.geolocation.getCurrentPosition(async position => {
        if (requestId !== locationRequestRef.current) return;
        const saved = await saveLocation(position);
        if (!saved || requestId !== locationRequestRef.current) return;
        watchRef.current = navigator.geolocation.watchPosition(saveLocation, stopLocationAfterError, { ...options, timeout: 45000 });
      }, stopLocationAfterError, options);
    } catch {
      locationRequestRef.current += 1;
      setSharing(false); setLocationStatus('idle'); setError('Não foi possível iniciar o GPS. Abra o site no Safari, confira a permissão de localização e tente novamente.');
    }
  }

  async function startCall(recipientUid = null) {
    if (callState !== 'idle' || !user) return;
    setCallTarget(recipientUid ? members.find(member => member.id === recipientUid)?.displayName || 'Familiar' : null);
    setError(''); setCallState('connecting');
    let room = null;
    try {
      const audioCaptureDefaults = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: false };
      room = new Room({
        publishDefaults: { audioPreset: { maxBitrate: 64000 }, dtx: true, red: true },
        audioCaptureDefaults,
      });
      roomRef.current = room;
      setAudioPlaybackBlocked(false); setCallQuality(ConnectionQuality.Unknown); setCallParticipants(1);

      // Unlock mobile-browser audio during the original tap, before network awaits.
      void room.startAudio().then(() => {
        if (roomRef.current === room) setAudioPlaybackBlocked(!room.canPlaybackAudio);
      }).catch(() => { if (roomRef.current === room) setAudioPlaybackBlocked(true); });

      room.on(RoomEvent.ConnectionStateChanged, state => {
        if (roomRef.current !== room) return;
        setCallState(state === 'connected' ? 'active' : state === 'reconnecting' ? 'reconnecting' : state === 'disconnected' ? 'idle' : 'connecting');
      });
      room.on(RoomEvent.Reconnecting, () => { if (roomRef.current === room) setCallState('reconnecting'); });
      room.on(RoomEvent.Reconnected, () => {
        if (roomRef.current !== room) return;
        setCallState('active'); setCallParticipants(room.remoteParticipants.size + 1); setMuted(!room.localParticipant.isMicrophoneEnabled);
        setAudioPlaybackBlocked(!room.canPlaybackAudio);
      });
      room.on(RoomEvent.ActiveSpeakersChanged, activeSpeakers => setSpeakers(activeSpeakers.map(item => item.identity)));
      room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        const qualities = [quality, room.localParticipant.connectionQuality, ...Array.from(room.remoteParticipants.values()).map(item => item.connectionQuality)]
          .filter(item => item && item !== ConnectionQuality.Unknown);
        const priority = { [ConnectionQuality.Excellent]: 0, [ConnectionQuality.Good]: 1, [ConnectionQuality.Poor]: 2, [ConnectionQuality.Lost]: 3 };
        const overall = qualities.reduce((worst, item) => (priority[item] ?? 0) > (priority[worst] ?? 0) ? item : worst, ConnectionQuality.Excellent);
        setCallQuality(qualities.length ? overall : participant.connectionQuality || ConnectionQuality.Unknown);
      });
      room.on(RoomEvent.ParticipantConnected, () => {
        setCallParticipants(room.remoteParticipants.size + 1);
        if (sharedMusicRef.current?.ownerUid === user.uid) void broadcastMusicState().catch(() => {});
      });
      room.on(RoomEvent.ParticipantDisconnected, participant => {
        setCallParticipants(Math.max(1, room.remoteParticipants.size + 1));
        if (participant.identity === sharedMusicRef.current?.ownerUid && participant.identity !== user.uid) setMusicState(null);
      });
      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic !== 'lft-family-music' || !participant) return;
        try {
          const packet = JSON.parse(new TextDecoder().decode(payload));
          if (packet.type === 'state' && participant.identity === packet.ownerUid) {
            if (packet.action === 'ended') setMusicState(null);
            else setMusicState({ title: String(packet.title || 'Música compartilhada').slice(0, 100), ownerUid: packet.ownerUid, ownerName: String(packet.ownerName || participant.name || 'Família').slice(0, 80), playing: packet.playing === true, volume: Math.max(0, Math.min(1, Number(packet.volume) || 0)) });
          } else if (packet.type === 'control' && sharedMusicRef.current?.ownerUid === user.uid && ['play', 'pause', 'volume', 'stop'].includes(packet.action)) {
            void applyMusicControl(packet.action, packet.value);
          }
        } catch { /* Ignore malformed control packets; no file data is sent here. */ }
      });
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind !== Track.Kind.Audio || roomRef.current !== room) return;
        detachRemoteAudio(track);
        if (publication.trackName === 'family-shared-music') {
          setMusicState(sharedMusicRef.current || { title: 'Música compartilhada', ownerUid: participant.identity, ownerName: participant.name || 'Família', playing: true, volume: musicVolume });
        }
        const element = track.attach();
        element.autoplay = true; element.controls = false; element.muted = false;
        element.setAttribute('playsinline', ''); element.setAttribute('webkit-playsinline', 'true'); element.setAttribute('aria-hidden', 'true');
        Object.assign(element.style, { position: 'fixed', width: '1px', height: '1px', left: '-2px', bottom: '-2px', opacity: '0', pointerEvents: 'none' });
        document.body.appendChild(element);
        remoteAudioElementsRef.current.set(track, element);
        void element.play().then(() => {
          if (roomRef.current === room) setAudioPlaybackBlocked(false);
        }).catch(() => {
          if (roomRef.current === room) setAudioPlaybackBlocked(true);
        });
      });
      room.on(RoomEvent.TrackUnsubscribed, track => detachRemoteAudio(track));
      room.on(RoomEvent.TrackSubscriptionFailed, () => {
        if (roomRef.current === room) setError('O áudio de um familiar oscilou. O LiveKit está tentando recuperar a faixa; se não voltar, saia e entre na chamada novamente.');
      });
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return;
        roomRef.current = null; clearRemoteAudio(); disposeLocalMusic(); setMusicState(null); setCallState('idle'); setSpeakers([]); setCallParticipants(0); setCallQuality(ConnectionQuality.Unknown); setCallTarget(null);
      });

      const idToken = await user.getIdToken();
      const response = await fetch(backendUrl('/api/livekit/token'), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ groupId: active, ...(recipientUid ? { recipientUid } : {}) }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 503) throw new Error(`Configure no backend: ${(payload.missing || []).join(', ') || 'serviço indisponível'}.`);
        if (response.status === 403) throw new Error('Sua conta ainda não foi liberada para este grupo. Entre novamente com a senha da família para preparar seus grupos.');
        throw new Error(payload.error || 'Não foi possível obter acesso à chamada.');
      }
      const { token, url } = payload;
      if (roomRef.current !== room) return;
      await room.connect(url, token, { autoSubscribe: true });
      if (roomRef.current !== room) return;
      try { await room.startAudio(); setAudioPlaybackBlocked(!room.canPlaybackAudio); }
      catch { setAudioPlaybackBlocked(true); }
      await room.localParticipant.setMicrophoneEnabled(true, audioCaptureDefaults);
      if (roomRef.current !== room) return;
      setMuted(false); setCallState('active'); setCallParticipants(room.remoteParticipants.size + 1); setCallMenu(false);
    } catch (e) {
      if (roomRef.current === room) roomRef.current = null;
      room?.disconnect(); clearRemoteAudio(); disposeLocalMusic(); setMusicState(null); setCallState('idle'); setSpeakers([]); setCallParticipants(0); setCallQuality(ConnectionQuality.Unknown); setCallTarget(null);
      setError(e.name === 'NotAllowedError' ? 'Permita o acesso ao microfone para entrar na chamada.' : e.message || 'A chamada não conseguiu conectar. Confira o sinal e tente novamente.');
    }
  }

  async function toggleMute() {
    if (!roomRef.current) return;
    const next = !muted;
    try { await roomRef.current.localParticipant.setMicrophoneEnabled(!next); setMuted(next); }
    catch (e) { setError('Não foi possível alterar o microfone: ' + e.message); }
  }

  async function leaveCall() {
    const room = roomRef.current;
    await stopSharedMusic(true);
    roomRef.current = null;
    room?.disconnect(); clearRemoteAudio();
    setCallState('idle'); setSpeakers([]); setCallParticipants(0); setCallQuality(ConnectionQuality.Unknown); setCallTarget(null); setMuted(false);
  }

  if (!authReady) return <div className="loading-screen"><div className="brand-mark">L</div><span>Preparando sua viagem…</span></div>;
  if (!firebaseConfigured) return <SetupScreen />;
  if (!user) return <AuthScreen password={familyPassword} setPassword={setFamilyPassword} passwordVisible={authPasswordVisible} setPasswordVisible={setAuthPasswordVisible} busy={familyAccessBusy} submit={authenticate} error={error} />;
  if (familyAccess === 'checking') return <FamilyAccessLoading />;
  if (familyAccess === 'name-required') return <FamilyNameScreen name={credentials.name} setName={name => setCredentials({ name })} busy={familyAccessBusy} submit={saveFamilyName} error={error} />;
  if (familyAccess !== 'unlocked') return <FamilyAccessLoading />;

  const currentUserLocation = locations.find(item => item.uid === user.uid);
  const otherLocations = locations.filter(item => item.uid !== user.uid);
  const callLabel = callState === 'connecting' ? 'Conectando…' : callState === 'reconnecting' ? 'Reconectando…' : callState === 'active' ? 'Chamada ativa' : '';
  const callQualityLabel = callQuality === ConnectionQuality.Excellent ? 'Sinal ótimo' : callQuality === ConnectionQuality.Good ? 'Sinal bom' : callQuality === ConnectionQuality.Poor ? 'Sinal fraco' : callQuality === ConnectionQuality.Lost ? 'Sem sinal' : 'Medindo sinal';

  function chooseMusicFile(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void startSharedMusic(file);
  }

  function requestMusicVolume(event) {
    const next = Number(event.currentTarget.value);
    setMusicVolume(next);
    requestMusicControl('volume', next);
  }

  return <main className="app-shell">
    <nav className="rail" aria-label="Navegação principal">
      <div className="rail-logo">L<span>F</span></div>
      <button className="rail-icon selected" title="Mapa" aria-label="Mapa" onClick={() => { setMenuOpen(false); window.dispatchEvent(new Event('map-recenter')); }}><MapPin size={19} /></button>
      <button className="rail-icon" title="Grupos e controles" onClick={() => window.matchMedia('(max-width: 760px)').matches ? setMenuOpen(true) : setActivePanel('groups')} aria-label="Abrir grupos, conversas e localização"><Users size={18} /></button>
      <button className="rail-icon" title="Conversas" onClick={() => { setMenuOpen(true); window.setTimeout(() => document.querySelector('.chat-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 280); }} aria-label="Conversas"><MessageCircle size={18} /></button>
      <button type="button" className={`rail-icon mobile-location-action ${sharing ? 'selected' : ''}`} title={sharing ? 'Parar compartilhamento de localização' : 'Compartilhar localização'} aria-label={sharing ? 'Parar compartilhamento de localização' : 'Compartilhar localização'} onClick={() => { toggleLocation(); setMenuOpen(true); window.setTimeout(() => document.querySelector('.vehicle-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 280); }}><Crosshair size={18} /><span className="mobile-nav-label">{sharing ? 'Parar' : 'GPS'}</span></button>
      <div className="rail-spacer" />
      <button className="rail-icon" title="Privacidade" aria-label="Privacidade" onClick={() => setActivePanel('privacy')}><ShieldCheck size={18} /></button>
      <button type="button" className={`rail-icon wake-lock-indicator ${wakeLockStatus}`} onClick={() => window.dispatchEvent(new Event('lft:request-screen-wake-lock'))} aria-label={wakeLockStatus === 'active' ? 'Tela mantida ativa. Toque para tentar novamente' : wakeLockStatus === 'unsupported' ? 'Este navegador não oferece bloqueio de tela' : 'Toque para tentar manter a tela ativa'} title={wakeLockStatus === 'active' ? 'Tela mantida ativa enquanto o site estiver visível' : wakeLockStatus === 'unsupported' ? 'Bloqueio de tela não suportado neste navegador' : wakeLockStatus === 'requesting' ? 'Tentando manter a tela ativa' : 'Toque para tentar manter a tela ativa'}><Sun size={18} /></button>
      <button className="rail-icon" title="Sair" onClick={exitAccount} aria-label="Sair"><LogOut size={18} /></button>
      <div className="rail-avatar">{(familyName || user.displayName || 'F')[0].toUpperCase()}<i /></div>
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
        <div className={`location-consent ${locationStatus}`}><MapPin size={13}/><span>{locationStatus === 'locating' ? 'Buscando sinal do GPS… mantenha o site aberto.' : locationPermission === 'denied' ? 'Permissão bloqueada no iPhone. Toque no botão de localização para ver como liberar.' : currentUserLocation ? `Sua posição atualizada às ${timeLabel(currentUserLocation.updatedAt)}` : 'Localização compartilhada só com sua autorização.'}</span></div>
        <div className="location-options"><span>Compartilhar como</span><select value={vehicleRole} onChange={e => setVehicleRole(e.target.value)} aria-label="Tipo de localização"><option value="pessoa">Pessoa</option><option value="carro-1">Carro 1</option><option value="carro-2">Carro 2</option></select></div><button className={`location-button ${sharing ? 'sharing' : ''}`} onClick={toggleLocation} aria-live="polite"><Crosshair size={15}/>{locationStatus === 'locating' ? 'Buscando localização… toque para parar' : sharing ? 'Parar de compartilhar' : 'Compartilhar minha posição'}</button>
      </section>

      <button type="button" className="journey-card" onClick={() => setActivePanel('trip')}><div className="section-heading"><span>ETAPA DA VIAGEM</span><span className="journey-badge"><Plane size={11}/> VOOS</span></div><div className="flight-route"><div className="airport"><span>ORIGEM</span><i>Detalhes a definir</i></div><div className="flight-line"><span>✈</span></div><div className="airport right"><span>LONDRES</span><i>Destino</i></div></div><div className="flight-foot"><span>Voo da família</span><span>Aguardando detalhes · ver</span></div></button>

      <section className="chat-card"><div className="section-heading"><span>CONVERSA · {group.name.toUpperCase()}</span><span className="message-count">{messages.length}</span></div><div className="chat-scroll">
        {messages.length === 0 ? <div className="chat-empty"><span className="empty-orbit"><MessageCircle size={17}/></span><b>A viagem começa por aqui</b><span>Envie uma mensagem para o grupo.</span></div> : messages.map(message => <article className={`message ${message.senderId === user.uid ? 'mine' : ''}`} key={message.id}><div className="message-meta"><b>{message.senderId === user.uid ? 'Você' : message.senderName || 'Família'}</b><span>{timeLabel(message.createdAt)}</span><button className="forward-button" title="Encaminhar para Chateiros" aria-label="Encaminhar para Chateiros" onClick={() => forwardMessage(message)}><Forward size={11}/></button></div>{message.forwarded && <span className="forwarded-tag">Encaminhada · {message.forwardedFrom}</span>}<p>{message.text}</p></article>)}<div ref={messageEndRef}/>
      </div><form className="message-form" onSubmit={sendMessage}><input value={text} onChange={e => setText(e.target.value)} placeholder="Escreva uma mensagem…" aria-label="Mensagem"/><button disabled={!text.trim() || sending} aria-label="Enviar mensagem"><Send size={16}/></button></form></section>

      <div className="sidebar-footer"><span><ShieldCheck size={13}/> Só a família vê estes dados</span><button onClick={exitAccount}>Sair</button></div>
    </aside>

      <section className="map-area"><div className="map-topbar"><div className="map-title"><span className="map-live"><i/></span><div><b>O mapa da nossa viagem</b><span>{locations.length} {locations.length === 1 ? 'pessoa compartilhando localização' : 'localizações compartilhadas'}</span></div></div><div className="map-top-actions"><div className="member-stack">{members.slice(0, 4).map((member, i) => <span key={member.id} title={member.displayName || 'Membro'} style={{ '--avatar-color': ['#eeb39c', '#b8a5ed', '#83cdb7', '#f0cb85'][i % 4] }}>{(member.displayName || '?')[0].toUpperCase()}</span>)}{members.length === 0 && <span className="stack-empty"><Users size={14}/></span>}</div><button className="map-action" aria-label="Notificações" onClick={() => setActivePanel('notifications')}><Bell size={17}/><i/></button><button className="map-action" aria-label="Ajuda" onClick={() => setActivePanel('help')}><CircleHelp size={17}/></button></div></div>
      <div className="map-wrap"><MapView locations={locations} currentUid={user.uid} focusedUid={focusedUid}/><MapFocusControl locations={locations} currentUid={user.uid} focusedUid={focusedUid} onFocus={setFocusedUid} onLocateAll={() => { setFocusedUid(''); window.dispatchEvent(new Event('map-recenter')); }}/><div className="map-label"><span className="map-label-pin"><Compass size={16}/></span><div><b>Área de viagem</b><span>Londres e arredores</span></div><span className="label-chevron">⌄</span></div><div className="map-legend"><span><i className="legend-dot me"/> Você</span><span><i className="legend-dot car1"/> Carro 1</span><span><i className="legend-dot car2"/> Carro 2</span></div><div className="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></div><button className="recenter" onClick={() => window.dispatchEvent(new Event('map-recenter'))} title="Centralizar localizações" aria-label="Centralizar mapa"><Navigation size={18}/></button></div>
      <div className="map-bottom"><span className="secure-note"><ShieldCheck size={15}/> Localização apenas com consentimento</span><span className="map-signal"><SignalHigh size={15}/> Atualização ao vivo</span></div></section>

    {error && <div className="toast" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Fechar"><X size={16}/></button></div>}
    {callState !== 'idle' && <div className="call-dock" aria-label="Controles da chamada">
      <div className="call-dock-main" role="status" aria-live="polite">
        <span className={`call-wave ${callState}`}><Activity size={19}/></span>
        <div className="call-info"><b>{callLabel}</b><span>{callTarget || group.name} · {speakers.length ? `${speakers.length} falando` : `${callParticipants} na chamada`}</span></div>
        <span className={`call-quality ${callQuality}`} title={callQualityLabel}><SignalHigh size={15}/><span>{callQualityLabel}</span></span>
        {audioPlaybackBlocked && <button className="unlock-audio" onClick={unlockCallAudio}><Volume2 size={15}/>Ativar áudio</button>}
        <button className={`call-control ${muted ? 'is-muted' : ''}`} onClick={toggleMute} aria-label={muted ? 'Ativar microfone' : 'Silenciar microfone'} title={muted ? 'Ativar microfone' : 'Silenciar microfone'}>{muted ? <MicOff size={18}/> : <Mic size={18}/>}</button>
        <button className="hangup" onClick={leaveCall} aria-label="Sair da chamada" title="Sair da chamada"><PhoneOff size={18}/></button>
      </div>
      <div className="call-music-row">
        <input ref={musicFileInputRef} className="visually-hidden" type="file" accept="audio/mpeg,.mp3" onChange={chooseMusicFile} aria-label="Escolher arquivo MP3"/>
        <button className="music-select-button" type="button" disabled={callState !== 'active' || Boolean(sharedMusic)} onClick={() => musicFileInputRef.current?.click()} title={sharedMusic ? 'Encerre a música atual para escolher outra' : 'Escolher um MP3 para todos na chamada'}>
          <Music2 size={16}/><span>{sharedMusic ? 'Música compartilhada' : 'Compartilhar MP3'}</span>
        </button>
        {!sharedMusic && <span className="music-share-hint">Ao vivo para todos nesta chamada</span>}
        {sharedMusic && <div className="music-shared-controls">
          <span className="music-title"><b title={sharedMusic.title}>{sharedMusic.title}</b><small>{sharedMusic.ownerUid === user.uid ? 'Tocando para todos' : `${sharedMusic.ownerName || 'Família'} · para todos`} · {sharedMusic.playing ? 'reproduzindo' : 'pausada'}</small></span>
          <button type="button" className="music-icon-button" onClick={() => requestMusicControl(sharedMusic.playing ? 'pause' : 'play')} aria-label={sharedMusic.playing ? 'Pausar para todos' : 'Reproduzir para todos'} title={sharedMusic.playing ? 'Pausar para todos' : 'Reproduzir para todos'}>{sharedMusic.playing ? <Pause size={16}/> : <Play size={16}/>}</button>
          <label className="music-volume" title="Volume compartilhado"><Volume2 size={15}/><input type="range" min="0" max="1" step="0.05" value={musicVolume} onChange={requestMusicVolume} aria-label="Volume da música para todos"/></label>
          <button type="button" className="music-icon-button music-stop" onClick={() => requestMusicControl('stop')} aria-label="Tirar música para todos" title="Tirar música para todos"><Trash2 size={15}/></button>
        </div>}
      </div>
    </div>}
    <div className={`call-fab-wrap ${callState !== 'idle' ? 'in-call' : ''}`}>{callMenu && callState === 'idle' && <div className="call-menu"><b>Iniciar chamada de áudio</b><button onClick={() => { setCallTarget(null); startCall(); }}><Users size={15}/><span>Chamar grupo <small>{group.name}</small></span></button>{members.filter(member => member.id !== user.uid).map(member => <button key={member.id} onClick={() => { setCallTarget(member.displayName || 'Familiar'); startCall(member.id); }}><Phone size={14}/><span>{member.displayName || 'Familiar'} <small>Chamada individual</small></span></button>)}</div>}<span className="fab-hint">Ligue para o grupo</span><button className="call-fab" onClick={callState === 'idle' ? () => setCallMenu(!callMenu) : leaveCall} aria-label="Iniciar chamada de áudio"><Phone size={19} fill="currentColor"/></button></div>
    {activePanel && <div className="panel-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setActivePanel(null); }}><section className="info-panel" role="dialog" aria-modal="true" aria-labelledby="info-panel-title"><button className="info-panel-close" onClick={() => setActivePanel(null)} aria-label="Fechar painel"><X size={18}/></button>
      {activePanel === 'groups' && <><span className="eyebrow">ESPAÇO DA FAMÍLIA</span><h2 id="info-panel-title">Seus grupos</h2><p>Escolha uma conversa. Cada grupo tem mensagens e chamada próprias.</p><div className="panel-group-list">{GROUPS.map(item => <button key={item.id} onClick={() => { setActive(item.id); setActivePanel(null); }}><span className="group-icon" style={{ '--group-color': item.color }}><item.icon size={16}/></span><span><b>{item.name}</b><small>{item.text}</small></span><ArrowRight size={15}/></button>)}</div><div className="panel-note"><LockKeyhole size={15}/> O servidor libera os grupos depois de validar a senha da família.</div></>}
      {activePanel === 'privacy' && <><span className="eyebrow">CONTROLES DA CONTA</span><h2 id="info-panel-title">Privacidade e localização</h2><p>Sua posição só é enviada enquanto você autoriza o compartilhamento. Você pode interromper quando quiser.</p><div className="panel-status"><span className={sharing ? 'status-dot on' : 'status-dot'}/><span>{sharing ? 'Compartilhamento ligado neste aparelho' : locationPermission === 'denied' ? 'Permissão do Safari bloqueada' : 'Sua posição não está sendo compartilhada por este aparelho'}</span></div><button className="panel-primary" onClick={() => { setActivePanel(null); toggleLocation(); }}>{sharing ? 'Parar de compartilhar' : 'Tentar compartilhar localização'}</button><div className="panel-note location-help"><MapPin size={15}/><span>No iPhone: Ajustes → Apps → Safari → Localização. Para este site, abra-o no Safari, toque em <b>aA → Ajustes do Site → Localização → Permitir</b>. Depois tente novamente. <a href="https://support.apple.com/en-euro/guide/iphone/iphb01fc3c85/27/ios/27" target="_blank" rel="noreferrer">Guia da Apple</a>.</span></div><div className="panel-note"><LockKeyhole size={15}/><span>Ao tocar em Sair ou fechar a página com conexão, o app pede ao servidor para apagar esta conta temporária, as mensagens dela e suas posições.</span></div><small className="panel-caption">A posição só aparece aos membros da família com acesso válido.</small></>}
      {activePanel === 'notifications' && <><span className="eyebrow">AVISOS</span><h2 id="info-panel-title">Notificações</h2><p>Notificações push ainda não foram configuradas neste projeto.</p><div className="panel-note"><Bell size={15}/> Para ativá-las é necessário configurar Firebase Cloud Messaging, a chave VAPID e o serviço de envio no backend.</div></>}
      {activePanel === 'help' && <><span className="eyebrow">GUIA RÁPIDO</span><h2 id="info-panel-title">Como usar</h2><ul className="panel-help-list"><li><b>Grupos:</b> escolha uma conversa no painel lateral.</li><li><b>Localização:</b> toque em “Compartilhar minha posição” para iniciar e novamente para parar.</li><li><b>Chamadas:</b> use o botão de telefone e escolha uma chamada em grupo ou individual.</li><li><b>MP3:</b> durante uma chamada, toque em “Compartilhar MP3”. Play, pausa, volume e encerrar são sincronizados com quem está na chamada. O arquivo toca ao vivo e não é salvo no Firebase; quem compartilha precisa manter a chamada conectada.</li><li><b>Mapa:</b> o botão de pin centraliza as posições reais disponíveis.</li></ul><div className="panel-note"><ShieldCheck size={15}/> Se aparecer falta de permissão, a conta precisa ser associada aos grupos no Firebase.</div></>}
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

function AuthScreen({ password, setPassword, passwordVisible, setPasswordVisible, busy, submit, error }) {
  return <main className="auth-screen"><div className="auth-visual"><div className="auth-top"><div className="brand-mark">L</div><span>UMA VIAGEM. TODOS JUNTOS.</span></div><div className="auth-art"><span className="art-orbit one"/><span className="art-orbit two"/><span className="art-pin"><MapPin size={26}/></span><span className="art-point p1"/><span className="art-point p2"/><span className="art-point p3"/></div><div className="auth-caption"><span className="eyebrow">LONDON · FAMILY TRIP</span><h2>A cidade é grande.<br/><em>Vocês estão perto.</em></h2><p>Um lugar seguro para acompanhar, conversar e se encontrar.</p></div></div><section className="auth-panel"><div className="auth-form-wrap"><div className="eyebrow">LONDON FAMILY TRACKER</div><h1>Entre na viagem.</h1><p className="auth-lede">Digite a senha da família para continuar.</p><form onSubmit={submit} className="auth-form"><label>Senha da família<div className="private-input"><input required minLength={1} type={passwordVisible ? 'text' : 'password'} autoComplete="off" autoFocus value={password} onChange={e => setPassword(e.target.value)} placeholder="Senha compartilhada"/><button type="button" onClick={() => setPasswordVisible(!passwordVisible)} aria-label={passwordVisible ? 'Ocultar senha' : 'Mostrar senha'}>{passwordVisible ? <EyeOff size={16}/> : <Eye size={16}/>}</button></div></label>{error && <div className="auth-error" role="alert">{error}</div>}<button className="auth-submit" disabled={busy || !password}>{busy ? 'Verificando…' : 'Entrar na viagem'}{!busy && <LogIn size={17}/>}</button></form><div className="auth-private"><ShieldCheck size={15}/> A senha não fica salva neste aparelho.</div></div><div className="auth-footer">LONDON FAMILY TRACKER <span>·</span> ESPAÇO PRIVADO DA FAMÍLIA</div></section></main>;
}

function FamilyNameScreen({ name, setName, busy, submit, error }) {
  return <main className="auth-screen"><div className="auth-visual"><div className="auth-top"><div className="brand-mark">L</div><span>UMA VIAGEM. TODOS JUNTOS.</span></div><div className="auth-art"><span className="art-orbit one"/><span className="art-orbit two"/><span className="art-pin"><Users size={25}/></span><span className="art-point p1"/><span className="art-point p2"/><span className="art-point p3"/></div><div className="auth-caption"><span className="eyebrow">LONDON · FAMILY TRIP</span><h2>Agora, como<br/><em>podemos chamar você?</em></h2><p>Seu nome aparece nas mensagens e no mapa quando você compartilhar sua posição.</p></div></div><section className="auth-panel"><div className="auth-form-wrap"><div className="eyebrow">ACESSO CONFIRMADO</div><h1>Qual é o seu nome?</h1><p className="auth-lede">Assim a família reconhece suas mensagens e sua posição compartilhada.</p><form onSubmit={submit} className="auth-form"><label>Seu nome<input required maxLength={80} autoComplete="name" autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="Como podemos chamar você?"/></label>{error && <div className="auth-error" role="alert">{error}</div>}<button className="auth-submit" disabled={busy || !name.trim()}>{busy ? 'Salvando…' : 'Continuar'}{!busy && <ArrowRight size={17}/>}</button></form><div className="auth-private"><ShieldCheck size={15}/> O nome pode ser alterado na próxima entrada.</div></div><div className="auth-footer">LONDON FAMILY TRACKER <span>·</span> ESPAÇO PRIVADO DA FAMÍLIA</div></section></main>;
}
