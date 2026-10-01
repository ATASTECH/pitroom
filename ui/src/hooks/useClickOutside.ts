import { useEffect, useRef } from 'react';

type EventType = 'mousedown' | 'mouseup' | 'touchstart' | 'touchend' | 'focusin' | 'focusout';

interface UseClickOutsideProps<T extends HTMLElement = HTMLElement> {
  ref: React.RefObject<T | null> | React.RefObject<T | null>[];
  callback: (event: MouseEvent | TouchEvent | FocusEvent) => void;
  eventType?: EventType;
  eventListenerOptions?: AddEventListenerOptions;
}

/** Calls `callback` when an event lands outside every given ref (from Shadix UI, with its event-listener hook inlined). */
export const useClickOutside = <T extends HTMLElement = HTMLElement>({ ref, callback, eventType = 'mousedown', eventListenerOptions }: UseClickOutsideProps<T>): void => {
  const saved = useRef(callback);
  saved.current = callback;
  const refs = useRef(ref);
  refs.current = ref;
  useEffect(() => {
    const handler = (event: Event) => {
      const target = event.target as Node | null;
      if (!target || !target.isConnected) return;
      const list = Array.isArray(refs.current) ? refs.current : [refs.current];
      const outside = list.filter((r) => Boolean(r.current)).every((r) => r.current && !r.current.contains(target));
      if (outside) saved.current(event as MouseEvent);
    };
    document.addEventListener(eventType, handler, eventListenerOptions);
    return () => document.removeEventListener(eventType, handler, eventListenerOptions);
  }, [eventType, eventListenerOptions]);
};
