'use client';

import { useMemo } from 'react';
import { encode } from 'uqr';

/** A QR code drawn as SVG, black on white whatever the theme, so phones can read it. */
export function QrCode({ text, label, size = 176 }: { text: string; label: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
    return { path: d, n: qr.size };
  }, [text]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="rounded-sm">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
