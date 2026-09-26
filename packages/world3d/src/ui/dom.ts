/** A DOM element with properties and children (same helper as tui-web's main.ts). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
}

/** Plays a line's audio clip if the course has one; no clips exist yet, so usually a no-op. */
export function playAudio(id: string | undefined, base = "audio"): void {
  if (!id) return;
  try {
    void new Audio(`${base}/${id}`).play().catch(() => {});
  } catch {
    // no audio support: nothing to do
  }
}
