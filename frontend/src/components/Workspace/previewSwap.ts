/** Keep the displayed raster until its replacement is decoded, and reject stale work. */
export function createPreviewSwap(load: (url: string) => Promise<void>, show: (url: string) => void) {
    let revision = 0;
    return {
        invalidate() { return ++revision; },
        async replace(url: string, ticket = ++revision) {
            await load(url);
            if (ticket !== revision) return false;
            show(url);
            return true;
        },
    };
}
