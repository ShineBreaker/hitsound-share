import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

/**
 * node-unrar-js 的 emscripten 运行时有两处依赖 new Function 动态求值（createNamedFunction
 * 与 craftInvokerFunction 的 invoker 装配），站点 CSP 不含 unsafe-eval，浏览器实测报
 * "call to Function() blocked by CSP"。构建期把这两处替换为闭包等价实现：
 * 具名仅影响调试堆栈（defineProperty 补 name）；invoker 的参数个数检查 / wire 转换 /
 * 析构顺序逐行对应原字符串拼接逻辑。依赖升级若改动源码形态，下面的精确匹配会 miss
 * 并让构建直接失败——届时按新版源码同步更新替换串（也可退而放宽 CSP 加 unsafe-eval）。
 */
const UNRAR_EVAL_FIXES: Array<[orig: string, fixed: string]> = [
	[
		String.raw`function createNamedFunction(name,body){name=makeLegalFunctionName(name);return new Function("body","return function "+name+"() {\n"+'    "use strict";'+"    return body.apply(this, arguments);\n"+"};\n")(body)}`,
		`function createNamedFunction(name,body){name=makeLegalFunctionName(name);var fn=function(){"use strict";return body.apply(this,arguments)};try{Object.defineProperty(fn,"name",{value:name,configurable:true})}catch(e){}return fn}`
	],
	[
		`args1.push(invokerFnBody);var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}`,
		// IIFE 内捕获 emscripten 模块作用域里的 throwBindingError / runDestructors /
		// makeLegalFunctionName；wired 下标 = isClassMethodFunc 时整体右移一位（thisWired 占首位）
		`var invokerFunction=(function(humanName,argTypes,isClassMethodFunc,needsDestructorStack,returns,invoker,fn){var argCount=argTypes.length;var f=function(){if(arguments.length!==argCount-2){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+(argCount-2)+" args!")}var dtorStack=needsDestructorStack?[]:null;var wired=[];if(isClassMethodFunc){wired.push(argTypes[1].toWireType(dtorStack,this))}for(var i=0;i<argCount-2;i++){wired.push(argTypes[i+2].toWireType(dtorStack,arguments[i]))}var rv=invoker.apply(null,[fn].concat(wired));if(needsDestructorStack){runDestructors(dtorStack)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(wired[isClassMethodFunc?i-1:i-2])}}}if(returns){return argTypes[0].fromWireType(rv)}};try{Object.defineProperty(f,"name",{value:makeLegalFunctionName(humanName),configurable:true})}catch(e){}return f})(humanName,argTypes,isClassMethodFunc,needsDestructorStack,returns,cppInvokerFunc,cppTargetFunc);return invokerFunction}`
	]
];

/** 应用替换并强校验（导出供回归脚本复用）；任一片段 miss 即抛错，绝不静默放过 */
export function applyUnrarEvalFix(code: string): string {
	let out = code;
	for (const [orig, fixed] of UNRAR_EVAL_FIXES) {
		if (!out.includes(orig))
			throw new Error(`unrar CSP 修复片段未命中（node-unrar-js 源码形态已变化）：${orig.slice(0, 60)}…`);
		out = out.replace(orig, () => fixed);
	}
	return out;
}

function unrarCspFix(): Plugin {
	return {
		name: 'unrar-csp-fix',
		transform(code, id) {
			if (id.includes('node-unrar-js') && /(^|[\\/])unrar\.js$/.test(id))
				return { code: applyUnrarEvalFix(code), map: null };
		}
	};
}

export default defineConfig({
	plugins: [sveltekit(), unrarCspFix()],
	// 该依赖不能进 dev 预打包：esbuild 预打包管线不执行 vite 插件 transform，
	// 上面的 CSP 替换会失效；排除后走 dev server 模块管线，dev / build 行为一致
	optimizeDeps: { exclude: ['node-unrar-js'] },
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
