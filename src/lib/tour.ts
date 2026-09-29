// 新手引导步骤清单（目标用 data-tour 属性定位）+ 可见性过滤。
// 纯模块：不碰 DOM/组件状态，visibleSteps 由组件传入选择器存在性判定
import { t } from './i18n';

export interface TourStep {
	sel: string; // CSS 选择器（data-tour 目标）
	title: string;
	body: string;
}

export const TOUR_STEPS: TourStep[] = [
	{ sel: '[data-tour="tree"]', title: t('tour.tree.title'), body: t('tour.tree.body') },
	{ sel: '[data-tour="files"]', title: t('tour.files.title'), body: t('tour.files.body') },
	{ sel: '[data-tour="select"]', title: t('tour.select.title'), body: t('tour.select.body') },
	{ sel: '[data-tour="kit"]', title: t('tour.kit.title'), body: t('tour.kit.body') },
	{ sel: '[data-tour="packdl"]', title: t('tour.packdl.title'), body: t('tour.packdl.body') },
	{ sel: '[data-tour="upload"]', title: t('tour.upload.title'), body: t('tour.upload.body') },
	{ sel: '[data-tour="help"]', title: t('tour.help.title'), body: t('tour.help.body') }
];

/** 过滤掉页面上不存在的目标（如上传未启用时无上传按钮） */
export function visibleSteps(steps: TourStep[], exists: (sel: string) => boolean): TourStep[] {
	return steps.filter((s) => exists(s.sel));
}
