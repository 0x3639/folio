import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EventBus, PDFViewer } from './viewer';
export function usePageOverlays(viewer: PDFViewer, bus: EventBus) {
  const hosts = useRef(new Map<number, HTMLDivElement>());
  const [, tick] = useState(0);
  useEffect(() => {
    const render = () => tick(n => n + 1);
    const events = ['pagerendered', 'scalechanging', 'rotationchanging', 'updateviewarea'];
    events.forEach(name => bus.on(name, render));
    return () => { events.forEach(name => bus.off(name, render)); };
  }, [bus]);
  useLayoutEffect(() => {
    for (const [page, host] of hosts.current) {
      const div = viewer.getPageView(page)?.div;
      if (div && host.parentElement !== div) div.append(host);
    }
  });
  useEffect(() => () => { hosts.current.forEach(host => host.remove()); }, []);
  return Array.from({ length: viewer.pagesCount }, (_, index) => {
    const view = viewer.getPageView(index), div = view?.div as HTMLElement | undefined;
    const surface = div?.querySelector('.canvasWrapper');
    if (!div || !surface || !view.viewport) return null;
    let host = hosts.current.get(index);
    if (!host) { host = document.createElement('div'); hosts.current.set(index, host); }
    const box = surface.getBoundingClientRect(), pageBox = div.getBoundingClientRect();
    return { index, host, viewport: view.viewport, style: { left: box.left - pageBox.left - div.clientLeft, top: box.top - pageBox.top - div.clientTop, width: box.width, height: box.height } };
  }).filter(value => value !== null);
}
