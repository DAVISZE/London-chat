import { useEffect, useRef } from 'react';
import L from 'leaflet';

function markerIcon(kind, label) {
  const colors = { self: '#586bea', 'carro-1': '#5fd9b8', 'carro-2': '#82a1ff', other: '#bd96ff' };
  const color = colors[kind] || colors.other;
  const symbol = kind.startsWith('carro') ? '⌁' : kind === 'self' ? '●' : (label || '•').slice(0, 1).toUpperCase();
  return L.divIcon({ className: 'family-marker-host', html: `<span class="family-marker ${kind}" style="--marker-color:${color}">${symbol}</span>`, iconSize: [38, 38], iconAnchor: [19, 19] });
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export default function MapView({ locations, currentUid }) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const didFitRef = useRef(false);

  useEffect(() => {
    if (!nodeRef.current || mapRef.current) return;
    const map = L.map(nodeRef.current, { zoomControl: false, attributionControl: false, minZoom: 3 }).setView([51.5077, -0.1278], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    mapRef.current = map;
    const recenter = () => {
      const points = [...markersRef.current.values()].map(marker => marker.getLatLng());
      if (points.length === 1) map.setView(points[0], 14, { animate: true });
      else if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 14, animate: true });
    };
    window.addEventListener('map-recenter', recenter);
    const resize = new ResizeObserver(() => map.invalidateSize()); resize.observe(nodeRef.current);
    return () => { window.removeEventListener('map-recenter', recenter); resize.disconnect(); map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const present = new Set();
    locations.forEach(location => {
      if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return;
      present.add(location.uid);
      const kind = location.uid === currentUid ? 'self' : location.vehicle || 'other';
      const stamp = location.updatedAt?.toDate ? location.updatedAt.toDate() : location.updatedAt ? new Date(location.updatedAt) : null;
      const updated = stamp ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(stamp) : 'atualizando';
      const content = `<b>${escapeHtml(location.displayName || (kind.startsWith('carro') ? kind.replace('-', ' ') : 'Familiar'))}</b><br><span>Atualizado às ${escapeHtml(updated)}</span>`;
      const existing = markersRef.current.get(location.uid);
      if (existing) existing.setLatLng([location.latitude, location.longitude]).setPopupContent(content);
      else markersRef.current.set(location.uid, L.marker([location.latitude, location.longitude], { icon: markerIcon(kind, location.displayName) }).bindPopup(content).addTo(map));
    });
    markersRef.current.forEach((marker, key) => { if (!present.has(key)) { marker.remove(); markersRef.current.delete(key); } });
    if (!didFitRef.current && locations.length) {
      const points = [...markersRef.current.values()].map(marker => marker.getLatLng());
      if (points.length === 1) map.setView(points[0], 14);
      else if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 14 });
      didFitRef.current = true;
    }
  }, [locations, currentUid]);

  return <div className="map" ref={nodeRef} aria-label="Mapa de Londres e localizações autorizadas"/>;
}
