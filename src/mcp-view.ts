import * as React from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { Input } from "./plugin-ui.js";
import { brandIcon, filterActionButton, strokeIcon } from "./shared.js";

// MCP 视图：沿用技能页的 .dssm-* 结构与样式，把数据源换成 MCP 服务。
// 数据来自仓库插件自己的 Host 接口（/dsh-skill-mcp-vault/api），不复制宿主逻辑。

const API = "/dsh-skill-mcp-vault/api";

type McpServer = {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  inVault: boolean;
  enabled: boolean;
  detail: string;
  /** 后端给的运行状态：connected / disabled / connecting-or-failed / not-loaded */
  state?: string;
  tools?: number;
};

type McpSource = {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  servers: McpServer[];
};

type GlobalView = {
  groups: Array<{
    id: string;
    label: string;
    detail?: string;
    paths?: string[];
    total: number;
    adopted: number;
    servers: Array<{
      name: string;
      transport: string;
      command?: string;
      args?: string[];
      url?: string;
      inVault: boolean;
      vaultEnabled: boolean;
      enabled: boolean;
    }>;
  }>;
  counts: { total: number; adopted: number; pending: number; sources: number; vault: number };
};

type VaultView = {
  file: string;
  servers: Array<{
    serverName: string;
    transport: string;
    command?: string;
    args?: string[];
    url?: string;
    enabled?: boolean;
    /** listMcp() 会把 loader 行的运行状态挂在这里 */
    status?: { state?: string; tools?: string[]; present?: boolean; enabled?: boolean };
  }>;
};

function call<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(API + path, Object.assign({ credentials: "same-origin", headers: { "content-type": "application/json" } }, init)).then(async function (response) {
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const failure = body as { error?: string } | undefined;
    if (!response.ok || (failure && typeof failure.error === "string")) {
      const message = (failure && failure.error) || "HTTP " + response.status + " " + path;
      // 只换了前端产物、后端进程还是旧的时会出现 unknown route，提示用户彻底重启。
      if (message.indexOf("unknown route") === 0) {
        throw new Error("插件后端还是旧版本，请完全退出 DSH NEXT 再打开（只刷新窗口不够）。");
      }
      throw new Error(message);
    }
    return body as T;
  });
}

function Switch(props: { checked: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  return React.createElement(
    "button",
    {
      type: "button",
      role: "switch",
      className: "dssm-enable-switch",
      "aria-checked": props.checked,
      "aria-label": props.label,
      disabled: props.disabled,
      onClick: props.onChange,
    },
    React.createElement("span", { className: "dssm-enable-switch-thumb" }),
  );
}

function Chevron() {
  return React.createElement(
    "svg",
    { viewBox: "0 0 16 16", width: 12, height: 12, fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
    React.createElement("path", { d: "M4 6.5 8 10.5 12 6.5" }),
  );
}

function stat(label: string, value: number) {
  return React.createElement("div", { className: "dssm-stat", key: label }, React.createElement("strong", null, String(value)), label);
}

/** 数组里放按钮需要 key，这里统一包一层，避免 React 警告。 */
function actionSlot(key: string, node: React.ReactElement) {
  return React.createElement("span", { key: key, style: { display: "inline-flex" } }, node);
}

/**
 * 仓库里那一行到底连上没有。
 * 「已启用」只是 mcp/mcp.json 里的开关，不代表进程握手成功 —— 这两件事必须分开说，
 * 否则用户会以为一个一次性 CLI 命令「已经在跑了」。
 */
function vaultStateOf(server: McpServer): { text: string; tone: string; hint: string } {
  if (!server.enabled) return { text: "已停用", tone: "dssm-disabled", hint: "" };
  if (server.state === "connected") {
    return { text: server.tools ? "已连接 · " + server.tools + " 个工具" : "已连接", tone: "dssm-enabled", hint: "" };
  }
  if (server.state === "not-loaded") {
    return { text: "未加载", tone: "dssm-shadowed", hint: "宿主还没为它建好 MCP 行，点工具栏的「重载 MCP 行」。" };
  }
  if (server.state === undefined) return { text: "已启用", tone: "dssm-enabled", hint: "" };
  return {
    text: "未连上",
    tone: "dssm-shadowed",
    hint: "进程可能起来了但没握手成功：多半是这条命令不是 MCP 服务（一次性 CLI 跑完就退出），或参数里的路径 / token 还是占位符。",
  };
}

export function McpView(props?: { initialView?: { global?: GlobalView; vault?: VaultView } }) {
  const [view, setView] = React.useState<{ global?: GlobalView; vault?: VaultView }>(props?.initialView ?? {});
  const [loading, setLoading] = React.useState(props?.initialView === undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const [sourceFilter, setSourceFilter] = React.useState("all");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const importRef = React.useRef<HTMLInputElement | null>(null);
  // Electron 里 window.prompt 是禁用的（点了没反应），新增服务必须用自己的弹窗。
  const [addOpen, setAddOpen] = React.useState(false);
  const [draft, setDraft] = React.useState({ name: "", transport: "stdio", command: "", args: "", cwd: "", url: "" });
  // 弹窗盖住了页面上的横幅，校验错误要显示在弹窗自己里面，否则用户以为点了没反应。
  const [addError, setAddError] = React.useState<string | null>(null);
  // 贴一个开源仓库地址，让后端去 README / package.json 里猜启动命令。
  const [source, setSource] = React.useState("");
  const [inspecting, setInspecting] = React.useState(false);
  const [sourceNote, setSourceNote] = React.useState<string | null>(null);

  const load = React.useCallback(function () {
    setLoading(true);
    Promise.all([call<GlobalView>("/global"), call<VaultView>("/mcp")])
      .then(function (result) {
        setView({ global: result[0], vault: result[1] });
        setError(null);
      })
      .catch(function (failure) {
        setError(String(failure && failure.message ? failure.message : failure));
      })
      .finally(function () {
        setLoading(false);
      });
  }, []);

  React.useEffect(function () {
    load();
  }, [load]);

  function perform(operation: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    return operation()
      .then(function () {
        load();
        if (message) setNotice(message);
      })
      .catch(function (failure) {
        setError(String(failure && failure.message ? failure.message : failure));
      })
      .finally(function () {
        setBusy(false);
      });
  }

  const globalView = view.global;
  const counts = (globalView && globalView.counts) || { total: 0, adopted: 0, pending: 0, sources: 0, vault: 0 };

  // 仓库本身作为第一个来源，其后是其它 Agent 的全局配置。
  const sources: McpSource[] = [];
  const vaultServers: McpServer[] = ((view.vault && view.vault.servers) || []).map(function (server) {
    return {
      name: server.serverName,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      inVault: true,
      enabled: server.enabled !== false,
      detail: server.transport === "stdio" ? [server.command].concat(server.args || []).filter(Boolean).join(" ") : server.url || "",
      // 「已启用」只代表这一行没被停用；真正连上没有要看 loader 行报回来的 state。
      state: server.status && server.status.state ? server.status.state : undefined,
      tools: server.status && Array.isArray(server.status.tools) ? server.status.tools.length : 0,
    };
  });
  sources.push({
    id: "vault",
    label: "插件 MCP 仓库",
    path: (view.vault && view.vault.file) || "mcp/mcp.json",
    exists: true,
    servers: vaultServers,
  });
  for (const group of (globalView && globalView.groups) || []) {
    if (group.id === "vault") continue;
    sources.push({
      id: group.id,
      label: group.label,
      path: group.detail || (group.paths || [])[0] || "",
      exists: (group.paths || []).length > 0,
      servers: (group.servers || []).map(function (server) {
        return {
          name: server.name,
          transport: server.transport,
          command: server.command,
          args: server.args,
          url: server.url,
          inVault: server.inVault === true,
          enabled: server.inVault === true && server.vaultEnabled === true,
          detail: server.transport === "stdio" ? [server.command].concat(server.args || []).filter(Boolean).join(" ") : server.url || "",
        };
      }),
    });
  }

  const needle = query.trim().toLowerCase();
  const visible = sources
    .filter(function (source) {
      return sourceFilter === "all" || source.id === sourceFilter;
    })
    .map(function (source) {
      const servers = source.servers.filter(function (server) {
        if (statusFilter === "on" && !server.enabled) return false;
        if (statusFilter === "off" && server.enabled) return false;
        if (needle === "") return true;
        return (server.name + " " + server.detail).toLowerCase().indexOf(needle) >= 0;
      });
      return Object.assign({}, source, { servers });
    })
    .filter(function (source) {
      if (source.servers.length > 0) return true;
      // 插件仓库是导入入口，空的时候也要留着，否则用户没有任何地方点"导入"。
      return source.id === "vault" && statusFilter === "all" && needle === "";
    });

  function toggleSource(source: McpSource) {
    const next = source.servers.some(function (server) {
      return server.enabled;
    });
    perform(function () {
      if (source.id === "vault") {
        return Promise.all(
          source.servers.map(function (server) {
            return call("/mcp/toggle", { method: "POST", body: JSON.stringify({ serverName: server.name, enabled: !next }) });
          }),
        );
      }
      return call("/global/toggle", { method: "POST", body: JSON.stringify({ sourceId: source.id, enabled: !next }) });
    }, source.id === "vault" ? (next ? "已停用 " + source.label : "已启用 " + source.label) : (next ? "已把 " + source.label + " 全部移出插件" : "已把 " + source.label + " 全部存入插件"));
  }

  function toggleServer(source: McpSource, server: McpServer) {
    perform(function () {
      if (source.id === "vault") {
        return call("/mcp/toggle", { method: "POST", body: JSON.stringify({ serverName: server.name, enabled: !server.enabled }) });
      }
      return server.enabled
        ? call("/mcp", { method: "DELETE", body: JSON.stringify({ serverName: server.name }) })
        : call("/global/adopt", { method: "POST", body: JSON.stringify({ serverName: server.name }) });
    }, source.id === "vault" ? (server.enabled ? "已停用 " + server.name : "已启用 " + server.name) : (server.enabled ? "已把 " + server.name + " 移出插件" : "已把 " + server.name + " 存入插件"));
  }

  function addServer() {
    setDraft({ name: "", transport: "stdio", command: "", args: "", cwd: "", url: "" });
    setAddError(null);
    setSource("");
    setSourceNote(null);
    setAddOpen(true);
  }

  /**
   * 贴 GitHub 仓库地址 → 后端读 README / package.json 猜出启动命令，填进表单。
   * 只填不存：识别结果一律让用户确认后再提交。
   */
  function inspectSource() {
    const url = source.trim();
    if (url === "") return;
    setInspecting(true);
    setAddError(null);
    setSourceNote(null);
    call<{
      serverName: string;
      transport: string;
      command: string;
      args: string[];
      url: string;
      confidence: string;
      evidence: string;
      notes: string[];
    }>("/mcp/inspect", { method: "POST", body: JSON.stringify({ url: url }) })
      .then(function (result) {
        setDraft({
          name: result.serverName || draft.name,
          transport: result.transport === "streamable-http" ? "streamable-http" : "stdio",
          command: result.command || "",
          args: (result.args || []).join(" "),
          cwd: "",
          url: result.url || "",
        });
        const level = result.confidence === "high" ? "高" : result.confidence === "medium" ? "中" : "低";
        const extra = (result.notes || []).length > 0 ? "；" + result.notes.join("；") : "";
        setSourceNote("已识别（可信度" + level + "）：" + result.evidence + extra);
      })
      .catch(function (failure) {
        setAddError(String(failure && failure.message ? failure.message : failure));
      })
      .finally(function () {
        setInspecting(false);
      });
  }

  function submitServer() {
    const name = draft.name.trim();
    if (name === "") {
      setAddError("请填服务名（字母、数字、连字符）。");
      return;
    }
    // 后端只认 [A-Za-z0-9_-]{1,32}，这里先拦一次，免得用户看到英文报错。
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      setAddError("服务名只能用字母、数字、下划线或连字符，最长 32 位。");
      return;
    }
    const body = draft.transport === "stdio"
      ? {
        serverName: name,
        transport: "stdio",
        command: draft.command.trim(),
        args: draft.args.split(/\s+/).filter(Boolean),
        ...draft.cwd.trim() === "" ? {} : { cwd: draft.cwd.trim() },
      }
      : { serverName: name, transport: "streamable-http", url: draft.url.trim() };
    if (draft.transport === "stdio" && body.command === "") {
      setAddError("stdio 服务需要启动命令。");
      return;
    }
    if (draft.transport === "streamable-http" && body.url === "") {
      setAddError("HTTP 服务需要 URL。");
      return;
    }
    setAddError(null);
    perform(function () {
      return call("/mcp", { method: "POST", body: JSON.stringify(body) });
    }, "已存入插件 MCP 仓库：" + name);
    setAddOpen(false);
  }

  // 导出成和 mcp/mcp.json 同构的 JSON 写进下载目录，导完顺便定位到文件。
  function exportServers(serverName?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    call<{ file: string; directory: string; count: number }>("/mcp/export", {
      method: "POST",
      body: JSON.stringify(serverName === undefined ? {} : { serverName: serverName }),
    })
      .then(function (result) {
        setNotice("已导出 " + result.count + " 个服务到 " + result.file);
        return call("/reveal", { method: "POST", body: JSON.stringify({ path: result.file }) }).catch(function () {});
      })
      .catch(function (failure) {
        setError(String(failure && failure.message ? failure.message : failure));
      })
      .finally(function () {
        setBusy(false);
      });
  }

  function importServers(file: File) {
    setBusy(true);
    setError(null);
    setNotice(null);
    file
      .text()
      .then(function (text) {
        return call<{ added: string[]; updated: string[]; failed: Array<{ name: string; error: string }> }>("/mcp/import", {
          method: "POST",
          body: JSON.stringify({ json: text }),
        });
      })
      .then(function (result) {
        const names = result.added.concat(result.updated);
        setNotice("已导入：" + names.join("、") + (result.failed.length ? "；" + result.failed.length + " 条失败" : ""));
        load();
      })
      .catch(function (failure) {
        setError(String(failure && failure.message ? failure.message : failure));
      })
      .finally(function () {
        setBusy(false);
      });
  }

  function removeServer(server: McpServer) {
    if (!window.confirm("从插件 MCP 仓库删除 " + server.name + "？其它 Agent 的配置文件不受影响。")) return;
    perform(function () {
      return call("/mcp", { method: "DELETE", body: JSON.stringify({ serverName: server.name }) });
    }, "已从插件仓库删除 " + server.name);
  }

  const head = React.createElement(
    "div",
    { className: "dssm-head" },
    React.createElement(
      "div",
      { className: "dssm-title-block" },
      React.createElement("div", { className: "dssm-title-row" }, React.createElement("h1", { className: "dssm-title" }, "MCP")),
      React.createElement("p", { className: "dssm-desc" }, "统一加载和管理本机 MCP 服务。"),
    ),
  );

  const summary = React.createElement(
    "div",
    { className: "dssm-summary" },
    stat("个 MCP 服务", counts.total),
    stat("个已接入", counts.adopted),
    stat("个待接入", counts.pending),
    stat("个来源", counts.sources),
  );

  const filters = React.createElement(
    "div",
    { className: "dssm-filters" },
    React.createElement(
      "select",
      {
        className: "dssm-menu-select-trigger dssm-source-filter",
        value: sourceFilter,
        "aria-label": "全部来源",
        onChange: function (event: { target: { value: string } }) {
          setSourceFilter(event.target.value);
        },
      },
      React.createElement("option", { value: "all" }, "全部来源"),
      sources.map(function (source) {
        return React.createElement("option", { key: source.id, value: source.id }, source.label + "（" + source.servers.length + "）");
      }),
    ),
    React.createElement(
      "select",
      {
        className: "dssm-menu-select-trigger dssm-status-filter",
        value: statusFilter,
        "aria-label": "全部状态",
        onChange: function (event: { target: { value: string } }) {
          setStatusFilter(event.target.value);
        },
      },
      React.createElement("option", { value: "all" }, "全部状态"),
      React.createElement("option", { value: "on" }, "已接入"),
      React.createElement("option", { value: "off" }, "未接入"),
    ),
    React.createElement(Input, {
      value: query,
      className: "dssm-search",
      placeholder: "搜索服务名称或命令",
      onChange: function (value: string) {
        setQuery(value);
      },
    }),
    React.createElement(
      "div",
      { className: "dssm-filter-actions" },
      filterActionButton("刷新", strokeIcon("M13.5 8A5.5 5.5 0 118 2.5c2.3 0 4.3 1.4 5.1 3.5m.4-3.5v3.5H10"), load, busy),
      filterActionButton("重载 MCP 行", strokeIcon("M3.5 8a4.5 4.5 0 018-2.8M12.5 8a4.5 4.5 0 01-8 2.8M11 2.5v3H8M5 13.5v-3h3"), function () {
        perform(function () {
          return call("/mcp/reload", { method: "POST", body: "{}" });
        }, "已重载 MCP 行");
      }, busy),
    ),
  );

  const cards = visible.map(function (source) {
    const isOpen = open[source.id] === true;
    const enabled = source.servers.some(function (server) {
      return server.enabled;
    });
    return React.createElement(
      "div",
      { className: "dssm-source", key: source.id },
      React.createElement(
        "div",
        { className: "dssm-source-head" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "dssm-source-toggle",
            "aria-expanded": isOpen,
            onClick: function () {
              setOpen(Object.assign({}, open, { [source.id]: !isOpen }));
            },
          },
          React.createElement("span", { className: "dssm-fold-chevron" + (isOpen ? " is-open" : "") }, React.createElement(Chevron)),
          React.createElement(
            "span",
            { className: "dssm-source-label" },
            brandIcon(source.id),
            React.createElement("span", { className: "dssm-source-title" }, source.label),
            React.createElement("span", { className: "dssm-count" }, source.servers.length + " 个服务"),
            React.createElement("span", { className: "dssm-source-path", title: source.path }, source.id === "vault" ? "插件包 · mcp/mcp.json" : source.path),
          ),
        ),
        React.createElement(
          "div",
          { className: "dssm-source-actions" },
          source.id === "vault"
            ? [
              actionSlot("add", filterActionButton("新增 MCP 服务", strokeIcon("M8 3v10M3 8h10"), function () {
                addServer();
              }, busy)),
              actionSlot("import", filterActionButton("导入 MCP 配置", strokeIcon("M8 2.5v7M5.2 7.2 8 10l2.8-2.8M3.5 13.5h9"), function () {
                if (importRef.current === null) return;
                importRef.current.value = "";
                importRef.current.click();
              }, busy)),
              actionSlot("export", filterActionButton("导出插件 MCP 仓库", strokeIcon("M8 10.5V3M5.2 6 8 3.2 10.8 6M3 13.5h10"), function () {
                exportServers();
              }, busy || source.servers.length === 0)),
            ]
            : null,
          React.createElement(Switch, {
            checked: enabled,
            disabled: busy || source.servers.length === 0,
            label: source.id === "vault" ? source.label + " 整体启停" : source.label + " 全部存入插件",
            onChange: function () {
              toggleSource(source);
            },
          }),
        ),
      ),
      isOpen
        ? React.createElement(
          "div",
          { className: "dssm-skill-list" },
          source.servers.length === 0
            ? React.createElement("div", { className: "dssm-empty" }, source.id === "vault"
              ? "插件里还没有 MCP 服务。点上面的导入按钮选一个 JSON，或从下面其它来源把服务接入进来。"
              : source.exists ? "这个来源没有服务。" : "没有这个配置文件。")
            : source.servers.map(function (server) {
              const vaultState = source.id === "vault" ? vaultStateOf(server) : null;
              return React.createElement(
                "div",
                { className: "dssm-skill-row", key: server.name },
                React.createElement(
                  "div",
                  { className: "dssm-skill-copy" },
                  React.createElement(
                    "div",
                    { className: "dssm-name" },
                    server.name,
                    React.createElement("span", { className: "dssm-count" }, " " + server.transport),
                  ),
                  React.createElement("div", { className: "dssm-skill-desc", title: server.detail }, server.detail || "（缺启动信息）"),
                  vaultState && vaultState.hint !== "" ? React.createElement("div", { className: "dssm-note" }, vaultState.hint) : null,
                ),
                React.createElement(
                  "div",
                  { className: "dssm-skill-actions" },
                  source.id === "vault"
                    ? actionSlot("export", filterActionButton("导出 " + server.name, strokeIcon("M8 10.5V3M5.2 6 8 3.2 10.8 6M3 13.5h10"), function () {
                      exportServers(server.name);
                    }, busy))
                    : null,
                  source.id === "vault"
                    ? actionSlot("remove", filterActionButton("从插件仓库删除 " + server.name, strokeIcon("M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3M4.4 4.5l.6 8h6l.6-8"), function () {
                      removeServer(server);
                    }, busy))
                    : null,
                  vaultState
                    ? React.createElement("span", { className: vaultState.tone }, vaultState.text)
                    : React.createElement("span", { className: server.enabled ? "dssm-enabled" : "dssm-shadowed" }, server.enabled ? "已存入插件" : "未存入"),
                  React.createElement(Switch, {
                    checked: server.enabled,
                    disabled: busy,
                    label: source.id === "vault" ? server.name + " 启停" : server.name + " 存入插件",
                    onChange: function () {
                      toggleServer(source, server);
                    },
                  }),
                ),
              );
            }),
        )
        : null,
    );
  });

  // 宿主的 Input 在不同版本里回调的是值或事件，这里两种都接。
  function fieldValue(input: unknown): string {
    if (typeof input === "string") return input;
    const event = input as { target?: { value?: string } } | undefined;
    return event && event.target && typeof event.target.value === "string" ? event.target.value : "";
  }

  function textField(label: string, key: "name" | "command" | "args" | "cwd" | "url", placeholder: string) {
    return React.createElement(
      "label",
      { className: "dssm-field", key: key },
      React.createElement("span", { className: "dssm-label" }, label),
      React.createElement(Input, {
        value: draft[key],
        placeholder: placeholder,
        onChange: function (input: unknown) {
          setDraft(Object.assign({}, draft, { [key]: fieldValue(input) }));
        },
      }),
    );
  }

  const addDialog = addOpen
    ? React.createElement(
      Modal,
      {
        // 宿主 Modal 是受控的：不传 open 就直接 return null（点了"没反应"就是这个原因）。
        // 技能页能弹出来，是因为 client.ts 里自己包了一层固定 open: true，这里照抄那套 props。
        open: true,
        title: "新增 MCP 服务",
        closeLabel: "关闭",
        className: "dssm-modal",
        contentClassName: "dssm-modal-content",
        onClose: function () { setAddOpen(false); },
        footer: React.createElement(
          React.Fragment,
          null,
          React.createElement(Button, { variant: "outline", onClick: function () { setAddOpen(false); } }, "取消"),
          React.createElement(Button, { variant: "primary", disabled: busy, onClick: submitServer }, "存入插件仓库"),
        ),
      },
      React.createElement(
        "div",
        { className: "dssm-form" },
        // 贴地址自动识别，识别完仍然要用户确认再提交。
        React.createElement(
          "label",
          { className: "dssm-field" },
          React.createElement("span", { className: "dssm-label" }, "开源 MCP 地址（可选，自动识别）"),
          React.createElement(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "center" } },
            React.createElement(Input, {
              value: source,
              placeholder: "https://github.com/owner/repo",
              onChange: function (input: unknown) {
                setSource(fieldValue(input));
              },
            }),
            React.createElement(
              Button,
              { variant: "outline", size: "sm", disabled: inspecting || source.trim() === "", onClick: inspectSource },
              inspecting ? "识别中…" : "自动识别",
            ),
          ),
          sourceNote ? React.createElement("span", { className: "dssm-help" }, sourceNote) : null,
        ),
        textField("服务名", "name", "例如 filesystem"),
        React.createElement(
          "label",
          { className: "dssm-field" },
          React.createElement("span", { className: "dssm-label" }, "传输方式"),
          React.createElement(
            "select",
            {
              className: "dssm-menu-select-trigger",
              value: draft.transport,
              onChange: function (event: { target: { value: string } }) {
                setDraft(Object.assign({}, draft, { transport: event.target.value }));
              },
            },
            React.createElement("option", { value: "stdio" }, "stdio（本地命令）"),
            React.createElement("option", { value: "streamable-http" }, "streamable-http（URL）"),
          ),
        ),
        draft.transport === "stdio" ? textField("启动命令", "command", "例如 npx") : null,
        draft.transport === "stdio" ? textField("参数（空格分隔）", "args", "例如 -y @modelcontextprotocol/server-filesystem D:\\data") : null,
        // 相对路径的启动命令（node build/index.js）要靠 cwd 才能跑起来，所以给一个可选的工作目录。
        draft.transport === "stdio" ? textField("工作目录（可选）", "cwd", "命令里的相对路径以它为基准，例如 D:\\projects\\my-mcp") : null,
        draft.transport === "streamable-http" ? textField("URL", "url", "例如 https://example.com/mcp") : null,
        addError ? React.createElement("div", { className: "dssm-feedback dssm-error" }, addError) : null,
      ),
    )
    : null;

  return React.createElement(
    "section",
    { className: "dssm-section" },
    React.createElement("input", {
      ref: importRef,
      type: "file",
      accept: ".json,application/json",
      className: "dssm-hidden-input",
      onChange: function (event: { target: { files: FileList | null; value: string } }) {
        const file = event.target.files && event.target.files[0];
        event.target.value = "";
        if (file) importServers(file);
      },
    }),
    head,
    error ? React.createElement("div", { className: "dssm-feedback dssm-error" }, error) : null,
    notice ? React.createElement("div", { className: "dssm-feedback" }, notice) : null,
    summary,
    filters,
    loading && cards.length === 0
      ? React.createElement("div", { className: "dssm-empty" }, "加载中…")
      : cards.length === 0
        ? React.createElement("div", { className: "dssm-empty" }, "没有匹配的 MCP 服务。")
        : React.createElement("div", { className: "dssm-sources" }, cards),
    addDialog,
  );
}
