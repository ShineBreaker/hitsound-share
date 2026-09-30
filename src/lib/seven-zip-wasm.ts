// 7-Zip wasm（约 1.6MB）按需加载：同 unrar-wasm 的模式，真正遇到 7z 包时才同源拉取。
// 刻意独立成模块隔离 Vite 的 `?url` 语法——archive.ts 保持环境无关，测试脚本可直接在 Node 跑。
import szWasmUrl from '7z-wasm/7zz.wasm?url';

export function load7zWasm(): Promise<ArrayBuffer> {
	return fetch(szWasmUrl).then((r) => {
		if (!r.ok) throw new Error(`拉取 7zz.wasm 失败：${r.status}`);
		return r.arrayBuffer();
	});
}
