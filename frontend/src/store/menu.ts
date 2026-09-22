import { defineStore } from "pinia";

interface MenuState {
    rootSubmenuKeys: string[];
    openKeys: string[];
    selectedKeys: string[];
}

export const useMenuState = defineStore("menuState", {
    state: (): MenuState => ({
        // 工作区是默认落地页；老的功能列表退到「工具箱」并与工作区并存
        rootSubmenuKeys: ['workspace', 'index', 'page_edit', 'protect', 'other', "settings"],
        selectedKeys: ["workspace"],
        openKeys: ["workspace"]
    }),
    getters: {

    },
    actions: {
        resetState() {
            this.openKeys = ["workspace"];
            this.selectedKeys = ["workspace"];
        },
        onOpenChange(openKeys: string[]) {
            const latestOpenKey = openKeys.find(key => this.openKeys.indexOf(key) === -1);
            if (this.rootSubmenuKeys.indexOf(latestOpenKey!) === -1) {
                this.openKeys = openKeys;
            } else {
                this.openKeys = latestOpenKey ? [latestOpenKey] : [];
            }
        },
    }
})