/**
 * GeoJSON as a plain SVG map: features projected (Web Mercator) and fitted to the box. No tiles and
 * no network at all; names and values from `properties` become labels and tooltips as text. Pure.
 */

type Pos = [number, number];
export interface MapShape { kind: 'area' | 'line'; d: string; label?: string; fill?: string; stroke?: string; title: string }
export interface MapPoint { x: number; y: number; label?: string; color?: string; title: string }
export interface MapLayout { width: number; height: number; shapes: MapShape[]; points: MapPoint[]; features: number }

const HEX = /^#[0-9a-f]{3,8}$/i;
const merc = ([lon, lat]: Pos): Pos => {
  const φ = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return [(lon * Math.PI) / 180, Math.log(Math.tan(Math.PI / 4 + φ / 2))];
};

interface Geometry { type: string; coordinates?: unknown; geometries?: Geometry[] }
interface Feature { geometry: Geometry | null; properties: Record<string, unknown> }

export function parseGeoJson(source: string): { features?: Feature[]; error?: string } {
  let j: unknown;
  try { j = JSON.parse(source); } catch (e) { return { error: `not valid JSON: ${(e as Error).message}` }; }
  const o = j as { type?: string; features?: unknown[]; geometry?: Geometry; properties?: Record<string, unknown> };
  if (!o || typeof o !== 'object') return { error: 'not GeoJSON' };
  const asFeature = (f: unknown): Feature | null => {
    const x = f as { type?: string; geometry?: Geometry; properties?: Record<string, unknown> };
    if (!x || typeof x !== 'object') return null;
    if (x.type === 'Feature') return { geometry: x.geometry ?? null, properties: x.properties && typeof x.properties === 'object' ? x.properties : {} };
    if (typeof x.type === 'string' && ('coordinates' in x || 'geometries' in x)) return { geometry: x as Geometry, properties: {} };
    return null;
  };
  const list = o.type === 'FeatureCollection' && Array.isArray(o.features) ? o.features.map(asFeature) : [asFeature(o)];
  const features = list.filter((f): f is Feature => !!f).slice(0, 5000);
  if (!features.length) return { error: 'no features: give a FeatureCollection, a Feature or a geometry' };
  return { features };
}

const isPos = (p: unknown): p is Pos => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1]);

function rings(g: Geometry): { kind: 'area' | 'line' | 'point'; parts: Pos[][] }[] {
  const c = g.coordinates as unknown;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const line = (v: unknown) => arr(v).filter(isPos) as Pos[];
  switch (g.type) {
    case 'Point': return isPos(c) ? [{ kind: 'point', parts: [[c]] }] : [];
    case 'MultiPoint': return [{ kind: 'point', parts: [line(c)] }];
    case 'LineString': return [{ kind: 'line', parts: [line(c)] }];
    case 'MultiLineString': return [{ kind: 'line', parts: arr(c).map(line) }];
    case 'Polygon': return [{ kind: 'area', parts: arr(c).map(line) }];
    case 'MultiPolygon': return arr(c).map((p) => ({ kind: 'area' as const, parts: arr(p).map(line) }));
    case 'GeometryCollection': return (g.geometries ?? []).flatMap(rings);
    default: return [];
  }
}

export function layoutMap(features: Feature[], width = 640, height = 400, pad = 16): MapLayout {
  const all: Pos[] = [];
  const geo = features.map((f) => ({ f, parts: f.geometry ? rings(f.geometry) : [] }));
  for (const g of geo) for (const r of g.parts) for (const p of r.parts) for (const q of p) all.push(merc(q));
  const xs = all.map((p) => p[0]); const ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = all.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [0, 1, 0, 1];
  const sx = (width - 2 * pad) / Math.max(1e-9, x1 - x0); const sy = (height - 2 * pad) / Math.max(1e-9, y1 - y0);
  const s = Math.min(sx, sy);
  const ox = pad + ((width - 2 * pad) - (x1 - x0) * s) / 2; const oy = pad + ((height - 2 * pad) - (y1 - y0) * s) / 2;
  const proj = (p: Pos): [number, number] => { const [x, y] = merc(p); return [Math.round((ox + (x - x0) * s) * 10) / 10, Math.round((oy + (y1 - y) * s) * 10) / 10]; };
  const shapes: MapShape[] = []; const points: MapPoint[] = [];
  for (const { f, parts } of geo) {
    const p = f.properties;
    const label = typeof p.name === 'string' ? p.name.slice(0, 60) : typeof p.title === 'string' ? p.title.slice(0, 60) : undefined;
    const title = Object.entries(p).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 8).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join('\n');
    const color = (k: string) => (typeof p[k] === 'string' && HEX.test(p[k] as string) ? p[k] as string : undefined);
    for (const r of parts) {
      if (r.kind === 'point') { for (const q of r.parts.flat()) { const [x, y] = proj(q); points.push({ x, y, ...(label ? { label } : {}), ...(color('marker-color') ?? color('color') ? { color: color('marker-color') ?? color('color') } : {}), title }); } continue; }
      const d = r.parts.filter((ring) => ring.length > 1).map((ring) => `M${ring.map((q) => proj(q).join(',')).join('L')}${r.kind === 'area' ? 'Z' : ''}`).join('');
      if (d) shapes.push({ kind: r.kind, d, ...(label ? { label } : {}), ...(color('fill') ? { fill: color('fill') } : {}), ...(color('stroke') ? { stroke: color('stroke') } : {}), title });
    }
  }
  return { width, height, shapes, points, features: features.length };
}
