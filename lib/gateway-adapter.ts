import { dbRun } from "./db";
import type { GatewaySecret } from "./gateways";
import { saveSellerCapabilities } from "./gateways";
import { httpStatusOf, logListPage, readExplicitTotal } from "./list-sweep";
import { sellerChannelBody, readSellerCapabilities, type SellerCapabilities } from "./seller-payload";
import { sellerRequest } from "./seller-auth";
import { upstreamQueue } from "./rate-queue";
import {
  addUpstreamChannel,
  fetchGatewayGroups,
  fetchGatewayModels,
  fetchUpstreamChannel,
  listUpstreamChannels,
  parseChannel,
  setUpstreamStatus,
  testUpstreamChannel,
  updateUpstreamChannel,
  type ChannelTestResult,
  type GatewayPricingModel,
  type UpstreamChannel,
} from "./upstream";

export type ChannelPage = {
  items: UpstreamChannel[];
  /** Explicit finite total from upstream. Null when the field is missing or not a finite integer. */
  total: number | null;
  status: number;
  capabilities: SellerCapabilities | null;
};

export type GatewayApi = {
  kind: "newapi_admin" | "newapi_seller" | "newapi_supplier";
  list(page: number): Promise<ChannelPage>;
  search?(keyword: string): Promise<UpstreamChannel[]>;
  get(id: number): Promise<UpstreamChannel | null>;
  create(payload: Record<string, unknown>): Promise<void>;
  update(payload: Record<string, unknown>): Promise<void>;
  setStatus(id: number, status: 1 | 2): Promise<void>;
  test(id: number, model: string): Promise<ChannelTestResult>;
  groups(): Promise<string[]>;
  models(): Promise<GatewayPricingModel[]>;
};

function queued<T>(gateway: GatewaySecret, lane: string, run: () => Promise<T>, timeoutMs?: number): Promise<T> {
  return upstreamQueue.enqueue({
    gatewayId: gateway.id,
    lane,
    timeoutMs,
    run: async () => {
      try {
        return await run();
      } catch (error) {
        if (error && typeof error === "object" && "retryable" in error) {
          const tagged = error as { retryable?: boolean; retryAfter?: number | null };
          tagged.retryable = Boolean(tagged.retryable);
        }
        throw error;
      }
    },
  });
}

async function loadListedPage(
  gateway: GatewaySecret,
  page: number,
  load: () => Promise<{ items: UpstreamChannel[]; total: number | null; capabilities: SellerCapabilities | null }>,
): Promise<ChannelPage> {
  try {
    const listed = await load();
    logListPage(gateway.id, page, 200, listed.total, listed.items.length);
    return { ...listed, status: 200 };
  } catch (error) {
    logListPage(gateway.id, page, httpStatusOf(error), null, 0);
    throw error;
  }
}

function adminApi(gateway: GatewaySecret): GatewayApi {
  return {
    kind: "newapi_admin",
    async list(page) {
      return loadListedPage(gateway, page, async () => {
        const listed = await listUpstreamChannels(gateway, page);
        return { items: listed.items, total: listed.total, capabilities: null };
      });
    },
    get: (id) => fetchUpstreamChannel(gateway, id),
    create: (payload) => addUpstreamChannel(gateway, payload),
    update: (payload) => updateUpstreamChannel(gateway, payload),
    setStatus: (id, status) => setUpstreamStatus(gateway, id, status),
    test: (id, model) => testUpstreamChannel(gateway, id, model),
    groups: () => fetchGatewayGroups(gateway),
    models: () => fetchGatewayModels(gateway),
  };
}

async function sellerCall<T>(gateway: GatewaySecret, path: string, init?: RequestInit): Promise<T> {
  return (await sellerRequest(gateway.id, gateway.baseUrl, path, init)) as T;
}

function sellerApi(gateway: GatewaySecret): GatewayApi {
  return {
    kind: "newapi_seller",
    async list(page) {
      return loadListedPage(gateway, page, async () => {
        const body = await queued(gateway, "list", () =>
          sellerCall<{ data?: { items?: unknown[]; total?: number } }>(
            gateway,
            `/api/seller/channel/?p=${page}&page_size=20&id_sort=true`,
          ),
        );
        const items = Array.isArray(body.data?.items) ? body.data.items.map(parseChannel).filter((item): item is UpstreamChannel => Boolean(item)) : [];
        const capabilities = readSellerCapabilities(body.data);
        if (capabilities) await saveSellerCapabilities(gateway.id, capabilities);
        return { items, total: readExplicitTotal(body.data?.total), capabilities };
      });
    },
    async get(id) {
      const body = await queued(gateway, `channel:${id}`, () => sellerCall<{ data?: unknown }>(gateway, `/api/seller/channel/${id}`));
      return parseChannel(body.data);
    },
    async create(payload) {
      await queued(gateway, "mutate", () => sellerCall(gateway, "/api/seller/channel/", { method: "POST", body: JSON.stringify(sellerChannelBody(payload, false)) }), 90_000);
    },
    async update(payload) {
      await queued(gateway, "mutate", () => sellerCall(gateway, "/api/seller/channel/", { method: "PUT", body: JSON.stringify(sellerChannelBody(payload, true)) }), 90_000);
    },
    async setStatus(id, status) {
      await queued(gateway, `channel:${id}`, () =>
        sellerCall(gateway, `/api/seller/channel/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
      );
    },
    async test(id, model) {
      const query = model ? `?model=${encodeURIComponent(model)}` : "";
      const body = await queued(gateway, `channel:${id}`, () =>
        sellerCall<{ message?: string; success?: boolean; time?: number }>(gateway, `/api/seller/channel/test/${id}${query}`),
      );
      const timeSeconds = typeof body.time === "number" && Number.isFinite(body.time) ? body.time : 0;
      return { success: body.success !== false, message: body.message || "", timeSeconds };
    },
    async groups() {
      const body = await queued(gateway, "list", () => sellerCall<{ data?: { groups?: unknown } }>(gateway, "/api/seller/channel/meta"));
      const groups = body.data?.groups;
      return Array.isArray(groups) ? groups.map((item) => String(item)).filter(Boolean) : [];
    },
    async models() {
      const body = await queued(gateway, "list", () => sellerCall<{ data?: { models?: unknown } }>(gateway, "/api/seller/channel/meta"));
      const models = body.data?.models;
      if (!Array.isArray(models)) return [];
      const list: GatewayPricingModel[] = [];
      for (const entry of models) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const name = typeof row.id === "string" ? row.id : typeof row.model_name === "string" ? row.model_name : "";
        if (!name) continue;
        list.push({ name, groups: [] });
      }
      return list;
    },
  };
}

export function gatewayApi(gateway: GatewaySecret): GatewayApi {
  if (gateway.kind === "newapi_supplier") return supplierApi(gateway);
  return gateway.kind === "newapi_seller" ? sellerApi(gateway) : adminApi(gateway);
}

export type SupplierProfileKind = { kind: string; label?: string; actions?: string[]; editable_fields?: string[]; models?: string[] };

/** 每次同步重读 profile（能力随站点授权变化），缓存进 gateways.profile_cache 供界面用。 */
export async function fetchSupplierProfile(gateway: GatewaySecret): Promise<{ supplierLabel: string; kinds: SupplierProfileKind[] }> {
  const body = await queued(gateway, "list", () =>
    sellerCall<{ supplier_label?: string; kinds?: unknown }>(gateway, "/api/supplier/v1/profile"),
  );
  const kinds = Array.isArray(body.kinds)
    ? body.kinds.filter((item): item is SupplierProfileKind => Boolean(item) && typeof item === "object" && typeof (item as SupplierProfileKind).kind === "string")
    : [];
  const profile = { supplierLabel: String(body.supplier_label ?? ""), kinds };
  await dbRun("UPDATE gateways SET profile_cache = ?, supplier_label = ? WHERE id = ?", [
    JSON.stringify(profile),
    profile.supplierLabel,
    gateway.id,
  ]).catch(() => undefined);
  return profile;
}

/** 供应商 JWT 种类：只读列表 + owned=true 的受限编辑；测试/启停/删除在 API 层拒绝（CH-S-05/06/07）。 */
function supplierApi(gateway: GatewaySecret): GatewayApi {
  const forbidden = (action: string): never => {
    throw Object.assign(new Error(`supplierForbidden:${action}`), { status: 403, retryable: false });
  };
  return {
    kind: "newapi_supplier",
    async list(page) {
      return loadListedPage(gateway, page, async () => {
        const body = await queued(gateway, "list", () =>
          sellerCall<{ data?: { items?: unknown[]; total?: number } }>(gateway, `/api/channel/?p=${page}&page_size=20&id_sort=true`),
        );
        const items = Array.isArray(body.data?.items) ? body.data.items.map(parseChannel).filter((item): item is UpstreamChannel => Boolean(item)) : [];
        return { items, total: readExplicitTotal(body.data?.total), capabilities: null };
      });
    },
    async get(id) {
      const body = await queued(gateway, `channel:${id}`, () => sellerCall<{ data?: unknown }>(gateway, `/api/channel/${id}`));
      return parseChannel(body.data);
    },
    async search(keyword: string) {
      const body = await queued(gateway, "list", () =>
        sellerCall<{ data?: { items?: unknown[] } }>(gateway, `/api/channel/search?keyword=${encodeURIComponent(keyword)}`),
      );
      const items = Array.isArray(body.data?.items) ? body.data.items.map(parseChannel).filter((item): item is UpstreamChannel => Boolean(item)) : [];
      return items;
    },
    async create(payload): Promise<void> {
      // 2026-11-08 老板需求：提前放开上 key。最小提交体 {mode:"single", channel}
      await queued(gateway, "mutate", () => sellerCall(gateway, "/api/channel/", { method: "POST", body: JSON.stringify(payload) }), 90_000);
    },
    async update(payload) {
      // owned 守卫在 channel-service 的 updateChannel（supplierNotOwned）；这里只负责 PUT
      await queued(gateway, "mutate", () => sellerCall(gateway, "/api/channel/", { method: "PUT", body: JSON.stringify(payload) }), 90_000);
    },
    async setStatus(): Promise<void> {
      return forbidden("status");
    },
    async test(): Promise<ChannelTestResult> {
      return forbidden("test");
    },
    async groups() {
      const body = await queued(gateway, "list", () => sellerCall<{ data?: unknown }>(gateway, "/api/group/"));
      return Array.isArray(body.data) ? body.data.map((item) => String(item)).filter(Boolean) : [];
    },
    async models() {
      return [];
    },
  };
}
