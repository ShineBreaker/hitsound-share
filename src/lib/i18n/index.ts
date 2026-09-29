// 极简 i18n：字典查键 + {name} 占位符插值，无运行时依赖
import zh from './zh';

export type Locale = 'zh' | 'en';

// 预留 en：加字典文件后在此注册即可
const dicts: Partial<Record<Locale, zh.Dict>> = { zh };

let current: Locale = 'zh';

/** 切换语言（预留） */
export function setLocale(locale: Locale): void {
	if (dicts[locale]) current = locale;
}

/** 取文案；缺失时回退 zh，再缺失返回键名本身（便于发现漏翻） */
export function t(key: keyof zh.Dict, params?: Record<string, string | number>): string {
	const dict = (dicts[current] ?? zh) as Record<string, string>;
	let text = dict[key] ?? key;
	if (params) {
		for (const [name, value] of Object.entries(params)) {
			text = text.replaceAll(`{${name}}`, String(value));
		}
	}
	return text;
}
