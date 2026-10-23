// Name generators: syllable grammars per style (characters, places, taverns, items, stars),
// seeded, without repeats in one call.

import { rng } from '../util/rng.mjs';

const STYLES = {
  fantasy: { start: ['al', 'bel', 'cor', 'dra', 'el', 'fen', 'gar', 'hal', 'is', 'jor', 'kal', 'lor', 'mir', 'nor', 'or', 'per', 'quel', 'ran', 'sil', 'tor', 'ul', 'val', 'wyn', 'zar'], mid: ['a', 'e', 'i', 'o', 'an', 'en', 'ar', 'or', 'il', 'el', 'ad', 'un'], end: ['dor', 'wen', 'ric', 'mir', 'th', 'las', 'dan', 'ra', 'ia', 'on', 'ius', 'wyn', 'mar', 'gorn'], parts: [2, 3] },
  elven: { start: ['ae', 'cel', 'el', 'gal', 'ith', 'lae', 'lin', 'mel', 'nim', 'syl', 'tha', 'vae', 'aer', 'fae'], mid: ['a', 'ae', 'ia', 'i', 'e', 'ri', 'li', 'na', 'th'], end: ['wen', 'riel', 'las', 'dil', 'ion', 'ael', 'thas', 'nor', 'ra', 'iel', 'wyn'], parts: [2, 4] },
  dwarven: { start: ['bal', 'bor', 'dur', 'dwa', 'gim', 'gro', 'kaz', 'thor', 'thra', 'bru', 'dag', 'mor', 'ung'], mid: ['a', 'i', 'u', 'o', 'ur', 'im', 'ag'], end: ['in', 'li', 'grim', 'dok', 'gar', 'rak', 'nur', 'din', 'bur', 'drum', 'mek'], parts: [2, 3] },
  orcish: { start: ['gr', 'kr', 'ug', 'zog', 'mag', 'thr', 'gor', 'nar', 'skar', 'bol', 'ruk', 'gash'], mid: ['a', 'u', 'o', 'ak', 'ug', 'ar'], end: ['ash', 'uk', 'nak', 'gul', 'mok', 'rag', 'zog', 'gor', 'dush', 'bag'], parts: [2, 3] },
  scifi: { start: ['ax', 'cy', 'ze', 'vex', 'ky', 'nov', 'qu', 'ry', 'sol', 'tal', 'xen', 'or', 'vel'], mid: ['a', 'o', 'i', 'ar', 'en', 'ix', 'on', 'yr'], end: ['on', 'ix', 'ar', 'us', 'ex', 'a', 'is', 'or', 'yn', 'tron', 'ia'], parts: [2, 3], suffix: ['', '', '', ' Prime', ' IV', ' VII', '-9', ' Major'] },
  place: { start: ['ash', 'black', 'bright', 'cold', 'dun', 'elm', 'fair', 'frost', 'gold', 'green', 'grey', 'high', 'iron', 'mill', 'oak', 'raven', 'red', 'rose', 'silver', 'stone', 'storm', 'thorn', 'west', 'wolf'], end: ['brook', 'bury', 'dale', 'fall', 'ford', 'gate', 'hold', 'holm', 'hollow', 'keep', 'mere', 'moor', 'port', 'reach', 'stead', 'vale', 'watch', 'wick', 'wood', 'haven'], compound: true },
};

const TAVERN = { adj: ['Prancing', 'Rusty', 'Golden', 'Drunken', 'Sleeping', 'Laughing', 'Crooked', 'Silver', 'Wandering', 'Jolly', 'Howling', 'Gilded', 'Salty', 'Merry'], noun: ['Pony', 'Dragon', 'Tankard', 'Goblin', 'Lantern', 'Anchor', 'Boar', 'Griffin', 'Kettle', 'Stag', 'Mermaid', 'Barrel', 'Owl', 'Crown'] };
const ITEM = { mat: ['Iron', 'Steel', 'Silver', 'Obsidian', 'Bone', 'Crystal', 'Ancient', 'Runed', 'Rusty', 'Gilded', 'Shadow', 'Ember'], kind: ['Sword', 'Axe', 'Bow', 'Staff', 'Dagger', 'Hammer', 'Shield', 'Spear', 'Amulet', 'Ring', 'Helm', 'Wand'], of: ['the Fox', 'Embers', 'the Deep', 'Storms', 'the North', 'Echoes', 'Dawn', 'the Lost King', 'Frost', 'Whispers', 'the Tide', 'Valor'] };

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** A word from a syllable style without awkward triple letters. */
function word(st, r) {
  if (st.compound) return cap(r.pick(st.start) + r.pick(st.end));
  const n = r.int(st.parts[0], st.parts[1]);
  let s = r.pick(st.start);
  for (let i = 2; i < n; i++) s += r.pick(st.mid);
  s += r.pick(st.end);
  s = s.replace(/(.)\1\1+/g, '$1$1').replace(/([aeiou])\1/g, (m, v) => (v === 'e' || v === 'o' ? m : v));
  return cap(s) + (st.suffix ? r.pick(st.suffix) : '');
}

export const NAME_STYLES = [...Object.keys(STYLES), 'tavern', 'item'];

/** count distinct names of a style for a seed. */
export function names({ style = 'fantasy', count = 10, seed = 0 } = {}) {
  const r = rng(`${seed}:${style}`);
  const out = new Set();
  for (let tries = 0; out.size < count && tries < count * 50; tries++) {
    if (style === 'tavern') out.add(`The ${r.pick(TAVERN.adj)} ${r.pick(TAVERN.noun)}`);
    else if (style === 'item') out.add(r.chance(0.6) ? `${r.pick(ITEM.mat)} ${r.pick(ITEM.kind)} of ${r.pick(ITEM.of)}` : `${word(STYLES.fantasy, r)}, the ${r.pick(ITEM.mat)} ${r.pick(ITEM.kind)}`);
    else {
      const st = STYLES[style];
      if (!st) throw new Error(`unknown name style ${style}: one of ${NAME_STYLES.join(', ')}`);
      const w = word(st, r);
      if (w.length >= 3 && w.length <= 16) out.add(w);
    }
  }
  return [...out];
}
