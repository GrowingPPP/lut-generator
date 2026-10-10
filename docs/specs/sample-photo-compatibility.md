# 相机样张上传与预览兼容修复

日期：2026-10-10。

## 问题与复现

用户选择 `~/Downloads/_1026453.JPG` 后，对比区域没有显示这张照片。实际浏览器上传返回 HTTP 400，画布仍显示合成示意图。修复前以“所选文件名和真实照片必须同时可见”为断言的浏览器脚本失败。

诊断该文件得到以下信息：

| 项目 | 实际内容 |
|---|---|
| 相机 | Panasonic DC-S5M2 |
| 大小 | 5,841,408 字节 |
| 主照片 | 4000 × 4000，MP 类型为 Baseline MP Primary Image |
| 辅助画面 | 1080 × 1080，MP 类型为 Large Thumbnail (Full HD Equivalent) |
| 文件识别 | 扩展名为 JPG，浏览器类型为 image/jpeg；Pillow 识别为 MPO |
| 色彩声明 | 没有内嵌 ICC；EXIF ColorSpace=65535、InteropIndex=R03，明确声明 Adobe RGB |

存在三个连续的阻塞：后端拒绝 MPO；后端不支持仅以 EXIF 明确声明的 Adobe RGB；新上传照片未确认输入时，前端用提示占位，无法直接查看原图。

独立复核另发现，版本 A/B 比较状态会遮住新上传照片；低高度照片区可能截断确认控件下方的色彩说明。两项已复现并修复。

## 处理方案与边界

### 主照片和辅助缩略图

接受具有有效 MPF 索引的一张主照片加辅助 JPEG 缩略图。校验每帧角色、长度、偏移、范围、重叠和 JPEG 起止标记，读取第 0 帧作为主照片。验证辅助帧时只读取 JPEG 头，不解码辅助像素。

立体、多角度、多主画面、角色不明和损坏索引的 MPO 继续拒绝；动图、多页 TIFF、文件大小和主照片像素限制继续生效。不能通过只改扩展名绕过这些限制。

### 色彩归一化

普通照片先使用有效内嵌 ICC。没有 ICC 且 ColorSpace=65535、InteropIndex=R03 一致时，按标准 Adobe RGB (1998) 转换到 sRGB。定义采用 D65 原色及白点、563/256 解码指数、线性矩阵转换、目标范围裁切和 sRGB 编码；浮点临时内存按块限制。运行时不依赖操作系统的 ICC 文件。

损坏 ICC 不回退到 EXIF；不明或冲突的色彩声明继续拒绝。分别捕获 EXIF 与 Interop 读取异常，避免 Interop 缺失时丢失已取得的 ColorSpace。V-Log 分支继续优先保留原信号。

预览、照片统计、参考匹配和照片导出共用同一解码入口。新状态 `converted_adobe_rgb` 在照片详情及上传确认区显示“已按照片声明将 Adobe RGB 转换为 sRGB”。目标工作空间和已有归一化元数据契约保持一致。

### 上传后的可见状态

- 上传成功后先显示规范化原图及文件名；尚未确认输入时，不叠加 LUT。
- 在原图下方直接选择拍摄时的 Photo Style，并点击“确认并查看对比”。EXIF 相机型号与色彩空间不能代替 Photo Style 确认。
- 改变照片输入时，使用原文件重新解码；照片输入与当前 LUT 不一致时显示核对动作。
- 旧缓存、缺少原文件及不兼容输入分别提示对应处理方式。
- 成功上传或重新绑定后返回当前编辑，避免版本比较遮住新图；失败上传保留原视图。
- 确认区允许内部滚动，低高度视图仍保留至少 80px 原图区和可达的确认控件。

## 验证结果

| 验证 | 结果 |
|---|---|
| 修复前反馈 | 实际原文件上传失败，浏览器断言失败；合法 MPO 与明确 Adobe RGB 的回归测试先失败 |
| 实际原文件上传 | HTTP 200；主图 4000 × 4000，规范化预览 2048 × 2048，状态 converted_adobe_rgb |
| 上传未确认 | 原图直接可见；输入选择与确认按钮就在照片下方 |
| 对比 | STD 测试输入确认后，滑动对比左右和独立展示两幅画面均显示实际照片；展示形式可往返切换 |
| 版本比较中上传 | 修复前新图被隐藏；修复后退出比较并显示新原图及确认入口 |
| 手机与低高度 | 390 × 844 下文档宽度等于 390px；180px 照片区内确认区可滚动，底部不超出舞台 |
| 实际 JPEG 导出 | 下载得到 4000 × 4000 JPEG，含 sRGB ICC，不含源 EXIF；未误用 1080 × 1080 辅助缩略图 |
| 后端相关回归 | 色彩归一化、Adobe RGB、HTTP、渲染与统计共 149 项通过；故意损坏 MPO 用例产生一项预期 Pillow 警告 |
| 前端回归 | 149 项通过 |
| 生产构建 | 通过 |
| 独立审查 | 后端转换无阻断问题；前端发现的两项 P2 已复现并修复 |

测试在临时工作区进行，完成后删除该工作区、会话和对应本机草稿，并恢复原工作区。诊断用原文件副本不加入项目。测试确认了读取、色彩转换、展示和导出链路；本轮未调用真实模型，艺术效果评价及实机导入仍按此前约定待办。

## 实现与规范依据

- [统一解码](../../backend/photo/color_management.py)、[Adobe RGB 转换](../../backend/photo/adobe_rgb.py)、[回归测试](../../backend/tests/test_adobe_rgb_photo.py)。
- [上传原图与确认](../../frontend/src/components/SampleInputPreview.jsx)、[生成页](../../frontend/src/App.jsx)、[工作台样式](../../frontend/src/GenerationWorkspace.css)。
- [Pillow MPO 文档](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html#mpo)、[CIPA MPF 规范](https://www.cipa.jp/std/documents/e/DC-X007_E.pdf)。
- [Adobe RGB (1998) 原始规范](https://www.adobe.com/digitalimag/pdfs/AdobeRGB1998.pdf)、[ICC sRGB 说明](https://registry.color.org/rgb-registry/files/sRGB.pdf)。
