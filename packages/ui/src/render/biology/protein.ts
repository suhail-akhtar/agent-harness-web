/**
 * Proteins: ```uniprot feature tracks over a sequence (domains, sites, PTMs, topology, secondary
 * structure), and the 3D view for ```pdb / ```cif with a secondary-structure cartoon, chain colours,
 * ligands highlighted and a residue picker (3Dmol.js in a sandboxed frame, like the science 3D view).
 *
 *   {"name": "Ubiquitin", "accession": "P0CG48", "sequence": "MQIFV...", "features": [{"type": "Domain", "start": 1, "end": 76, "description": "Ubiquitin-like"}]}
 *
 * UniProt's own JSON (features with location.start.value) is read too. Pure; tested.
 */

import { LIMITS, checkSize, isObj, num, parseJson, text, tooLarge } from './common.ts';
import { artifactCsp } from '../artifact-doc.ts';

export type FeatureCategory = 'Domains & regions' | 'Sites' | 'PTMs' | 'Processing' | 'Topology' | 'Structure' | 'Variants' | 'Other';
export interface ProteinFeature { type: string; category: FeatureCategory; start: number; end: number; description: string }
export interface ProteinTracks { name: string; accession: string; length: number; sequence: string; features: ProteinFeature[]; notes: string[] }

export const CATEGORY_ORDER: FeatureCategory[] = ['Processing', 'Domains & regions', 'Sites', 'PTMs', 'Topology', 'Structure', 'Variants', 'Other'];
export const CATEGORY_COLOR: Record<FeatureCategory, string> = {
  'Domains & regions': '#3b7dd8', Sites: '#d1453b', PTMs: '#8a55c7', Processing: '#e06aa5', Topology: '#d69a1c', Structure: '#1a9e5c', Variants: '#7b8794', Other: '#14a3a3',
};

export function categoryOf(type: string): FeatureCategory {
  const t = type.toLowerCase();
  if (/helix|strand|turn|beta|sheet/.test(t)) return 'Structure';
  if (/signal|transit|propeptide|^chain|peptide|initiator/.test(t)) return 'Processing';
  if (/transmembrane|topolog|intramembrane/.test(t)) return 'Topology';
  if (/modified|glycos|lipid|cross-link|crosslink|disulfide|phospho|acetyl|ubiquit/.test(t)) return 'PTMs';
  if (/site|binding|metal|active/.test(t)) return 'Sites';
  if (/variant|mutagen|conflict/.test(t)) return 'Variants';
  if (/domain|region|repeat|motif|zinc|coiled|compositional|dna-binding/.test(t)) return 'Domains & regions';
  return 'Other';
}

export function parseProteinFeatures(source: string): ProteinTracks {
  checkSize(source, 'protein features');
  const j = parseJson(source.trim(), 'protein features');
  if (!isObj(j)) throw new Error('```uniprot is {"name", "sequence" or "length", "features": [{"type", "start", "end", "description"}]}');
  const seqObj = j.sequence;
  const sequence = (typeof seqObj === 'string' ? seqObj : isObj(seqObj) && typeof seqObj.value === 'string' ? seqObj.value : '').replace(/\s+/g, '').toUpperCase();
  if (sequence && !/^[A-Z*]+$/.test(sequence)) throw new Error('"sequence" may hold only amino-acid letters');
  const length = Math.round(num(j.length) ?? (isObj(seqObj) ? num(seqObj.length) : undefined) ?? sequence.length);
  if (!(length > 0)) throw new Error('give "sequence" or "length" (residues)');
  if (length > 100_000) throw new Error(`"length" ${length} is not a protein`);
  const raw = Array.isArray(j.features) ? j.features : [];
  if (!Array.isArray(j.features)) throw new Error('"features" is a list of {type, start, end, description}');
  const notes: string[] = [];
  if (raw.length > LIMITS.proteinFeatures) notes.push(tooLarge(LIMITS.proteinFeatures, raw.length, 'features'));
  const features = raw.slice(0, LIMITS.proteinFeatures).map((f, i): ProteinFeature => {
    if (!isObj(f)) throw new Error(`feature ${i + 1} is not an object`);
    const loc = isObj(f.location) ? f.location : undefined;
    const s = num(f.start ?? f.begin ?? (isObj(loc?.start) ? (loc!.start as Record<string, unknown>).value : undefined));
    const e = num(f.end ?? (isObj(loc?.end) ? (loc!.end as Record<string, unknown>).value : undefined)) ?? s;
    if (s === undefined || e === undefined) throw new Error(`feature ${i + 1} ("${text(f.type, 30)}") needs numeric "start" and "end"`);
    const type = text(f.type ?? 'Region', 40) || 'Region';
    const [a, b] = s <= e ? [s, e] : [e, s];
    return { type, category: categoryOf(type), start: Math.max(1, Math.min(length, Math.round(a))), end: Math.max(1, Math.min(length, Math.round(b))), description: text(f.description ?? f.label ?? f.note ?? '', 80) };
  });
  const pd = isObj(j.proteinDescription) && isObj(j.proteinDescription.recommendedName) && isObj(j.proteinDescription.recommendedName.fullName) ? j.proteinDescription.recommendedName.fullName.value : undefined;
  return { name: text(j.name ?? pd ?? j.uniProtkbId ?? j.title ?? 'protein', 60), accession: text(j.accession ?? j.primaryAccession ?? '', 20), length, sequence: sequence.slice(0, length), features, notes };
}

// ---------- 3D (pdb / cif) ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A 3D protein viewer page: cartoon coloured by secondary structure (3Dmol computes it when the file
 * has no HELIX/SHEET records), by chain or as a spectrum; ligands (HETATM, not water) as sticks; a
 * residue picker (select or click) that centres and labels a residue. 3Dmol computes the secondary
 * structure from hydrogen bonds and then applies the file's HELIX/SHEET records, except that a bare
 * `END` line makes it drop those records, so it is padded the way RCSB writes it. The structure travels
 * base64-encoded and is parsed by 3Dmol, never as markup. Small files (fewer than 8 residues) are
 * drawn as balls and sticks. Reports `data-atoms` like the science 3D view.
 */
export function proteinDocument(source: string, format: string, runtimeUrl?: string, dark = false): string {
  const fmt = format === 'cif' || format === 'mmcif' ? 'cif' : 'pdb';
  const base = runtimeUrl ? runtimeUrl.replace(/[^/]*$/, '') : '';
  const b64 = btoa(unescape(encodeURIComponent(source)));
  const bg = dark ? '#16181d' : '#ffffff'; const ink = dark ? '#e6e6e6' : '#1f1e1c'; const line = dark ? '#3a3d44' : '#dddad3';
  const css = `html,body{margin:0;height:100%;background:${bg};color:${ink};font:12px system-ui,'Segoe UI',sans-serif}#v{position:absolute;inset:34px 0 0 0}#bar{position:absolute;top:0;left:0;right:0;height:33px;display:flex;gap:6px;align-items:center;padding:0 8px;border-bottom:1px solid ${line};box-sizing:border-box;white-space:nowrap;overflow-x:auto}select,button{font:inherit;color:inherit;background:transparent;border:1px solid ${line};border-radius:6px;padding:2px 6px}button[aria-pressed=true]{background:${dark ? '#2b2e35' : '#efece6'}}#info{margin-left:auto;opacity:.75}#e{color:#d1453b;padding:10px;position:absolute;top:34px}`;
  const script = `(function(){var el=document.getElementById('mol');var info=document.createElement('span');info.id='info';try{if(!window.$3Dmol)throw new Error('the 3D viewer is not available here');
var data=decodeURIComponent(escape(atob(el.getAttribute('data-b64'))));var v=window.$3Dmol.createViewer(document.getElementById('v'),{backgroundColor:'${bg}'});
var m=v.addModel(data.replace(/^END[ 	]*$/gm,'END   '),el.getAttribute('data-format'));var atoms=m?m.selectedAtoms({}):[];var n=atoms.length;if(!n)throw new Error('no atoms in this structure');
var ca=atoms.filter(function(a){return a.atom==='CA'&&!a.hetflag;});var chains={};ca.forEach(function(a){chains[a.chain]=1;});var nch=Object.keys(chains).length;
var lig=atoms.filter(function(a){return a.hetflag&&a.resn!=='HOH'&&a.resn!=='WAT';});var ligNames={};lig.forEach(function(a){ligNames[a.resn]=1;});
var big=ca.length>=8;var mode=big?'ss':'atoms';var showLig=true;var picked=null;
function style(){v.removeAllLabels();v.setStyle({},{});
 if(!big){v.setStyle({},{stick:{radius:0.15},sphere:{scale:0.25}});}
 else{var c=mode==='chain'?{cartoon:{colorscheme:'chain'}}:mode==='spectrum'?{cartoon:{color:'spectrum'}}:{cartoon:{colorscheme:'ssJmol'}};v.setStyle({hetflag:false},c);
  if(showLig&&lig.length){v.setStyle({hetflag:true,not:{resn:['HOH','WAT']}},{stick:{colorscheme:'greenCarbon',radius:0.25},sphere:{colorscheme:'greenCarbon',scale:0.28}});}}
 if(picked){var sel={chain:picked.chain,resi:picked.resi};v.addStyle(sel,{stick:{colorscheme:'orangeCarbon',radius:0.22}});v.addLabel(picked.resn+' '+picked.resi+(nch>1?' ('+picked.chain+')':''),{position:picked,backgroundColor:'#222',backgroundOpacity:0.8,fontColor:'#fff',fontSize:12,inFront:true});}
 v.render();}
function pick(a){picked=a;var s=document.getElementById('res');if(s)s.value=a.chain+':'+a.resi;info.textContent=a.resn+' '+a.resi+(a.chain?' chain '+a.chain:'')+(a.ss==='h'?' · helix':a.ss==='s'?' · strand':'');style();v.zoomTo({chain:a.chain,resi:a.resi},400);}
var bar=document.getElementById('bar');
if(big){[['ss','Structure'],['chain','Chain'],['spectrum','Spectrum']].forEach(function(o){var b=document.createElement('button');b.textContent=o[1];b.setAttribute('data-mode',o[0]);b.setAttribute('aria-pressed',String(mode===o[0]));b.onclick=function(){mode=o[0];[].forEach.call(bar.querySelectorAll('[data-mode]'),function(x){x.setAttribute('aria-pressed',String(x.getAttribute('data-mode')===mode));});style();};bar.appendChild(b);});
 if(lig.length){var lb=document.createElement('button');lb.textContent='Ligands';lb.setAttribute('aria-pressed','true');lb.onclick=function(){showLig=!showLig;lb.setAttribute('aria-pressed',String(showLig));style();};bar.appendChild(lb);}
 var s=document.createElement('select');s.id='res';s.setAttribute('aria-label','Residue');var o0=document.createElement('option');o0.value='';o0.textContent='Residue…';s.appendChild(o0);
 ca.slice(0,3000).forEach(function(a){var o=document.createElement('option');o.value=a.chain+':'+a.resi;o.textContent=(nch>1?a.chain+' ':'')+a.resn+' '+a.resi;s.appendChild(o);});
 s.onchange=function(){if(!s.value){picked=null;info.textContent='';style();v.zoomTo();return;}var p=s.value.split(':');var a=ca.filter(function(x){return x.chain===p[0]&&String(x.resi)===p[1];})[0];if(a)pick(a);};bar.appendChild(s);}
bar.appendChild(info);info.textContent=(big?ca.length+' residues':n+' atoms')+(nch>1?' · '+nch+' chains':'')+(lig.length?' · ligand '+Object.keys(ligNames).slice(0,3).join(', '):'');
v.setClickable({},true,function(a){if(big)pick(ca.filter(function(x){return x.chain===a.chain&&x.resi===a.resi;})[0]||a);});
style();v.zoomTo();v.render();document.body.setAttribute('data-atoms',String(n));document.body.setAttribute('data-residues',String(ca.length));document.body.setAttribute('data-chains',String(nch));document.body.setAttribute('data-ligands',String(Object.keys(ligNames).length));
parent.postMessage({harnessArtifact:'molecule',atoms:n},'*');}catch(e){var d=document.createElement('div');d.id='e';d.textContent='Could not show this structure: '+e.message;document.body.appendChild(d);}})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${esc(artifactCsp(true, base || undefined))}"><style>${css}</style></head><body><div id="bar"></div><div id="v"></div>${base ? `<script src="${esc(base)}3Dmol-min.js"></script>` : ''}<script id="mol" type="text/plain" data-b64="${b64}" data-format="${fmt}"></script><script>${script}</script></body></html>`;
}
