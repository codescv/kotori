/** Plain M3 tooltip (CSS-only reveal on hover/focus). */
import type { ReactNode } from 'react';

export function Tooltip({ text, children }: { readonly text: string; readonly children: ReactNode }) {
  return (
    <span className="k-tooltip" data-tooltip={text}>
      {children}
    </span>
  );
}
