# 老板需求定稿：供应商 JWT 全面适配（2026-11-08）

供其他 AI / 开发者实现。**本仓库只交需求与差异说明，不在本提交里写业务代码。**

## 背景

- 线上：https://new.886668.shop（万事大吉 / 上号器）
- 仓库 tip 参考：`a7e848b`（供应商 JWT + 账单 + refresh 失败回落密码登录）
- 启用中供应商网关示例名：`jwt-18.139.109.234` / 「小楼供应商站」（`newapi_supplier`）
- 详细 UI/API 差异：同目录 [`2026-11-08-jwt-channels-diff.md`](./2026-11-08-jwt-channels-diff.md)（设计已定稿）

## 老板原话要点

1. **全面适配 JWT 站点**
2. **至少能上 key**（创建/录入），同时渠道支持**关键词搜索**；目前没有（显眼的）搜索入口
3. **令牌失效不需要用户贴令牌**：已有账号密码登录连接方案，会话挂了走账密重登

## 总监拍板顺序

1. **搜索先上**（DESIGN v2.2 chips；供应商视图必显搜索框+按钮或回车即搜）
2. **上 key = 提前开创建（原 G8）**：去掉 `supplierForbidden:create` / UI `hidden`；`POST /api/channel/`；表单按 profile `kind` / `editable_fields` 裁剪；无测试/删除/启停
3. **owned 编辑/换 key** 与创建同发；`owned=false` 仍只读
4. **鉴权文案**：禁止「令牌失效请重填 Access Token」；黄条只提示检查账密/到设置重新登录

## 验收必过（测试已改口径）

1. JWT 网关设置无 Access Token 字段；会话失败引导账密重填，不提管理令牌；自动 refresh → 密码重登
2. 渠道页可见搜索框+按钮；关键字/ID 命中已导入行
3. 「添加渠道」可见；创建成功得到 `owned=true` 可管行；密钥可在修改抽屉更新
4. `owned=false` 仍只读；无测试/删除/启停入口

## 非目标

- 不改账单源 C 口径
- 不开放删除 / 手动启停 / 测试（除非另开一轮）
- 不在文档或 PR 中写入真实账密、JWT、服务器密码

## 实现提示（给写代码的 AI）

- UI：`components/channels-view.tsx`（Add `hidden`、ChipSearch）、`components/settings-view.tsx`（tokenInvalid 文案）
- 适配：`lib/gateway-adapter.ts` → `supplierApi` / `supplierForbidden:*`
- 创建服务：`lib/channel-service.ts` → `createChannels` / `owned` / `supplierNotOwned`
- 上游：供应商站 `POST /api/channel/`；搜索优先本地库，必要时 `GET /api/channel/search`
- 鉴权：账密落库；access 短期票；过期 refresh，失败密码重登（已有 `a7e848b` 行为，UI 文案对齐即可）

## 关联文档

- 供应商子账户是另一份需求，相关但分开，不并入本文：`docs/plans/2026-11-10-supplier-subaccounts.md`
- `docs/plans/2026-11-08-jwt-channels-diff.md` — 设计差异说明（权威 UI 规格）
- `docs/plans/2026-11-08-jwt-channels-acceptance.md` — 测试必过增量（AUTH-S-09… / CH-S-11…）
- 冒烟基线缺陷（补丁前）：jwt 网关曾显示「已停用」「缺少令牌」——实现后 AUTH-S-09…12 必须清掉
- 计划原文：`docs/plans/2026-11-05-supplier-jwt-gateway.md`（若仓库已有）
- DESIGN v2.2 §9.1 / §9.6

## 附加（老板 2026-11-08 补）：「本系统上的 key」一键筛选

上 key 的**管理员账号**视角：渠道列表增加一个按钮（文案建议：「本系统上的」/「我上的 key」）。

- 点一下：只显示**通过本上号器创建/录入**的渠道（`created_here=1` 且本系统归属；供应商 JWT 场景优先 `owned=true` 可管行，或明确标记 origin=created / created_here）。
- 再点或「全部」：恢复完整列表（含导入只读行）。
- 与关键词搜索可叠加；空态：「还没有通过本系统上的 key」+ 引导「添加渠道」。
- 目的：管理员一眼区分「站点原有导入」vs「经本系统上的」。

实现提示：列表已有 `createdHere` / `owned` / `origin` 字段；做前端 filter 或 `?mine=1` / `?createdHere=1` 查询参数即可。
