// 桌面壳：装载 frontendDist 静态产物 + 三个登录增强——
//  ① opener 插件：桌面登录入口在系统浏览器完成 osu! 授权（授权页不嵌套在 WebView 内，
//     已验证会话/密码管理器都是系统浏览器的，账号体验完整）；
//  ② 深链回收：OS 以 `hitsound://auth/?hs_code=…`（自定义 scheme）拉起本进程，把回调
//     的 path+query 重写为应用内路径 `/?hs_code=`——落地页既有 exchange 链路换会话
//     token 存 localStorage，此后走 x-hs-session 头。服务端零改动：CORS_ORIGINS 白名单
//     加一条 `hitsound://auth` 即可（login/callback 只做小写 origin 字符串匹配；302 到
//     自定义 scheme 是浏览器顶层导航，不涉 CORS 响应头）；
//  ③ single-instance 插件：深链热投递（应用已在运行）由第二进程转发给首个实例完成导航
//     后退出，登录不裂出第二个窗口。
// 前置：tauri.conf.json > plugins.deep-link.desktop.schemes = ["hitsound"]，deb 打包器
// 据此生成 .desktop 的 MimeType=x-scheme-handler/hitsound；Exec 的 %u 经定制 desktop 模板
// 补齐（默认模板不带，URL 就不会进 argv）——运行时事件由 argv 解析承担，故不装 deep-link crate。
// 壳的业务面与 Web 版完全一致，登录态见 docs/desktop.md。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Runtime, Url};

/// 深链 scheme 前缀（与 tauri.conf.json schemes[0] 一致）：browser → OS → argv 的回调载体
const DEEP_LINK_SCHEME: &str = "hitsound://";
/// 深链权威段（与 CORS_ORIGINS 白名单条目 `hitsound://auth` 的 host 一致）
const DEEP_LINK_AUTHORITY: &str = "auth";

pub fn run() {
	// 冷启动投递的深链：应用未运行时 OS 用它拉起本进程；运行中投放由 single-instance 转发
	let pending = deep_link_path(std::env::args());

	tauri::Builder::default()
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
			// 热投递：本闭包跑在首个实例里（第二进程随后退出）——同窗口完成登录
			if let Some(path) = deep_link_path(argv.into_iter()) {
				navigate_deep_link(app, &path);
			}
		}))
		.setup(move |app| {
			if let Some(path) = pending {
				navigate_deep_link(app, &path);
			}
			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}

/** 深链 path+query → 应用内路径导航：`hitsound://auth/?hs_code=…` → `/?hs_code=…`。
 *  origin 取当前 WebView URL 串切（tauri: 是非特殊 scheme，Url::origin() 为 opaque，
 *  ascii_serialization 会 panic；Linux/macOS 是 tauri://localhost、Windows 是
 *  http://tauri.localhost——不写死，跨平台拼回）。URL 构造失败静默（按普通启动继续）。 */
fn navigate_deep_link<R: Runtime, M: Manager<R>>(manager: &M, path: &str) {
	if let Some(webview) = manager.get_webview_window("main") {
		if let Ok(current) = webview.url() {
			let origin = origin_of(&current);
			if let Ok(url) = Url::parse(&format!("{origin}{path}")) {
				let _ = webview.navigate(url);
			}
		}
	}
}

/** argv 深链 → 应用内 path+query（`hitsound://auth/?hs_code=…` → `/?hs_code=…`）。
 *  校验只到「确是本 scheme + auth 权威段 + 拼回应用自身 origin」：查询键一律原样透传，
 *  hs_code 的真伪由落地页交服务端 HMAC 验签（60s 时效）；URL 构造失败返回 None，
 *  应用按普通启动继续。非深链启动（无参/普通文件参数）零影响。 */
fn deep_link_path(args: impl Iterator<Item = String>) -> Option<String> {
	let raw = args
		.map(|a| a.trim().to_string())
		.find(|a| a.to_ascii_lowercase().starts_with(DEEP_LINK_SCHEME))?;
	let after = &raw[DEEP_LINK_SCHEME.len()..];
	let (authority, rest) = after.split_once('/')?;
	if !authority.eq_ignore_ascii_case(DEEP_LINK_AUTHORITY) {
		return None;
	}
	// split_once 吃掉分隔斜杠，这里补回——rest 是 path+query（"?…" 或 "/…?…"）
	Some(if rest.is_empty() { "/".to_string() } else { format!("/{rest}") })
}

/** URL 的 origin 串（scheme://host[:port]）：从非特殊 scheme 的 URL 字符串里切。
 *  WebView 当前 URL 即应用自身协议根，深链 path 拼回它——跨平台不写死。 */
fn origin_of(url: &Url) -> String {
	let s = url.as_str();
	let host_start = s.find("://").map(|i| i + 3).unwrap_or(0);
	match s[host_start..].find('/') {
		Some(i) => s[..host_start + i].to_string(),
		None => s.to_string()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn argv(url: &str) -> Vec<String> {
		vec!["/usr/bin/hitsound-share".into(), url.into()]
	}

	fn path(arg: &str) -> Option<String> {
		deep_link_path(argv(arg).into_iter())
	}

	#[test]
	fn rewrites_callback_to_app_path() {
		assert_eq!(path("hitsound://auth/?hs_code=abc.def").as_deref(), Some("/?hs_code=abc.def"));
		assert_eq!(path("hitsound://auth/route?a=1&b=2").as_deref(), Some("/route?a=1&b=2"));
	}

	#[test]
	fn root_forms() {
		assert_eq!(path("hitsound://auth/").as_deref(), Some("/"));
		assert!(path("hitsound://auth").is_none()); // 无 path：普通启动，不导航
	}

	#[test]
	fn rejects_non_deep_link_args() {
		assert!(path("https://evil.example.com/?hs_code=x").is_none());
		assert!(path("file:///etc/passwd").is_none());
		assert!(path("hitsound://other/?hs_code=x").is_none()); // 权威段不符（白名单外）
		assert!(deep_link_path(vec![].into_iter()).is_none());
		assert!(deep_link_path(vec!["/usr/bin/hitsound-share".into()].into_iter()).is_none());
	}

	#[test]
	fn scheme_and_authority_case_insensitive() {
		assert_eq!(path("HITSOUND://AUTH/?hs_code=abc").as_deref(), Some("/?hs_code=abc"));
	}

	#[test]
	fn percent_encoding_preserved_verbatim() {
		// 查询键原样透传，解码交给前端 URLSearchParams（与同源 Web 行为一致）
		assert_eq!(path("hitsound://auth/?hs_code=a%2Bb%20c").as_deref(), Some("/?hs_code=a%2Bb%20c"));
	}

	#[test]
	fn surrounding_argv_whitespace_tolerated() {
		assert_eq!(deep_link_path(vec!["hitsound://auth/?hs_code=x ".into()].into_iter()).as_deref(), Some("/?hs_code=x"));
	}

	#[test]
	fn origin_of_both_platform_roots() {
		let linux: Url = "tauri://localhost/index.html".parse().unwrap();
		assert_eq!(origin_of(&linux), "tauri://localhost");
		let windows: Url = "http://tauri.localhost/index.html".parse().unwrap();
		assert_eq!(origin_of(&windows), "http://tauri.localhost");
		let with_port: Url = "http://tauri.localhost:8080/a?b=1".parse().unwrap();
		assert_eq!(origin_of(&with_port), "http://tauri.localhost:8080");
	}

	#[test]
	fn rewrite_target_joins_origin_and_path() {
		let origin = origin_of(&"tauri://localhost/index.html".parse::<Url>().unwrap());
		let p = path("hitsound://auth/?hs_code=abc.def").unwrap();
		assert_eq!(format!("{origin}{p}"), "tauri://localhost/?hs_code=abc.def");
	}
}
