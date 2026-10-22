/** The product's icon (from its profile, read by the app as a data URL), else its initial on the accent colour. */

import React from 'react';
import { useApp } from '../state/app';

export function ProductMark({ size = 24 }: { size?: number }): React.ReactElement {
  const info = useApp((s) => s.info);
  if (info?.iconDataUrl) return <img src={info.iconDataUrl} alt="" width={size} height={size} className="shrink-0 rounded-[22%]" data-product-icon />;
  return <span className="flex shrink-0 items-center justify-center rounded-[22%] bg-hx-accent font-bold text-hx-on-accent" style={{ width: size, height: size, fontSize: size * 0.48 }}>{(info?.product.brand.wordmark ?? info?.product.name ?? 'H').slice(0, 1)}</span>;
}
