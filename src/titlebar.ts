/** Electron reads draggable regions from the window document. Mirror the reader's title bar
 * geometry there, leaving its buttons and the native window controls interactive. */
export function trackTitlebar(header: HTMLElement) {
  const host = window.parent.document;
  const area = host.createElement("div");
  area.className = "window-drag-area";
  area.setAttribute("aria-hidden", "true");
  host.body.append(area);
  const controls = header.querySelectorAll<HTMLElement>(".brand, .icon-btn, .segmented");
  const update = () => {
    const style = getComputedStyle(header);
    const left = parseFloat(style.paddingLeft);
    area.style.insetInline = left + "px " + style.paddingRight;
    area.style.height = header.clientHeight + "px";
    area.replaceChildren(...Array.from(controls, button => {
      const { left: x, width } = button.getBoundingClientRect();
      const hole = host.createElement("span");
      hole.style.left = x - left + "px";
      hole.style.width = width + "px";
      return hole;
    }));
  };
  const observer = new ResizeObserver(update);
  observer.observe(header);
  controls.forEach(button => observer.observe(button));
  update();
  return () => { observer.disconnect(); area.remove(); };
}
