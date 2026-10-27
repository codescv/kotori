/**
 * 5:7 cover thumbnail with automatic placeholder icon when `src` is absent or
 * fails to load.
 */
import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../../components/m3/Icon';

export interface CoverThumbProps {
  readonly src?: string | undefined;
  readonly alt: string;
  readonly fallbackIcon?: IconName;
  readonly size?: 'sm' | 'md' | 'lg';
}

export function CoverThumb({ src, alt, fallbackIcon = 'book', size = 'md' }: CoverThumbProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return (
      <div className={`k-dl-cover k-dl-cover--${size} k-dl-cover--placeholder`} aria-hidden="true">
        <Icon name={fallbackIcon} size={size === 'lg' ? 28 : 22} />
      </div>
    );
  }

  return (
    <div className={`k-dl-cover k-dl-cover--${size}`}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
