// node-unrar-js 2.x 未随包发布类型声明，此处按 dist/js/Extractor.d.ts 声明本项目用到的最小面
declare module 'node-unrar-js' {
	export interface UnrarFileHeader {
		name: string;
		flags: { encrypted: boolean; solid: boolean; directory: boolean };
	}
	export interface UnrarArcHeader {
		flags: {
			volume: boolean;
			lock: boolean;
			solid: boolean;
			headerEncrypted: boolean;
		};
	}
	export function createExtractorFromData(opts: {
		data: ArrayBuffer;
		wasmBinary?: ArrayBuffer;
		password?: string;
	}): Promise<{
		getFileList(): { arcHeader: UnrarArcHeader; fileHeaders: Generator<UnrarFileHeader> };
		extract(opts?: {
			files?: string[] | ((fh: UnrarFileHeader) => boolean);
			password?: string;
		}): {
			arcHeader: UnrarArcHeader;
			files: Generator<{ fileHeader: UnrarFileHeader; extraction?: Uint8Array }>;
		};
	}>;
}
