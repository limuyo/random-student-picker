# Random Student Picker (Honor of Kings) 🎯

**一个 HTML 文件，双击就能用的班级随机点名网页。** 单人抽取是 CS:GO 开箱式的滚动开箱，多人抽取是老虎机式滚轮；全班头像以王者荣耀英雄皮肤铺场，随机流动、减速、定格。

- 🎁 **最快上手**：到 [Releases](../../releases) 下载 `RandomStudentPicker.html` 这一个文件，双击打开，导入名单即抽——不用安装、不用克隆仓库
- 🌐 **或者在线使用**：开启 GitHub Pages 后直接访问（见下文）
- 🔒 名单、历史全部存在本机浏览器，不上传任何服务器
- 📜 代码 MIT 开源；王者荣耀头像素材版权归腾讯，仅供教学演示

## 快速开始（30 秒）

1. 到 [**Releases** 页面](../../releases) 下载 `RandomStudentPicker.html`（约 2.7 MB，全部头像已打包进这一个文件）
2. 双击用 Chrome / Edge 打开
3. 粘贴名单（每行一条 `学号,姓名`，也支持只写姓名；逗号、中文逗号、Tab、分号、空格都能自动识别），点「保存名单」
4. 点「开始点名」——单人开箱式抽取；切「多人」可一次抽 2–5 人（老虎机式）

> 💡 名单也可以从 Excel 复制两列直接粘贴，GBK / UTF-8 编码的 csv / txt 文件都能读；「名单与设置」里可以下载示例名单模板。

## 玩法说明

- **单人（开箱式）**：头像长带在金色准线下高速流动，约 2 秒减速定格，抽中的头像放大 1.12 倍压在准线上；点击空白处可立即揭晓
- **多人（老虎机）**：2–5 个滚轮同时滚动、错峰停止，逐轮落定中奖名单
- **不重复模式**：点过的同学不再被抽中（头像墙中置灰），一轮抽完自动询问是否重置
- **沉浸氛围**：抽取时全屏暗角压入、全屏金线贯穿，定格带微震与合成音效（可在顶栏关音效）
- **历史记录**：每次抽取的时间与姓名，可查看、清空
- 每次抽取都会随机换一批头像

## 在线使用（GitHub Pages）

把本仓库推送到 GitHub 后，在仓库 **Settings → Pages → Source 选 main 分支根目录**，即可通过
`https://<用户名>.github.io/<仓库名>/` 在线使用（多文件版本，与单文件功能一致）。

## 名单格式

```
学号,姓名
2024001,张三
2024002,李四
```

- 只写姓名（每行一个名字）也可以，学号可省略
- 表头行（如 `学号,姓名`）自动跳过；格式错误的行会标红提示
- 学号 + 姓名都相同的行视为重复
- 暂不解析带引号的 CSV 字段（姓名含逗号请换分隔符）

## 自定义头像

头像图片在 `assets/avatars/`（当前为王者荣耀英雄头像，共 114 张），清单在 `js/avatars.js`。换成自己素材的两种方式：

1. **合集大图自动切分**：`python tools/slice_avatars.py 新合集图.png`（需 Python 3 + Pillow + numpy）
2. **手动放图**：把 PNG 放进 `assets/avatars/`，在 `js/avatars.js` 里增删路径

改完头像后若想要单文件版，运行 `python tools/build_single.py` 重新打包。

## 目录结构

```
random-student-picker/
├── index.html              # 网页入口（多文件版，GitHub Pages 用）
├── dist/                   # 单文件版（构建产物，见 Releases）
├── css/                    # 全局主题 + 两个滚动组件样式
├── js/                     # 名单解析 / 音效 / 头像墙 / 滚动组件 / 主程序
├── assets/avatars/         # 英雄头像（114 张）
├── tools/
│   ├── slice_avatars.py    # 头像合集切分脚本
│   ├── build_single.py     # 单文件版打包脚本
│   └── dev/                # 组件自测页
├── students.example.csv    # 示例名单模板
├── LICENSE                 # MIT
└── README.md
```

## 技术说明

- 原生 HTML + CSS + JavaScript，无依赖、无构建、无框架，`file://` 双击可用
- 滚动动画 rAF 自绘缓动（只动 transform/opacity），快速段带速度感应运动模糊
- 音效由 Web Audio 实时合成：whoosh 起手、速度感应滚动声、定格咔哒、揭晓和弦
- 支持 `prefers-reduced-motion`

## 许可证与素材版权

- 代码以 [MIT](LICENSE) 协议开源
- **`assets/avatars/` 中的王者荣耀英雄头像版权归腾讯所有**，素材来源于爱给网（aigei.com），仅用于教学演示，请勿商用；商用请替换为自有版权素材
