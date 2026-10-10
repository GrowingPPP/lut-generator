# CHROMA — 松下 LUT 生成器

用自然语言生成适配松下 Lumix 相机的 `.cube` LUT 文件。拍照直出带 LUT 滤镜的照片,支持机内烧录(Real-Time LUT)与后期软件两用。

## 功能

- **会话式 LUT 生成**:描述想要的风格(如「日系清透」「电影青橙」),大模型多轮确认后生成 `.cube` 文件
- **LUT 管理**:个人 LUT 的增删改查,下载机内版(带松下头)与后期版
- **实时预览**:上传样张,滑动对比 / 独立展示两种形式
- **AI 自动修图**:上传照片,一键自动分析并产出调好的 LUT;可叠加自然语言风格描述(如「日系清透一点」),展示诊断依据、前后对比与完整修改说明,可一键撤销
- **精细调色**:30 个参数,按单张校正、风格强度、影调、全局与局部色彩、阴影/中间调/高光染色、RGB 分通道和输入基准分组。风格强度可在技术转换与完整效果之间调整

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
│   ├── photo/             # 自动修图的计算层,不依赖框架:
│   │                      #   stats(测量)/ quality(判定)/ render(渲染)/ fixtures(合成样张)
│   ├── agent/             # 会话流程 + LLM(tool calling)参数提取
│   │                      #   auto.py = 自动修图编排(测量→提议→硬校验→风格→复检)
│   ├── api/               # FastAPI 路由
│   ├── storage/           # MySQL 存储
│   ├── scripts/           # 工具脚本(生成 golden 用例等)
│   └── tests/             # 后端测试
├── frontend/
│   ├── src/lib/           # lutEngine.js(JS LUT 引擎)、lutPreview.js(WebGL2)
│   │                      # autoGrade.js(自动修图的展示层纯函数)、preview.js(样张/缩略图)
│   ├── src/components/    # AutoRetouchBar / AutoRetouchReport / LibraryView / AuthView
│   ├── src/hooks/         # usePreview(WebGL 预览生命周期)
│   ├── src/App.jsx        # 生成页编排
│   ├── src/App.css        # 全部样式
│   ├── scripts/           # 一致性与前端单测脚本
│   └── prototype/         # UI 原型(HTML,含可交互的自动修图原型)
├── docs/                  # 设计文档与遗留问题清单
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

# 3. 配置环境变量
cp .env.example .env
#   ⚠ 模板里的 CHROMA_JWT_SECRET 是占位值,直接启动会被**拒绝**(见「认证」)。
#     先生成一个真实密钥:
#     python3 -c "import secrets; print(secrets.token_urlsafe(48))"
#   然后编辑 .env,至少填这两项:
#     CHROMA_LLM_API_KEY=<你的 DeepSeek key>
#     CHROMA_JWT_SECRET=<上一步生成的随机串>

# 4. 创建一个本地账号(默认 admin / 12345678)
make admin
#   自定义:make admin NAME=me PW=mysecret123

# 5. 启动前后端
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

登录态存在 httpOnly cookie 中,前端不持有 token;退出登录通过递增 `users.token_version` 使该用户已签发的 token 全部失效。

限流有两套,口径不同:

| 范围 | 维度 | 阈值 | 超限 |
|---|---|---|---|
| 登录 | 按 IP | 5 次失败 / 5 分钟 | 429 |
| 注册 | 按 IP | 5 次尝试 / 5 分钟 | 429 + `Retry-After` |
| **AI 自动修图** | **按用户** | **20 次 / 小时** | 429 + `Retry-After` |

自动修图按用户而非 IP:每次调用都会打一次 LLM(实测约 11.6 秒、5000+ token),是整套接口里最贵的一个,登录用户换 IP 不该成为绕过手段。参数校验失败的请求不消耗配额 —— 否则传错图也会被扣次数。

密钥规则:

- `.env.example` 里的占位值会被**拒绝启动**,必须换成随机串:`python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
- 未配置密钥时,开发模式会生成一份存到 `.jwt_secret`(权限 0600)并复用,避免重启即掉登录态、以及多 worker 各自持不同密钥导致互相验不过 token
- `CHROMA_ENV=production` 下不配置密钥直接报错启动失败

> 登录保留进程内的 IP 失败限制，并增加 MySQL 中按 IP 的原子尝试限制；注册和自动修图配额也在 MySQL 事务中预留，跨 worker 共享。成功登录只释放本次预留，不清除之前的失败尝试。

## 使用说明

1. **生成**:描述风格 → 大模型展示理解到的参数请你确认 → 确认后生成 LUT
2. **预览**:照片基准上传与所选 Photo Style 一致的相机直出 JPEG；V-Log 基准使用未经显示转换的 V-Log/V-Gamut 帧。拖动分割线比较原图与 LUT 效果
3. **保存/下载**:生成结果可下载机内版或后期版，也可先保存到「我的 LUT」。机内版文件主名固定为 8 位 ASCII，使用时相机 Photo Style 必须匹配 LUT 基准。后期版仅去掉机内标签，文件名和标题注明输入输出信号；它需要应用在相同输入信号上

   兼容条件见[松下 Real Time LUT 指南](https://www.panasonic.com/uk/consumer/cameras-camcorders/lumix-expert-advice-learn/lumix-expert-advice/using-real-time-luts.html)与[松下 LUT 导入说明](https://av.jpn.support.panasonic.com/support/dsc/download/lut/index.html)。
4. **管理**:在「我的 LUT」查看缩略图、预览、改名、删除
5. **AI 自动修图**:上传照片 → 点「AI 自动修图」→ 可先在风格框里写一句自然语言描述。
   - 修图以当前 30 个参数所渲染的样张为基准诊断；优化提议叠加到当前参数，风格目标值按目标应用
   - 对一张样张自动修正的曝光与白平衡，只适合相近光线；其他场景应重新检查效果
   - 报告面板会列出诊断依据、本次调整、被安全规则拦下的提议、以及视觉复核意见
   - **视觉复核**是可选开关:开启后会把照片与修图结果发给模型做主观复检(更准但更慢);关闭后只依据客观数据分析
   - 反复点击是**叠加**效果(每次都以当前参数为基准),不满意可点「撤销」回到修图前
   - 存在「保守模式」:客观分析无法达标时,只做曝光与白平衡这类可计算的调整,并在报告里如实标记「未能完全达标」
6. **会话**:生成过程按会话保存,可新建 / 切换 / 重命名 / 删除,重开会话会恢复当时的调色参数;
   自动修图的历史集中在单独一个「自动修图」会话里(不会每次新建),重新打开即可看到上次的报告

## 松下相机适配说明

- 输出 `.cube` 3D LUT(33 点),机内版注入 `#LUMIXPHOTOSTYLE` 头信息
- Standard/Natural/Vivid 走相同的 sRGB 相对调色曲线，输入必须是对应 Photo Style 的照片信号；它们尚未针对各风格做设备校准。V-Log 走 V-Log/V-Gamut 解码 → 线性域曝光和白平衡 → 简化显示映射 → Rec.709 编码
- 冷暖滑杆是以 6500K 为参考的相对 RGB 增益，不测量拍摄色温。风格强度不衰减曝光、白平衡或 V-Log 显示转换。旧预设因影调公式变更，在重新导出前应预览
- 机内烧录(Real-Time LUT)支持 S5M2 / S5M2X / G9M2;S5 / GH6 等仅机内监视

## 测试

```bash
make test           # 后端测试(pytest)
make test-frontend  # 前端展示层纯函数测试(Node 内置 runner,零依赖)
make test-parity    # 前后端一致性校验(引擎数学 + .cube 序列化)
make check          # 上面三个一起跑(提交前应全绿)
make build          # 构建前端产物到 frontend/dist
make admin          # 创建/重置本地账号
```

> **测试跑在独立数据库 `chroma_test` 上,不会碰你的开发库。**
>
> 这不是可有可无的整洁习惯:测试里有多个 `autouse` fixture 会执行
> `DELETE FROM users` / 清空 LUT 与会话。此前它们直接作用在开发库上 ——
> 跑一次 `make check` 就会把你的账号删掉,再登录自然失败。
> 现在 `backend/conftest.py` 会在**导入 storage.db 之前**把库名覆盖成
> `chroma_test`,并在不匹配时直接拒绝启动测试。
>
> 想改测试库名:`CHROMA_TEST_DATABASE=别的名字 make test`。
> 若把它配成 `chroma`,conftest 会报错退出而不是照常删数据。
>
> 另外 `db.clear_users()` / `clear_all()` / `clear_sessions()` 在开发库上会**直接
> 拒绝执行**(抛 `RuntimeError`)—— 因为临时脚本、REPL 这些路径不经过 pytest,
> 光靠 conftest 挡不住。确实需要重置本地环境时显式放行:
> `CHROMA_ALLOW_CLEAR_DEV_DB=1 <你的命令>`。

后端测试覆盖:LUT 引擎数学正确性、`.cube` 序列化、API CRUD、认证与限流、生成结果留档、会话流程与参数契约、tool calling 提取(含预算耗尽/入参非法等异常路径)、影调分区与分离色调、自动修图(测量/判定/渲染/编排/硬校验/API),以及**架构约束**的自动检查(分层依赖、参数集三方一致)。LLM 路径全部用桩,不打真实 API。

前端测试:`npm test` 跑展示层纯函数(Node 内置 runner,零依赖)。

前后端各有一份同数学的引擎实现(后端 numpy 用于产出 `.cube`,前端 JS 用于 WebGL 实时预览、缩略图与未保存时的直接下载),因此有三道一致性校验:

| 校验 | 内容 | 判定标准 |
|---|---|---|
| `check_parity.mjs` | 引擎数学 | 125 个采样点 × 21 组参数,逐点差 < 1e-6 |
| `check_cube_parity.mjs` | `.cube` 序列化 | header 与行数逐字节相同;数值差异 ≤ 6 位小数下 1 个最低位 |
| `test_photo_render.py` | LUT 采样语义 | Python 渲染与前端 GLSL 公式逐点一致(< 1e-5) |

第三道是自动修图引入的:模型看的是后端渲染的图,用户看的是前端渲染的图,**两者必须一致**,否则视觉复检的结论对不上用户所见。

`.cube` 序列化的已知差异:后端 `f"{v:.6f}"` 用 Python 的 round-half-even,前端 `toFixed` 用 half-away-from-zero,叠加 JS `Math.pow` 与 numpy 的浮点差。实测纯 sRGB 路径**逐字节相同**,V-Log 与 gamma/矩阵路径最多 1 个最低位(占比 < 1%)。**改动任一侧的算子或序列化后都要跑 `make check`。**

## 文档

| 文档 | 内容 |
|---|---|
| [docs/auto-retouch.md](docs/auto-retouch.md) | AI 自动修图总览与范围边界 |
| [docs/specs/architecture.md](docs/specs/architecture.md) | 分层职责、关键取舍、成本预算、风险 |
| [docs/lut-design-remediation.md](docs/lut-design-remediation.md) | LUT 参数设计问题、修订任务、验收与设备校准限制 |
| [docs/specs/technical.md](docs/specs/technical.md) | 接口签名、数据结构、阈值常量、精度包络、API 契约 |
| [docs/specs/ui-design.md](docs/specs/ui-design.md) | 线框、组件规格、状态机、完整微文案 |
| [docs/specs/style-workspace-design.md](docs/specs/style-workspace-design.md) | 待实施方案：创作目标、参数保护、草稿与撤销、可复用风格、多样张验证、版本比较 |
| [docs/specs/test-plan.md](docs/specs/test-plan.md) | 测试分层、合成样张、硬校验断言 |
| [docs/leftover-issues.md](docs/leftover-issues.md) | 已知问题的记录与处理结果 |
