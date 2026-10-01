import { useEffect, useRef } from 'react';

/** Marks a scrollable element with data-fade-top / data-fade-bottom while there is more to scroll in that direction (see .scroll-fade in styles.css). */
export function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.dataset.fadeTop = String(el.scrollTop > 2);
      el.dataset.fadeBottom = String(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);
  return ref;
}
