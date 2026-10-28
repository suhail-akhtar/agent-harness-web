/**
 * "The agent is working": one small animated glyph in the style the person picked (Settings > Appearance),
 * drawn with CSS only (styles.css, .hx-w-*); slower with reduced motion. Its colour is the text colour around it.
 */

import React from 'react';
import { cx } from './primitives.tsx';

export const WORKING_STYLES = [
  { id: 'dots', label: 'Bouncing dots' },
  { id: 'typing', label: 'Typing dots' },
  { id: 'wave', label: 'Sound wave' },
  { id: 'orbit', label: 'Orbit' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'comet', label: 'Comet' },
] as const;

export type WorkingStyle = typeof WORKING_STYLES[number]['id'];

const PARTS: Record<WorkingStyle, number> = { dots: 3, typing: 3, wave: 4, orbit: 1, pulse: 1, comet: 0 };

export function Working({ style = 'dots', className, label = 'Working' }: { style?: string; className?: string; label?: string }): React.ReactElement {
  const s = (WORKING_STYLES.some((x) => x.id === style) ? style : 'dots') as WorkingStyle;
  return (
    <span role="status" aria-label={label} className={cx('hx-w', `hx-w-${s}`, className)} data-working-style={s}>
      {Array.from({ length: PARTS[s] }, (_, i) => <i key={i} />)}
    </span>
  );
}
