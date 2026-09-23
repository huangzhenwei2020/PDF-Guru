import { createApp } from 'vue';
import App from './App.vue';
import { createPinia } from "pinia";
import Antd from "ant-design-vue";
import "ant-design-vue/dist/antd.css";
import "./theme.css";
import { applyTheme, applyThemeVars, readStoredTheme } from "./theme";
import { installDropFix } from "./dropfix";

// 修掉 Wails 拖放的 bug（非文件条目会被映射成 undefined 一起发给 WebView2）。
// 必须尽早装上：拖放随时可能发生，而它只是替换一个函数，没有副作用。
installDropFix();

// 主题：变量必须在挂载前同步设好，否则深色用户会看到一瞬间的亮色。
// 组件库那 725KB 的暗色样式是异步加载的，挂载后再注入即可——它只影响 .ant-* 的配色，
// 晚几十毫秒不影响使用。
//
// 注意：不要为了"等主题就绪"而把 mount 放进 Promise 回调里。之前那样试过，
// 结果工作区的缩略图与大图两个异步链都不再返回（后端其实已经渲染完了）。
const mode = readStoredTheme();
applyThemeVars(mode);

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(Antd);
app.mount("#app");

void applyTheme(mode);
