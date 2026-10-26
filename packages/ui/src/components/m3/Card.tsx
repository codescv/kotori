/** M3 cards: filled · outlined · elevated. Interactive when `onClick` is set. */
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly children?: ReactNode;
  readonly selected?: boolean;
}

function makeCard(variant: 'filled' | 'outlined' | 'elevated') {
  function CardImpl({ className, onClick, selected, children, ...rest }: CardProps) {
    const interactive = onClick !== undefined;
    return (
      <div
        className={cx('k-card', `k-card--${variant}`, interactive && 'k-card--interactive', selected && 'is-selected', className)}
        onClick={onClick}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  (e.currentTarget as HTMLDivElement).click();
                }
              }
            : undefined
        }
        {...rest}
      >
        {children}
      </div>
    );
  }
  CardImpl.displayName = `${variant[0]?.toUpperCase()}${variant.slice(1)}Card`;
  return CardImpl;
}

export const FilledCard = makeCard('filled');
export const OutlinedCard = makeCard('outlined');
export const ElevatedCard = makeCard('elevated');
