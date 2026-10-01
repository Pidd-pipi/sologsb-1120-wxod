# sologsb-1120 古钟表维修工序档案（gbclockrepair）

面向钟表修复师的工序档案台：为一台古董钟表建档，记录机芯型号、零件缺失与配换、拆解顺序、清洗润滑点位，以及修复后的走时测试数据。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21820**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1120/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{clock,part,step,test,merge}.ts
        ├── stores/{clock,part,step,merge}Store.ts
        ├── components/common/{StepSequence,RateChart,ClockCard,StateBadge}.vue
        ├── hooks/{useClockSearch,useRepairProgress}.ts
        ├── pages/{ClockList,ClockDetail,StepForm,PartList,TestView,MergeCenter}.vue
        └── utils/{db,timeCalc,id,sourceTag,bundle,mergeEngine}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/clocks` | 钟表台账：按种类/机芯/品相/年代区间筛选，按修复状态分栏 | Clock |
| `/clocks/:id` | 钟表详情：左侧机芯信息，右侧工序流与走时测试记录，可切零件清单 | Clock、RepairStep、TimekeepingTest、MovementPart |
| `/steps/new` | 新建维修工序：选步骤类型后动态出清洗液/油脂/力矩字段，顺序号冲突即报错 | RepairStep、MovementPart |
| `/parts` | 零件与配换清单：按磨损状态分组，标出待修配条目与来源批号 | MovementPart |
| `/tests/:clockId` | 走时测试录入与多方位均值计算，生成走时单文本 | TimekeepingTest |
| `/merge` | 离线档案合并：导入两台平板的包，先列差异，确认后原子写入；失败保留两边的包可重试 | MergeBundle、全部四表 |

`/` 重定向到 `/clocks`，未匹配路由同样兜底到 `/clocks`。

## 数据存储说明

- 数据库名 `gbclockrepair`，当前结构版本 **v3**（`localStorage['gbclockrepair:db-version']` 记录）。
- 五张表：`clocks`（钟表）、`parts`（机芯零件）、`steps`（维修工序）、`tests`（走时测试）、`mergeBundles`（离线合并暂存）。
- v1 → v2 迁移：补齐老记录的 `state`、`partIds`、`torque`、`positions` 字段并新增索引。
- v2 → v3 迁移：新增 `mergeBundles` 表与四表的 `sourceTag` 索引；老工序补 `originSeq`（合并重排前的本机顺序号）。**v2 以前的老记录没有 `sourceTag`，合并时会作为差异列出，确认前不写原档。**
- 每条业务记录带 `sourceTag`（来源标记，默认「本店主机」，可在合并页修改），工序另有 `originSeq`、`invalidReason`。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 台示范钟表、3 项零件、3 道工序与 1 次走时测试。

## 离线合并（两台平板回店合并同一台钟）

平板离线记录后导出 **离线数据包（JSON）**，回店在「离线合并」页导入两个包。

**合并规则**

- **按藏品号认领**：同一台钟以 `clockNo` 归并，不整份覆盖；本机缺该藏品号即**阻断**，先列差异，确认/补档前不动原档。
- **维修工序**：分叉前的公共工序（按步骤类型+操作人+清洗/润滑/力矩/异常指纹）自动去重；两边各自新增的工序都保留，并保留各自**操作人与来源标记**，跨设备按开工时间稳定归并，`seq` 连续重排、各自原顺序存于 `originSeq`。
- **零件决定**：同名+同装配位置视为同一零件（跨设备 id 自动重映射）。两边决定不一致时按 **换新 > 修配 > 保留** 定论；**决定一变，引用该零件的维修工序立即置为 `invalid`（已失效·待重做）**，并按合并后的零件数据重算关联；决定对该设备未变的工序不受影响。
- **走时测试**：按时间+读数指纹去重，其余全部并入。
- **差异三级**：`阻断`（缺钟表）/`待确认`（缺零件、决定冲突、旧档无来源标记）/`提示`（字段差异、重复记录）。确认前只预演不写库。

**失败保留与重试**

- 确认写入时，先把 A、B 两个包原样存入 `mergeBundles`，再在**单个 IndexedDB 事务**里原子提交四表；任一步失败整体回滚，业务原档不变。
- 失败的会话保留在合并页，记录失败原因与尝试次数，可**重试**（用最新原档重建计划）或丢弃；补齐缺失钟表后重试即可成功。

## 功能要点

- **顺序号不跳号**：新建工序时若顺序号大于「当前最大顺序号 + 1」直接报错并给出建议值；`<StepSequence>` 对缺口行标红。
- **工序排序**：支持「上移 / 下移」按钮与原生拖拽交换顺序，交换的是 `seq`。
- **工序完成 / 回退**：完成后写 `finishedAt`，回退后计入待办与回退计数。
- **双轴走时图**：`<RateChart>` 左轴日差 s/d、右轴摆幅 °，标注四方位读数与均值。
- **走时单导出**：按方位均值生成文本，可复制或下载 txt。
