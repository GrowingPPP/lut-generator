# CHROMA — 松下 LUT 生成器

用自然语言生成适配松下 Lumix 相机的 `.cube` LUT 文件。拍照直出带 LUT 滤镜的照片,支持机内烧录(Real-Time LUT)与后期软件两用。

## 功能

- **会话式 LUT 生成**:描述想要的风格(如「日系清透」「电影青橙」),大模型多轮确认后生成 `.cube` 文件
- **LUT 管理**:个人 LUT 的增删改查,下载机内版(带松下头)与后期版
- **实时预览**:上传样张,滑动对比 / 独立展示两种形式
- **精细调色**:22 个参数,按组折叠 —— 基础(色温/色调/曝光)、影调(对比度/高光/阴影/白场/黑场/S 曲线)、色彩(饱和度/自然饱和/色相)、分离色调(阴影与高光分别染色)、分通道(暗部/中间调/亮部 × R/G/B)、基准照片风格与 V-Log 高光映射

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite + WebGL2(3D LUT GPU 叠加) |
| 后端 | Python 3.11+ + FastAPI |
| 会话编排 | 显式流程(agent/graph.py)+ 官方 openai SDK 的 tool calling(默认 DeepSeek) |
| 存储 | MySQL 8.0 |
| LUT 引擎 | numpy 自研参数化 3D LUT(33³) |

> 参数提取走 **tool calling** 而非「要求模型输出 JSON 再正则解析」:工具入参由服务端按 JSON Schema 约束,
> 且 schema 直接由 `agent/schemas.py` 的 pydantic 模型生成,模型可见约束与校验逻辑共用一份定义。

## 目录结构

```
├── backend/
│   ├── lut_engine/        # LUT 引擎(纯库):参数 → 3D LUT → .cube
│   ├── agent/             # 会话流程 + LLM(tool calling)参数提取
│   ├── api/               # FastAPI 路由
│   ├── storage/           # MySQL 存储
│   ├── tests/             # 后端测试
│   └── requirements.txt
├── frontend/
│   ├── src/lib/           # lutEngine.js(JS LUT 引擎)、lutPreview.js(WebGL2)
│   ├── src/App.jsx        # 生成页 + 管理页
│   └── prototype/         # UI 原型(HTML)
├── Makefile               # 启动/停止/测试脚本
└── .env                   # LLM key / JWT 密钥 / MySQL 连接(不入库)
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

# 3. 配置环境变量(复制模板后填 key 与 JWT 密钥)
cp .env.example .env
#   编辑 .env,至少填 CHROMA_LLM_API_KEY 与 CHROMA_JWT_SECRET

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
| `CHROMA_LLM_MODEL` | 模型名 | `deepseek-flash` |
| `CHROMA_LLM_BASE_URL` | API 地址 | `https://api.deepseek.com` |
| `CHROMA_LLM_API_KEY` | API key | 无(必须配置) |
| `CHROMA_LLM_MAX_TOKENS` | 单次最大 token | `2000` |
| `CHROMA_LLM_TIMEOUT` | 单次请求超时(秒) | `30` |

key 优先级:`CHROMA_LLM_API_KEY`(环境变量或项目根 `.env`)> `OPENAI_API_KEY`。换其他 OpenAI 兼容服务只需改这几个环境变量。

模型选择(实测结论,先看这段再改模型):

| 模型 | 思考模式 | 抽取场景实测开销 | 相对描述 |
|---|---|---|---|
| `deepseek-flash`(默认) | **默认开启**(`reasoning_effort` 默认 `high`) | completion ≈130~420,1~2.3s | 表现正常 |
| `deepseek-v4-pro` | 同上 | 思考开销更大 | 抽查中出现过把「再暖一点」误判为 `intent=confirm` |

> **两个模型都会思考,别按「哪个是 thinking 模型」来选。** DeepSeek 文档明确写了 thinking mode
> **默认开启**,且 Thinking Mode / Tool Calls 两页的示例代码用的都是 `model="deepseek-flash"`。
> 实测两个模型都会返回 `reasoning_content`,且 `usage.completion_tokens_details.reasoning_tokens`
> 能占满 `max_tokens`。差别只在思考开销大小,不在有没有。

关于 `CHROMA_LLM_MAX_TOKENS`:思考阶段与最终输出**共享**这个预算,给太小会出现「content 为空 + `finish_reason=length`」。代码遇到这种情况会抛 `BudgetExhaustedError` 并提示调大该值,而不是静默降级成「用户没提参数」(否则用户按了「确认」会被反问一句「先说说想要什么效果」)。

实测本项目抽取 prompt(`deepseek-flash`,`max_tokens=2000`):简单描述 ≈130 token / 1.5s,多参数描述 ≈280 / 1.6s,长段口语 ≈420 / 2.3s —— **2000 余量充足**。(参考:只有明确需要复杂推理的输入才会把预算吃光,那种情况下 2000 同样不够。)

可用 `extra_body={"thinking": {"type": "disabled"}}` 关掉思考,实测省约一半延迟与 token;本项目未启用,以保留抽取质量。

> 三个实测约束(改这块前请先看):
> 1. **不要传 `tool_choice`**。服务端对 `"required"` 或指定函数一律 400,文案是 `Thinking mode does not support this tool_choice` —— 但**这与模型无关**,是路由层写死的报文。`"auto"` 或省略都可以。
> 2. **思考模式忽略 `temperature`/`presence_penalty`/`frequency_penalty`**,设了不报错但无效(`top_p` 仅在思考模式生效,且下限被抬到 0.95)。所以别指望调温度来稳定输出的幅度标定。
> 3. **`strict=true` 不可用**。官方要求 strict 模式下「所有属性都必须列为 `required`」,而本项目刻意让未提及的字段可省略(避免默认值污染),两者结构性冲突 —— 实测 `/beta` + `strict` 报 `Required properties must match all properties in the object`。另外 `/chat/completions` 端点会**静默接受并忽略** `strict`,别被「没报错」骗了。因此校验走客户端 pydantic(`ExtractResult` 用 `extra="forbid"`,模型编造字段会判非法而非被静默丢弃)。

### HTTP 层的两个坑

- **超时必须显式设置。** `openai` SDK 默认 read timeout 是 **600 秒**、`max_retries=2`,最坏情况一次抽取阻塞约 30 分钟(官方也把 30 分钟列为非流式请求的响应时间上限)。本项目显式设为 30 秒 + 重试 1 次,实测抽取耗时 1~2.3 秒。
- **带 `tools` 的请求,`reasoning_content` 必须回传。** 官方文档明确:带 `tools` 参数时,后续请求要把历史轮次的 `reasoning_content` 完整传回,否则 API 返回 400。本项目每次抽取都是独立单轮请求(历史以文本形式拼进 user 消息,不伪装成多轮 message),因此不受该约束 —— **如果以后改成真正的多轮 messages,必须同时实现 `reasoning_content` 回传**,否则会 400。

### MySQL

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `MYSQL_HOST` | 主机 | `localhost` |
| `MYSQL_PORT` | 端口 | `3306` |
| `MYSQL_USER` | 用户 | `root` |
| `MYSQL_PASSWORD` | 密码 | `123456` |
| `MYSQL_DATABASE` | 数据库 | `chroma` |

### 认证

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `CHROMA_JWT_SECRET` | JWT 签名密钥,至少 32 字符 | 未配置则生成开发密钥写入 `.jwt_secret`(已入 .gitignore) |
| `CHROMA_ENV` | 设为 `production` 时强制要求显式配置密钥 | 空(开发模式) |

登录态存在 httpOnly cookie 中,前端不持有 token;退出登录通过递增 `users.token_version` 使该用户已签发的 token 全部失效。登录/注册按 IP 限流(5 次失败 / 5 分钟窗口)。

密钥规则:

- `.env.example` 里的占位值会被**拒绝启动**,必须换成随机串:`python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
- 未配置密钥时,开发模式会生成一份存到 `.jwt_secret`(权限 0600)并复用,避免重启即掉登录态、以及多 worker 各自持不同密钥导致互相验不过 token
- `CHROMA_ENV=production` 下不配置密钥直接报错启动失败

> **限流局限**:当前是进程内内存实现。多 worker(`uvicorn --workers N`)或多实例部署时每个进程各自计数,实际阈值会被放大 N 倍。生产需要换成 Redis 等共享存储。

## 使用说明

1. **生成**:描述风格 → 大模型展示理解到的参数请你确认 → 确认后生成 LUT
2. **预览**:上传相机直出 JPEG(Standard 基准),拖动分割线对比原图与 LUT 效果
3. **保存/下载**:生成结果可直接下载机内版(导入 S5M2 等)或后期版(DaVinci/PR),也可先保存到「我的 LUT」再下载
4. **管理**:在「我的 LUT」查看缩略图、预览、改名、删除
5. **会话**:生成过程按会话保存,可新建 / 切换 / 重命名 / 删除,重开会话会恢复当时的调色参数

## 松下相机适配说明

- 输出 `.cube` 3D LUT(33 点),机内版注入 `#LUMIXPHOTOSTYLE` 头信息
- 基准照片风格决定 LUT 输入侧:Standard/Natural/Vivid 走 sRGB 照片线;V-Log 走视频线(松下 V-Log 反曲线 → V-Gamut→Rec.709 矩阵 → ACES filmic tone mapping,强度由 `tone_map` 控制)
- 机内烧录(Real-Time LUT)支持 S5M2 / S5M2X / G9M2;S5 / GH6 等仅机内监视

## 测试

```bash
make test         # 后端测试(pytest)
make test-parity  # 前后端引擎数学一致性校验
make check        # 上面两个一起跑
make build        # 构建前端产物到 frontend/dist
```

后端测试覆盖:LUT 引擎数学正确性、`.cube` 序列化、API CRUD、认证与限流、生成结果留档、会话流程与参数契约、tool calling 提取(含预算耗尽/入参非法等异常路径)、影调分区与分离色调、自动修图(测量/判定/渲染/编排/硬校验/API),以及**架构约束**的自动检查(分层依赖、参数集三方一致)。LLM 路径全部用桩,不打真实 API。

前端测试:`npm test` 跑展示层纯函数(Node 内置 runner,零依赖)。

前后端各有一份同数学的引擎实现(后端 numpy 用于产出 `.cube`,前端 JS 用于 WebGL 实时预览、缩略图与未保存时的直接下载),因此有两道一致性校验:

| 校验 | 内容 | 判定标准 |
|---|---|---|
| `check_parity.mjs` | 引擎数学 | 25 个采样点 × 8 组参数,逐点差 < 1e-6 |
| `check_cube_parity.mjs` | `.cube` 序列化 | header 与行数逐字节相同;数值差异 ≤ 6 位小数下 1 个最低位 |

`.cube` 序列化的已知差异:后端 `f"{v:.6f}"` 用 Python 的 round-half-even,前端 `toFixed` 用 half-away-from-zero,叠加 JS `Math.pow` 与 numpy 的浮点差。实测纯 sRGB 路径**逐字节相同**,V-Log 与 gamma/矩阵路径最多 1 个最低位(占比 < 1%)。**改动任一侧的算子或序列化后都要跑 `make check`。**
