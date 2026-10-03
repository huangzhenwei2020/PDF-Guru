type Rect = { left: number; top: number; width: number; height: number };

/** Keep the document point beneath the pointer fixed after its layout changes. */
export function zoomAnchorScroll(
    scroll: { left: number; top: number },
    pointer: { x: number; y: number },
    before: Rect,
    after: Rect
): { left: number; top: number } {
    if (before.width <= 0 || before.height <= 0) return scroll;
    const x = (pointer.x - before.left) / before.width;
    const y = (pointer.y - before.top) / before.height;
    return {
        left: scroll.left + after.left + x * after.width - pointer.x,
        top: scroll.top + after.top + y * after.height - pointer.y,
    };
}
