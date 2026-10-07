# Cloudflare 基础版

配套前端：[Mega-Ryan/Sub-Store-Front-End 的 cloudflare-basic 分支](https://github.com/Mega-Ryan/Sub-Store-Front-End/tree/cloudflare-basic)。Pages 的同域 `/backend` 网关通过 `SUB_STORE` Service Binding 调用私有 Worker；数据、会话、分享计数、缓存与日志存入 D1。

正式入口：https://sub-store-ui-5f8.pages.dev  
测试入口：https://sub-store-ui-staging.pages.dev

## 支持范围

支持订阅与合集增删改、排序、远程 HTTP/HTTPS 订阅、本地文本、内置过滤与重命名等节点处理、预览及多格式导出、原文文件、限期/限次数分享、JSON/Base64 JSON 备份导入与 JSON 导出。复用上游解析/输出算法，Surge、Loon、Quantumult X 的内置 PEG 语法在构建时编译。

动态脚本是用户提供的 JavaScript：例如 Script Operator/Filter、响应变换或从 URL 下载的处理脚本。基础版会明确拒绝这些动作（包含被禁用的脚本动作）；普通订阅解析和内置处理不受影响。Gist/制品同步、归档、代理、Resolve Domain、MMDB、加密来源、高级文件配置生成、合集标签选择与远程失败回退暂不支持。API 返回 422/501，前端隐藏相应入口。日志只支持文字关键词。

上游协议仍可能包含当前 Workers 所不支持的特性，输出器的原有兼容规则会保留或过滤节点；请在预览中检查节点。转换总输入最多 2 MiB、保存单条内容 512 KiB、每次预览／导出远程来源总计 12 个（合集全部成员共用此限额）、节点 10000 个、合集 32 项、备份 4 MiB。上述是输入上限，CPU 配额仍取决于账户套餐与实际处理动作。

## 安全与数据行为

管理凭据通过 Worker Secret `ADMIN_LOGIN_TOKEN` 配置，要求至少 32 字符。管理会话使用同域 Secure/HttpOnly/SameSite=Strict Cookie，D1 只保存会话令牌的摘要；写入请求校验 `PUBLIC_ORIGIN`。登录有基于 IP 摘要的限流。凭据不进入前端、Git、日志或 URL。

分享链接包含独立随机令牌，限次计数由 D1 单条更新原子消耗。限次分享的 HEAD 或开始导出的 GET 均消耗一次，上游失败也可能消耗一次。错误目标名称/格式、已到期或已撤销请求不会消耗次数。分享响应禁止缓存。编辑分享（包括切换计数与有效期规则）保留令牌和历史限次已用次数；按有效期分享期间的访问不增加限次计数，切换回限次数时，次数上限不能低于保留的历史限次已用次数。备份包含分享令牌，应妥善保管；导入保留原到期时间，原子替换配置、清理缓存，不恢复管理会话。

编辑对象与设置需要最新 `version`/`_version`，冲突返回 409。合集通过稳定 ID 引用订阅，重命名不会断开关系；删除订阅会解除合集引用，删除资源会撤销相关分享。日志仅保存错误代码，最多 1000 条；缓存最多 200 条，默认 5 分钟，刷新增加缓存代次避免旧请求覆盖新缓存。

远程来源的自定义请求头仅在同 origin 重定向中保留。跨 origin 重定向只保留 `User-Agent`、`Accept`、`Accept-Language`，会移除 `Authorization`、`X-API-Key` 等自定义鉴权头，避免把来源凭据转发给第三方。需要鉴权的来源宜直接配置最终 URL 与对应请求头。

## 构建与本地开发

Cloudflare 使用独立的 `backend/cloudflare/package.json` 和锁文件，避免安装 Node 后端的服务器专用依赖。原 Node 发布入口保持独立。基线 Node 24.15.0、pnpm 11.0.9、Wrangler 4.147.0。

```sh
cd backend/cloudflare
pnpm install --frozen-lockfile
pnpm run types
pnpm run typecheck
pnpm test
pnpm run test:conversion
pnpm run build
pnpm exec wrangler deploy --dry-run --config wrangler.staging.jsonc
```

复制 `.dev.vars.example` 为忽略提交的 `.dev.vars`，设置测试凭据以及 `PUBLIC_ORIGIN=http://127.0.0.1:8799`。不要使用正式凭据。然后：

```sh
pnpm exec wrangler d1 migrations apply DB --local --config wrangler.staging.jsonc
pnpm exec wrangler dev --local --config wrangler.staging.jsonc --port 8787
```

配套前端启动在 8799，绑定名为 `sub-store-api-staging` 的本地 Worker。`pnpm run build` 后 Wrangler 监听 bundle 变化；源文件改动后需要重新构建。

## 发布与回滚

测试 D1：`sub-store-db-staging`；正式 D1：`sub-store-db`。两套 Wrangler 配置已记录实际数据库 ID 与 Pages Origin。两环境均启用 `global_fetch_strictly_public`，使远程订阅来源按公网路由经过 Worker／Pages 入口，避免同 zone 的源请求绕过 Worker 路由而访问不存在的 origin 并返回 522。[Cloudflare 官方说明](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)。Worker 禁止 `workers.dev` 和 preview URL，无公开路由。

每次先发布后端，再发布前端。手动 Actions 输入两边完整提交 SHA，后端写入 `BUILD_REVISION`；前端发布检查 `/backend/health` 与输入的后端 SHA 一致。两个仓库 CI 自动构建/测试，部署由 `workflow_dispatch` 明确选择环境，外部 PR 不触发部署。

初次可用已连接的 Cloudflare API 上传，后续 Actions 需要在仓库的 staging/production 环境配置变量 `CLOUDFLARE_ACCOUNT_ID` 和 Secret `CLOUDFLARE_API_TOKEN`。连接器不会提供可转用的 Actions 凭据；此项需账户所有者自行创建限制到目标账户的 Workers、Pages、D1 部署 token。`ADMIN_LOGIN_TOKEN` 已是 Worker Secret，普通重新部署保留；轮换通过 Cloudflare Secret 操作并撤销旧会话。

CLI 首次配置 Secret（终端交互输入，勿写入命令参数）：

```sh
pnpm exec wrangler secret put ADMIN_LOGIN_TOKEN --config wrangler.staging.jsonc
pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.staging.jsonc
pnpm exec wrangler deploy --config wrangler.staging.jsonc --var BUILD_REVISION:<准确后端SHA>
```

首次上线为空实例。回滚先导出配置备份，再重部署已验证的配套前后端 SHA；这不会回滚 D1 数据。数据库变更需在测试环境验证独立的前向/恢复策略，不能仅回滚 Worker。无需合并 master 才能部署本分支。
