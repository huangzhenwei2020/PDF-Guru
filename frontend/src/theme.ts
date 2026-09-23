/**
 * 主题切换。
 *
 * 分两块处理：
 * 1. **ant-design-vue 的组件样式**：它只提供两套整份 CSS（antd.css / antd.dark.css），
 *    没法在运行时切变量。做法是把暗色那份**按需**注入成 <style>，关掉时移除。
 *    用动态 import 而非常规 import，是为了不让 725KB 的暗色样式压到默认（亮色）首屏上。
 *    注入的 <style> 在 <head> 末尾，与同选择器优先级的亮色规则相比"后写者胜"，
 *    因此能覆盖；移除后立即回到亮色。这两份文件里的 url() 一个是内部 SVG 渐变、
 *    一个是 data URI，都不依赖外部文件，所以按文本注入是安全的。
 * 2. **我们自己写的颜色**：走 theme.css 里的 CSS 变量，
 *    只需在 <html> 上切 data-theme，不需要重建 DOM。
 */

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "pdfguru-theme";
const STYLE_ID = "antd-dark-theme";

let current: ThemeMode = "light";
/** 暗色样式文本的加载结果，避免重复 import */
let darkCssPromise: Promise<string> | null = null;

function loadDarkCss(): Promise<string> {
    if (!darkCssPromise) {
        darkCssPromise = import("ant-design-vue/dist/antd.dark.css?raw").then(
            (m: any) => (m?.default ?? "") as string
        );
    }
    return darkCssPromise;
}

function injectDarkStyle(css: string) {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
}

function removeDarkStyle() {
    document.getElementById(STYLE_ID)?.remove();
}

/**
 * 应用主题：先同步切变量，再异步注入组件库的暗色样式。
 *
 * 变量切换必须是同步的（挂载前就要设好 data-theme，否则深色用户会看到一瞬间亮色）；
 * 组件库那 725KB 的样式则按需异步加载。调用方不需要 await。
 */
export function applyThemeVars(mode: ThemeMode) {
    current = mode;
    document.documentElement.dataset.theme = mode;
}

export function applyTheme(mode: ThemeMode): Promise<void> {
    applyThemeVars(mode);
    return (async () => {
        try {
            if (mode === "dark") {
                injectDarkStyle(await loadDarkCss());
            } else {
                removeDarkStyle();
            }
        } catch (e) {
            // 暗色样式加载失败不该让界面卡住：变量已经切了，组件库保持亮色而已
            console.error("加载暗色主题样式失败:", e);
        }
    })();
}

export function getTheme(): ThemeMode {
    return current;
}

export function setTheme(mode: ThemeMode) {
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) {
        // 隐私模式等场景下 localStorage 可能不可用，忽略即可
    }
    void applyTheme(mode);
}

/** 同步读取上次选择，供挂载前设置 data-theme 使用。 */
export function readStoredTheme(): ThemeMode {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === "dark" || saved === "light") return saved;
    } catch (e) {
        /* 忽略 */
    }
    return "light";
}
