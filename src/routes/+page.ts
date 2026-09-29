// 根页面 shell 预渲染：静态 HTML 走 Pages 免费静态请求，省 Functions 配额；
// API 路由（+server.ts）不受影响，不会预渲染
export const prerender = true;
