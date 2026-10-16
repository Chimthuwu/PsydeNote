import { useEffect, useState } from 'react';

/**
 * A counter that bumps whenever the active theme changes.
 *
 * Every canvas in the app paints its background, grid and trace by reading the
 * theme's CSS custom properties at paint time —
 * `getComputedStyle(document.body).getPropertyValue('--bg-surface-elevated')`
 * and friends. Those reads live inside a `useEffect` whose dependency array
 * lists the *data* being drawn (points, env, curve…) and nothing about the
 * theme, because the theme is not a React value anywhere near them: it is a
 * class on `document.body` (`PluginApp.tsx` sets `document.body.className =
 * \`theme-\${theme}\``).
 *
 * So switching theme restyled the DOM instantly but left every canvas holding
 * the previous theme's colours until something unrelated happened to change a
 * real dependency and trigger a repaint. (User, 2026-10-10: the velocity /
 * key-mapping graphic "will remain in the same color as the previous theme
 * until I move the ... envelope inside of it".)
 *
 * Adding this hook's value to those dependency arrays makes the theme a real
 * React dependency without threading a `theme` prop through every component
 * that happens to own a canvas — and it keeps working for canvases added
 * later, since it watches the single place the theme is actually applied.
 */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const target = document.body;
    let last = target.className;
    const observer = new MutationObserver(() => {
      // Only a class CHANGE counts: `class` is rewritten on other renders too,
      // and bumping on every mutation would repaint every canvas needlessly.
      if (target.className === last) return;
      last = target.className;
      setVersion((v) => v + 1);
    });
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return version;
}
