// 全局 UI 状态：帮助对话框 / 新手引导 / 页面数据就绪（引导只在就绪后自动启动）

export const TOUR_LS_KEY = 'hs_tour_v1'; // 引导完成标记（跳过/完成都置位）

export const ui = $state({
	helpOpen: false,
	tourActive: false,
	pageReady: false // +page 树 + 首包文件加载完成后置位
});

/** 是否已看过引导（每次直读 localStorage；SSR/隐私模式按未看过处理） */
export function tourDone(): boolean {
	try {
		return globalThis.localStorage?.getItem(TOUR_LS_KEY) === '1';
	} catch {
		return false;
	}
}

export function startTour(): void {
	ui.tourActive = true;
}

/** 跳过/完成都走这里：置已看标记并关闭 */
export function endTour(): void {
	ui.tourActive = false;
	try {
		globalThis.localStorage?.setItem(TOUR_LS_KEY, '1');
	} catch {
		/* 隐私模式等：忽略写入失败 */
	}
}
