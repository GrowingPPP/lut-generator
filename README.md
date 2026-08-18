# CHROMA — 松下 LUT 生成器

用自然语言生成适配松下 Lumix 相机的 `.cube` LUT 文件。拍照直出带 LUT 滤镜的照片,支持机内烧录(Real-Time LUT)与后期软件两用。

## 功能

- **会话式 LUT 生成**:描述想要的风格(如「日系清透」「电影青橙」),大模型多轮确认后生成 `.cube` 文件
- **LUT 管理**:个人 LUT 的增删改查,下载机内版(带松下头)与后期版
- **实时预览**:上传样张,滑动对比 / 独立展示两种形式
- **精细调色**:11 个参数 —— 基准照片风格、色温、色调、曝光、对比度、饱和度、色相、自然饱和度、暗部/中间调/亮部(R/G/B 三通道)

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite + WebGL2(3D LUT GPU 叠加) |
| 后端 | Python 3.11+ + FastAPI |
| 会话编排 | LangGraph + LangChain(LLM 可插拔,默认 DeepSeek) |
| 存储 | MySQL 8.0 |
| LUT 引擎 | numpy 自研参数化 3D LUT(33³) |

## 目录结构

```
├── backend/
│   ├── lut_engine/        # LUT 引擎(纯库):参数 → 3D LUT → .cube
│   ├── agent/             # LangGraph 会话编排 + 可插拔 LLM
│   ├── api/               # FastAPI 路由
│   ├── storage/           # MySQL 存储
│   ├── tests/             # 后端测试
│   └── requirements.txt
├── frontend/
│   ├── src/lib/           # lutEngine.js(JS LUT 引擎)、lutPreview.js(WebGL2)
│   ├── src/App.jsx        # 生成页 + 管理页
│   └── prototype/         # UI 原型(HTML)
├── Makefile               # 启动/停止/测试脚本
└── .apikey                # DeepSeek API key(不入库)
```

## 环境要求

- Python 3.11+
- Node 18+
- MySQL 8.0

## 快速开始

```bash
# 1. 初始化 MySQL 数据库(默认 root/123456/chroma,可环境变量覆盖)
make db-init

# 2. 安装前后端依赖
make install

# 3. 配置 DeepSeek key(项目根 .apikey,内容为 sk-xxx)
echo "sk-你的key" > .apikey

# 4. 启动前后端
make dev
# 访问 http://localhost:5173
```

停止 / 重启 / 测试:

```bash
make stop      # 停止前后端
make restart   # 重启
make test      # 运行后端测试
```

## 配置

### LLM(默认 DeepSeek)

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `CHROMA_LLM_MODEL` | 模型名 | `deepseek-chat` |
| `CHROMA_LLM_BASE_URL` | API 地址 | `https://api.deepseek.com` |
| `CHROMA_LLM_API_KEY` | API key | 读 `.apikey` |

key 优先级:`CHROMA_LLM_API_KEY` > 项目根 `.apikey` > `OPENAI_API_KEY`。换其他 OpenAI 兼容服务只需改这三个环境变量。

### MySQL

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `MYSQL_HOST` | 主机 | `localhost` |
| `MYSQL_PORT` | 端口 | `3306` |
| `MYSQL_USER` | 用户 | `root` |
| `MYSQL_PASSWORD` | 密码 | `123456` |
| `MYSQL_DATABASE` | 数据库 | `chroma` |

## 使用说明

1. **生成**:描述风格 → 大模型展示理解到的参数请你确认 → 确认后生成 LUT
2. **预览**:上传相机直出 JPEG(Standard 基准),拖动分割线对比原图与 LUT 效果
3. **保存/下载**:保存到「我的 LUT」,下载机内版(导入 S5M2 等)或后期版(DaVinci/PR)
4. **管理**:在「我的 LUT」查看缩略图、预览、改名、删除

## 松下相机适配说明

- 输出 `.cube` 3D LUT(33 点),机内版注入 `#LUMIXPHOTOSTYLE` 头信息
- 基准照片风格决定 LUT 输入侧:Standard/Natural/Vivid(照片),V-Log(视频,待实现)
- 机内烧录(Real-Time LUT)支持 S5M2 / S5M2X / G9M2;S5 / GH6 等仅机内监视

## 测试

```bash
make test
```

后端测试覆盖:LUT 引擎数学正确性、`.cube` 序列化、API CRUD、LangGraph 会话流程。
