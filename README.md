# MyApp · 网页版

用 Safari「添加到主屏幕」当作 App 使用的网页应用。纯静态，无构建步骤，不需要服务器。

## 为什么走这条路

| | 原生版（Swift） | 本网页版 |
|---|---|---|
| 桌面图标 | 需要签名 + 装 | 加到主屏幕即可 |
| 7 天过期 | 会 | **永不过期** |
| 花钱 | 不花，但折腾 | **不花，不折腾** |
| Apple ID / 开发者模式 | 要用 | **完全不需要** |
| 系统能力 | 全部 | 受限（无蓝牙、后台任务等） |

## 目录

```
WebApp/
├── index.html              页面结构
├── style.css               样式（含浅色/深色主题）
├── app.js                  交互逻辑 + 独立运行检测
├── sw.js                   离线缓存，断网也能打开
├── manifest.webmanifest    PWA 清单（决定图标与全屏行为）
├── make_icons.py           图标生成脚本（纯标准库）
└── icons/                  180 / 192 / 512 三种尺寸
```

## 加功能往哪写

- 新页面 → 在 `index.html` 里加一个 `<section class="screen" id="screen-xxx">`，再在底部 `.tabbar` 里加一个按钮
- 新页面的标题 → `app.js` 顶部的 `TITLES` 对象里加一条
- 改配色 → `style.css` 顶部的 CSS 变量（浅色/深色两套）
- 改 App 名字 / 图标 → 「设置 → 通用 → 网站设置」里清掉缓存重新添加；名字在 `manifest.webmanifest` 和 `index.html` 的 `apple-mobile-web-app-title`
- 改完记得把 `sw.js` 里的 `CACHE = 'myapp-v1'` 版本号 +1，否则 iPad 上可能还读旧缓存

## 部署

推到 GitHub 的 `main` 分支，GitHub Pages 自动发布。仓库 Settings → Pages 里可确认。

## 怎么加到主屏幕

Safari 打开网址 → 底部（iPad 在顶部）**分享按钮** → 向下找到 **「添加到主屏幕」** → 确认。

必须用 **Safari**，Chrome 或微信内置浏览器加不出独立 App 效果。
