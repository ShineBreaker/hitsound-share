// UnRAR wasm（约 200KB）按需加载：Vite 把它 emit 成静态资源，真正遇到 rar 包时才同源拉取。
// 刻意独立成模块隔离 Vite 的 `?url` 语法——archive.ts 保持环境无关，测试脚本可直接在 Node 跑。
import unrarWasmUrl from 'node-unrar-js/dist/js/unrar.wasm?url';

export function loadUnrarWasm(): Promise<ArrayBuffer> {
	return fetch(unrarWasmUrl).then((r) => {
		if (!r.ok) throw new Error(`拉取 unrar.wasm 失败：${r.status}`);
		return r.arrayBuffer();
	});
}
