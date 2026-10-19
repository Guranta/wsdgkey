"use client";

import { buttonClass, fieldClass } from "@/components/ui";
import { CHANNEL_TYPE_OPTIONS, channelTypeOption } from "@/lib/channel-types";
import {
  CHANNEL_FORM_DEFAULT_VALUES,
  VOLCENGINE_ENDPOINTS,
  VOLCENGINE_UNLOCK_CLICKS,
  baseUrlWarning,
  keyLineWarnings,
  otherFieldLabel,
  otherFieldPlaceholder,
  splitKeys,
  validateChannelForm,
  type ChannelFormValues,
} from "@/lib/channel-payload";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

export type DrawerChannel = {
  id: string;
  name: string;
  type: number;
  group: string;
  baseUrl: string;
  models: string;
  modelMapping: string;
  testModel: string;
  remark: string;
  autoBan: boolean;
  priority: number;
  weight: number;
  tag: string;
  other: string;
  statusCodeMapping: string;
  paramOverride: string;
  headerOverride: string;
  settings: string;
  setting: string;
  openaiOrganization: string;
  status: "enabled" | "disabled";
};

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-secondary">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-warn">{hint}</span> : null}
    </label>
  );
}

function fromChannel(item: DrawerChannel): ChannelFormValues {
  const form: ChannelFormValues = {
    ...CHANNEL_FORM_DEFAULT_VALUES,
    name: item.name,
    type: item.type,
    base_url: item.baseUrl,
    models: item.models,
    group: item.group.split(",").map((part) => part.trim()).filter(Boolean),
    model_mapping: item.modelMapping,
    test_model: item.testModel,
    remark: item.remark,
    auto_ban: item.autoBan ? 1 : 0,
    priority: item.priority,
    weight: item.weight,
    tag: item.tag,
    other: item.other,
    status_code_mapping: item.statusCodeMapping,
    param_override: item.paramOverride,
    header_override: item.headerOverride,
    settings: item.settings || "{}",
    openai_organization: item.openaiOrganization,
    status: item.status === "enabled" ? 1 : 2,
    key: "",
  };
  try {
    const settings = JSON.parse(item.settings || "{}") as Record<string, unknown>;
    form.vertex_key_type = settings.vertex_key_type === "api_key" ? "api_key" : "json";
    form.vertex_project_id = String(settings.vertex_project_id ?? "");
    form.aws_key_type = settings.aws_key_type === "api_key" ? "api_key" : "ak_sk";
    form.aws_api_type = settings.aws_api_type === "mantle" ? "mantle" : "invoke_model";
    form.azure_responses_version = String(settings.azure_responses_version ?? "");
    form.is_enterprise_account = settings.openrouter_enterprise === true;
    form.allow_service_tier = settings.allow_service_tier === true;
    form.disable_store = settings.disable_store === true;
    form.allow_safety_identifier = settings.allow_safety_identifier === true;
    form.allow_include_obfuscation = settings.allow_include_obfuscation === true;
    form.allow_inference_geo = settings.allow_inference_geo === true;
    form.allow_speed = settings.allow_speed === true;
    form.claude_beta_query = settings.claude_beta_query === true;
    form.ollama_openai_chat = settings.ollama_openai_chat === true;
  } catch {
    /* keep defaults */
  }
  try {
    const setting = JSON.parse(item.setting || "{}") as Record<string, unknown>;
    form.proxy = String(setting.proxy ?? "");
    form.force_format = setting.force_format === true;
    form.thinking_to_content = setting.thinking_to_content === true;
    form.pass_through_body_enabled = setting.pass_through_body_enabled === true;
    form.system_prompt = String(setting.system_prompt ?? "");
    form.system_prompt_override = setting.system_prompt_override === true;
    form.http_protocol = setting.http_protocol === "http1" ? "http1" : "auto";
  } catch {
    /* keep defaults */
  }
  if (!form.group.length) form.group = ["default"];
  if (form.type === 45 && (!form.base_url || form.base_url === "doubao-coding-plan")) form.base_url = VOLCENGINE_ENDPOINTS[0];
  return form;
}

export function ChannelDrawer({
  gatewayId,
  editing,
  busy,
  onClose,
  onSave,
  onTest,
}: {
  gatewayId: string;
  editing: DrawerChannel | null;
  busy: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onTest: (id: string, model: string) => Promise<void>;
}) {
  const t = useTranslations("drawer");
  const common = useTranslations("common");
  const errors = useTranslations("errors");
  const [tab, setTab] = useState<"connection" | "routing" | "request" | "other">("connection");
  const [fieldError, setFieldError] = useState("");
  const [form, setForm] = useState<ChannelFormValues>(() => (editing ? fromChannel(editing) : { ...CHANNEL_FORM_DEFAULT_VALUES }));
  const [typeQuery, setTypeQuery] = useState("");
  const [typeOpen, setTypeOpen] = useState(false);
  const [volcClicks, setVolcClicks] = useState(0);
  const [volcUnlocked, setVolcUnlocked] = useState(false);
  const [existingDupes, setExistingDupes] = useState(0);
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexNote, setCodexNote] = useState("");

  const keys = splitKeys(form.key);
  const lineWarnings = form.key.split("\n").map((line, index) => ({ index, text: keyLineWarnings(form.type, line)[0] ?? "" })).filter((item) => item.text);
  const seen = new Set<string>();
  const duplicateLines: number[] = [];
  form.key.split("\n").forEach((line, index) => {
    const value = line.trim();
    if (!value) return;
    if (seen.has(value)) duplicateLines.push(index + 1);
    seen.add(value);
  });
  const urlWarningKey = baseUrlWarning(form.base_url);
  const urlWarning = urlWarningKey ? t(urlWarningKey as "warnTrailingV1") : null;
  const typeMeta = channelTypeOption(form.type);
  const typeChoices = useMemo(() => {
    const query = typeQuery.trim().toLowerCase();
    return CHANNEL_TYPE_OPTIONS.filter((item) => !query || item.name.toLowerCase().includes(query) || String(item.id).includes(query));
  }, [typeQuery]);

  useEffect(() => {
    const lines = splitKeys(form.key);
    const timer = window.setTimeout(() => {
      if (!gatewayId || lines.length === 0) {
        setExistingDupes(0);
        return;
      }
      void fetch("/api/channels/key-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayId, keys: lines }),
      }).then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { duplicates?: number };
        setExistingDupes(Number(body.duplicates ?? 0));
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [gatewayId, form.key]);

  function patch(partial: Partial<ChannelFormValues>) {
    setForm((current) => ({ ...current, ...partial }));
  }

  function clickVolcLabel() {
    if (volcUnlocked || form.type !== 45) return;
    const next = volcClicks + 1;
    setVolcClicks(next);
    if (next >= VOLCENGINE_UNLOCK_CLICKS) setVolcUnlocked(true);
  }

  async function refreshCodex() {
    if (!editing) return;
    setCodexBusy(true);
    setCodexNote("");
    const res = await fetch(`/api/channels/${editing.id}/codex/refresh`, { method: "POST" });
    setCodexBusy(false);
    const body = (await res.json().catch(() => null)) as { error?: { message?: string }; message?: string; accountId?: string; email?: string } | null;
    if (!res.ok) {
      setCodexNote(body?.error?.message || t("refreshFailed"));
      return;
    }
    const extra = [body?.email, body?.accountId].filter(Boolean).join(" · ");
    setCodexNote(t("refreshed", { extra: extra ? ` · ${extra}` : "" }));
  }

  function placeholderText(type: number): string {
    const key = otherFieldPlaceholder(type);
    if (key === "placeholderAzure" || key === "placeholderCloudflare" || key === "placeholderCoze") return t(key);
    return key;
  }

  const payload = { gatewayId, ...form, group: form.group };
  const dialogRef = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...node.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")];
    focusable()[0]?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/35">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-drawer-title"
        className="flex h-full w-full max-w-[680px] flex-col rounded-l-[20px] bg-card shadow-[var(--shadow-card)]"
        onSubmit={(event) => {
          event.preventDefault();
          const invalid = validateChannelForm(form, Boolean(editing));
          if (invalid) {
            setFieldError(invalid);
            const routingKeys = ["modelMappingObject", "modelMappingStrings"];
            const requestKeys = ["statusCodeObject", "statusCodeRange", "overrideObject"];
            const otherKeys = ["remarkLength", "proxyInvalid"];
            setTab(routingKeys.includes(invalid) ? "routing" : requestKeys.includes(invalid) ? "request" : otherKeys.includes(invalid) ? "other" : "connection");
            return;
          }
          setFieldError("");
          void onSave(payload);
        }}
      >
        <div className="border-b border-line px-5 py-4">
          <h2 id="channel-drawer-title" className="text-lg font-semibold">{editing ? t("editTitle", { name: editing.name }) : t("addTitle")}</h2>
          <p className="mt-1 text-xs text-muted">{t("parity")}</p>
          <div className="mt-3 flex flex-wrap gap-1 rounded-full bg-input p-1" role="tablist" aria-label={t("tabsLabel")}>
            {(["connection", "routing", "request", "other"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                className={tab === item ? "rounded-full bg-card px-3 py-1 text-xs font-medium text-foreground shadow-sm" : "rounded-full px-3 py-1 text-xs text-secondary"}
                onClick={() => setTab(item)}
              >
                {t(`tabs.${item}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {fieldError ? <p className="rounded-control bg-danger-soft px-3 py-2 text-xs text-danger">{errors(fieldError as "keyRequired")}</p> : null}
          {tab === "connection" ? (
            <>
              <Field label={t("name")}>
                <input className={fieldClass} value={form.name} onChange={(event) => patch({ name: event.target.value })} />
              </Field>
              <Field label={t("typeCount", { count: CHANNEL_TYPE_OPTIONS.length })}>
                <button type="button" className={`${fieldClass} flex items-center gap-2 text-left`} onClick={() => setTypeOpen((open) => !open)}>
                  <span className="h-5 w-5 shrink-0 rounded-[6px]" style={{ background: typeMeta.color }} />
                  <span className="truncate">{typeMeta.name}</span>
                </button>
                {typeOpen ? (
                  <div className="mt-1 rounded-control border border-line bg-card p-2">
                    <input className={fieldClass} value={typeQuery} placeholder={t("searchTypes")} onChange={(event) => setTypeQuery(event.target.value)} />
                    <ul className="mt-2 max-h-48 overflow-y-auto text-sm">
                      {typeChoices.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-hover"
                            onClick={() => {
                              patch({
                                type: item.id,
                                ...(item.id === 45 ? { base_url: VOLCENGINE_ENDPOINTS[0] } : {}),
                                ...(item.id === 18 && !(form.other ?? "").trim() ? { other: "v2.1" } : {}),
                              });
                              setVolcClicks(0);
                              setVolcUnlocked(false);
                              setTypeOpen(false);
                              setTypeQuery("");
                            }}
                          >
                            <span className="h-5 w-5 shrink-0 rounded-[6px]" style={{ background: item.color }} />
                            {item.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Field>
              {!editing ? (
                <Field label={t("status")}>
                  <select className={fieldClass} value={String(form.status)} onChange={(event) => patch({ status: Number(event.target.value) })}>
                    <option value="1">{common("enabled")}</option>
                    <option value="2">{common("disabled")}</option>
                  </select>
                </Field>
              ) : null}
              {form.type === 1 ? (
                <Field label="OpenAI Organization">
                  <input className={fieldClass} value={form.openai_organization} placeholder="org-..." onChange={(event) => patch({ openai_organization: event.target.value })} />
                </Field>
              ) : null}
              {form.type === 3 ? (
                <>
                  <Field label={t("apiVersion")}>
                    <input className={fieldClass} value={form.other} placeholder={t("apiVersionPlaceholder")} onChange={(event) => patch({ other: event.target.value })} />
                  </Field>
                  <Field label={t("responsesVersion")}>
                    <input className={fieldClass} value={form.azure_responses_version} placeholder={t("responsesPlaceholder")} onChange={(event) => patch({ azure_responses_version: event.target.value })} />
                  </Field>
                </>
              ) : null}
              {form.type === 33 ? (
                <>
                  <Field label={t("awsKeyFormat")}>
                    <select className={fieldClass} value={form.aws_key_type} onChange={(event) => patch({ aws_key_type: event.target.value as ChannelFormValues["aws_key_type"] })}>
                      <option value="ak_sk">AccessKey|SecretAccessKey|Region</option>
                      <option value="api_key">APIKey|Region</option>
                    </select>
                  </Field>
                  <Field label={t("awsApi")}>
                    <select className={fieldClass} value={form.aws_api_type} onChange={(event) => patch({ aws_api_type: event.target.value as ChannelFormValues["aws_api_type"] })}>
                      <option value="invoke_model">InvokeModel</option>
                      <option value="mantle">Mantle</option>
                    </select>
                  </Field>
                </>
              ) : null}
              {form.type === 41 ? (
                <>
                  <Field label={t("vertexKeyFormat")}>
                    <select className={fieldClass} value={form.vertex_key_type} onChange={(event) => patch({ vertex_key_type: event.target.value as ChannelFormValues["vertex_key_type"] })}>
                      <option value="json">{t("vertexJson")}</option>
                      <option value="api_key">API Key</option>
                    </select>
                  </Field>
                  {form.vertex_key_type === "api_key" ? (
                    <Field label="Project ID">
                      <input className={fieldClass} value={form.vertex_project_id} onChange={(event) => patch({ vertex_project_id: event.target.value })} />
                    </Field>
                  ) : null}
                  <Field label={t("region")}>
                    <textarea className={`${fieldClass} h-20 py-2`} value={form.other} placeholder='{"default":"us-central1"}' onChange={(event) => patch({ other: event.target.value })} />
                  </Field>
                </>
              ) : null}
              {form.type === 45 ? (
                <Field label={t("baseUrl")}>
                  <span className="mb-1.5 block cursor-pointer select-none text-xs text-secondary" onClick={clickVolcLabel}>
                    {volcUnlocked ? t("customUnlocked") : t("volcLabel")}
                  </span>
                  {volcUnlocked ? (
                    <input className={fieldClass} value={form.base_url} onChange={(event) => patch({ base_url: event.target.value })} />
                  ) : (
                    <select className={fieldClass} value={form.base_url || VOLCENGINE_ENDPOINTS[0]} onChange={(event) => patch({ base_url: event.target.value })}>
                      {VOLCENGINE_ENDPOINTS.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  )}
                </Field>
              ) : null}
              {form.type === 57 ? (
                <div className="rounded-control border border-warn/40 bg-warn-soft p-3 text-xs text-warn">
                  <p>{t("codexDisclaimer")}</p>
                  {editing ? (
                    <button type="button" className={buttonClass("secondary", "mt-2 h-8")} disabled={codexBusy} onClick={() => void refreshCodex()}>
                      {codexBusy ? t("refreshing") : t("refresh")}
                    </button>
                  ) : null}
                  {codexNote ? <p className="mt-2">{codexNote}</p> : null}
                </div>
              ) : null}
              {![3, 41, 45].includes(form.type) && [18, 21, 39, 49].includes(form.type) ? (
                <Field label={t(otherFieldLabel(form.type) as "otherGeneric")}>
                  <input className={fieldClass} value={form.other} placeholder={placeholderText(form.type)} onChange={(event) => patch({ other: event.target.value })} />
                </Field>
              ) : null}
              {form.type !== 45 ? (
                <Field label={t("baseUrl")} hint={urlWarning ?? undefined}>
                  <input className={fieldClass} value={form.base_url} placeholder="https://api.openai.com" onChange={(event) => patch({ base_url: event.target.value })} />
                </Field>
              ) : urlWarning ? <p className="text-xs text-warn">{urlWarning}</p> : null}
              <Field label={t("models")}>
                <input className={fieldClass} value={form.models} placeholder={t("modelsPlaceholder")} onChange={(event) => patch({ models: event.target.value })} />
              </Field>
              <Field label={t("group")}>
                <input className={fieldClass} value={form.group.join(",")} onChange={(event) => patch({ group: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} />
              </Field>
              <Field label={editing ? t("keyEdit") : t("key")} hint={typeMeta.keyHint || undefined}>
                <textarea className={`${fieldClass} h-28 py-2 font-mono`} value={form.key} placeholder={typeMeta.keyHint || t("keyPlaceholder")} onChange={(event) => patch({ key: event.target.value })} />
              </Field>
              <p className="text-xs text-secondary">{t("recognized", { count: keys.length })}</p>
              {lineWarnings.map((item) => (
                <p key={item.index} className="text-xs text-warn">{t("lineWarning", { line: item.index + 1, text: t(item.text as "warnSk") })}</p>
              ))}
              {duplicateLines.length ? <p className="text-xs text-warn">{t("duplicateInput", { lines: duplicateLines.join(", ") })}</p> : null}
              {existingDupes > 0 ? <p className="text-xs text-warn">{t("duplicateExisting", { count: existingDupes })}</p> : null}
              <Field label={t("addMode")}>
                <select className={fieldClass} value={form.multi_key_mode} onChange={(event) => patch({ multi_key_mode: event.target.value as ChannelFormValues["multi_key_mode"] })}>
                  <option value="single">{t("modeSingle")}</option>
                  <option value="batch">{t("modeBatch")}</option>
                  <option value="multi_to_single">{t("modeMulti")}</option>
                </select>
              </Field>
            </>
          ) : null}
          {tab === "routing" ? (
            <>
              <Field label={t("priority")}>
                <input className={fieldClass} type="number" value={form.priority ?? 0} onChange={(event) => patch({ priority: Number(event.target.value) })} />
              </Field>
              <Field label={t("weight")}>
                <input className={fieldClass} type="number" value={form.weight ?? 0} onChange={(event) => patch({ weight: Number(event.target.value) })} />
              </Field>
              <Field label={t("testModel")}>
                <input className={fieldClass} value={form.test_model} placeholder={t("testModelPlaceholder")} onChange={(event) => patch({ test_model: event.target.value })} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.auto_ban !== 0} onChange={(event) => patch({ auto_ban: event.target.checked ? 1 : 0 })} />
                {t("autoBan")}
              </label>
              <Field label={t("modelMapping")}>
                <textarea className={`${fieldClass} h-28 py-2 font-mono`} value={form.model_mapping} placeholder='{"gpt-4o-mini":"gpt-4o-mini"}' onChange={(event) => patch({ model_mapping: event.target.value })} />
              </Field>
            </>
          ) : null}
          {tab === "request" ? (
            <>
              <Field label={t("statusMapping")}>
                <textarea className={`${fieldClass} h-20 py-2 font-mono`} value={form.status_code_mapping} placeholder='{"429":"500"}' onChange={(event) => patch({ status_code_mapping: event.target.value })} />
              </Field>
              <Field label={t("paramOverride")}>
                <textarea className={`${fieldClass} h-20 py-2 font-mono`} value={form.param_override} placeholder="{}" onChange={(event) => patch({ param_override: event.target.value })} />
              </Field>
              <Field label={t("headerOverride")}>
                <textarea className={`${fieldClass} h-20 py-2 font-mono`} value={form.header_override} placeholder="{}" onChange={(event) => patch({ header_override: event.target.value })} />
              </Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.force_format)} onChange={(event) => patch({ force_format: event.target.checked })} />{t("forceFormat")}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.thinking_to_content)} onChange={(event) => patch({ thinking_to_content: event.target.checked })} />{t("thinking")}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.pass_through_body_enabled)} onChange={(event) => patch({ pass_through_body_enabled: event.target.checked })} />{t("passThrough")}</label>
              <Field label={t("systemPrompt")}>
                <textarea className={`${fieldClass} h-20 py-2`} value={form.system_prompt} onChange={(event) => patch({ system_prompt: event.target.value })} />
              </Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.system_prompt_override)} onChange={(event) => patch({ system_prompt_override: event.target.checked })} />{t("overridePrompt")}</label>
              {[1, 14, 57, 58, 59, 60].includes(form.type) ? (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.allow_service_tier)} onChange={(event) => patch({ allow_service_tier: event.target.checked })} />{t("serviceTier")}</label>
              ) : null}
              {form.type === 14 ? (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.claude_beta_query)} onChange={(event) => patch({ claude_beta_query: event.target.checked })} />{t("claudeBeta")}</label>
              ) : null}
              {[1, 57].includes(form.type) ? (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.disable_store)} onChange={(event) => patch({ disable_store: event.target.checked })} />{t("disableStore")}</label>
              ) : null}
            </>
          ) : null}
          {tab === "other" ? (
            <>
              <Field label={t("tag")}>
                <input className={fieldClass} value={form.tag} onChange={(event) => patch({ tag: event.target.value })} />
              </Field>
              <Field label={t("remark")}>
                <input className={fieldClass} value={form.remark} onChange={(event) => patch({ remark: event.target.value })} />
              </Field>
              <Field label={t("proxy")}>
                <input className={fieldClass} value={form.proxy} placeholder={t("proxyPlaceholder")} onChange={(event) => patch({ proxy: event.target.value })} />
              </Field>
              <Field label={t("httpProtocol")}>
                <select className={fieldClass} value={form.http_protocol} onChange={(event) => patch({ http_protocol: event.target.value as ChannelFormValues["http_protocol"] })}>
                  <option value="auto">{t("httpAuto")}</option>
                  <option value="http1">HTTP/1.1</option>
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.upstream_model_update_check_enabled)} onChange={(event) => patch({ upstream_model_update_check_enabled: event.target.checked })} />{t("upstreamModels")}</label>
            </>
          ) : null}
          {volcUnlocked && form.type === 45 ? <p className="text-xs text-warn">{t("volcUnlocked")}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <button type="button" className={buttonClass("secondary")} onClick={onClose}>{common("cancel")}</button>
          <button type="button" className={buttonClass("secondary")} disabled={busy || !editing} title={editing ? undefined : t("testAfterSave")} onClick={() => { if (editing) void onTest(editing.id, form.test_model || ""); }}>{t("testConnection")}</button>
          <button type="submit" className={buttonClass("primary")} disabled={busy}>{busy ? common("saving") : editing ? t("updateChannel") : t("createChannel")}</button>
        </div>
      </form>
    </div>
  );
}
