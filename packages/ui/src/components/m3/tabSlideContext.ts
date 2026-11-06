/**
 * Whether the subtree renders inside a non-active `<TabPager>` slide (a neighbour
 * peeked during a drag, or the old page sliding out after a tab change). Such slides
 * are `inert` / `aria-hidden`; side effects that must belong to the visible page only
 * (Android back interceptors, dialog autofocus, scroll-into-view, nested swipe strips)
 * check this flag. Nested pagers inherit it: an inner active slide inside an inactive
 * outer slide is inactive too.
 */
import { createContext, useContext } from 'react';

export const InactiveTabSlideContext = createContext(false);

/** `true` while rendered inside a peeked / exiting `<TabPager>` slide. */
export function useIsInactiveTabSlide(): boolean {
  return useContext(InactiveTabSlideContext);
}
