import * as React from "react";
// 引入整个 dsh-skills-manager 客户端实现：它的组件与 CSS 原样保留，
// 页面外壳与 MCP 视图在这个文件里组装，最终导出为仓库插件的客户端模块。
import "./client.js";
import { McpView } from "./mcp-view.js";
import { modeTabs } from "./shared.js";

declare const module: { exports: Record<string, unknown> };

const section = module.exports as {
  CSS: string;
  DICT: unknown;
  NS: string;
  SkillManagerSection: (props: Record<string, unknown>) => React.ReactElement;
};

const IMPORT_CSS = `.dssm-copy-global{display:flex;flex:1 1 auto;flex-direction:column;gap:10px;min-width:0;min-height:0;overflow:hidden}.dssm-copy-global .dssm-search{flex:none;width:100%;box-sizing:border-box}.dssm-copy-global .dssm-sources{flex:1 1 auto;min-height:120px;max-height:none;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:2px}.dssm-copy-row{cursor:pointer}.dssm-copy-check{margin:0;flex:none;width:15px;height:15px;cursor:pointer}.dssm-copy-actions{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:10px}.dssm-import-tabs{flex:none;margin-bottom:2px}.dssm-modal-import .dssm-modal-content>div:last-child{display:flex;flex-direction:column;min-height:0}`

const PAGE_CSS = `.dshv-page{box-sizing:border-box;height:100%;max-height:100%;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable}.dshv-page .dssm-mode-tabs{position:sticky;top:0;z-index:5;background:var(--dsw-alias-bg-layer-1,#1b1b1b);margin-bottom:14px}`

const MODE_CSS = `.dssm-mode-tabs{grid-template-columns:repeat(2,minmax(0,1fr))!important;margin-bottom:14px}.dssm-mode-tabs>span[aria-hidden="true"],.dssm-mode-tabs>[class*="indicator"]{width:calc((100% - 4px)/2)!important;inset:2px auto 2px 2px!important;transform:translateX(0)!important}[data-mode="mcp"] .dssm-mode-tabs>span[aria-hidden="true"],[data-mode="mcp"] .dssm-mode-tabs>[class*="indicator"]{transform:translateX(calc(100% + 0px))!important}`

/** main 键控面板的 owner 提供的标准 props，这里给出只读默认实现。 */
function standardProps() {
  const snapshot = { id: "dsh-skill-mcp-vault", title: "仓库", workspaces: [], sessions: [] };
  const select = (value: unknown) => (selector?: (input: unknown) => unknown) =>
    typeof selector === "function" ? selector(value) : value;
  return {
    useRemoteAccess: () => true,
    useResource: select({}),
    useWorkspaces: select(snapshot),
    usePanelInfo: select(snapshot),
    useSessions: select([]),
    useSessionStatus: select("idle"),
    useSessionRetainInfo: select({}),
    useSessionAccess: () => true,
    useWorkspaceAccess: () => true,
  };
}

function Panel(props: Record<string, unknown>) {
  const [mode, setMode] = React.useState((props.initialMode as string | undefined) || "skills");
  const body =
    mode === "mcp"
      ? React.createElement(McpView, { initialView: (props as Record<string, unknown>).initialMcpView as never })
      : React.createElement(section.SkillManagerSection, props);
  return React.createElement(
    "div",
    { className: "dshv-page", "data-mode": mode, style: { padding: "18px 20px 28px" } },
    React.createElement("style", null, section.CSS + MODE_CSS + PAGE_CSS + IMPORT_CSS),
    modeTabs({ value: mode, onChange: setMode }),
    body,
  );
}

function Icon(props: { size?: number; active?: boolean }) {
  const size = props.size || 20;
  return React.createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      style: { display: "block" },
    },
    React.createElement("rect", { x: 3, y: 6, width: 18, height: 14, rx: 3 }),
    React.createElement("path", { d: "M3 11h18" }),
    React.createElement("circle", { cx: 12, cy: 16, r: 2.2 }),
    React.createElement("path", { d: "M12 3v3" }),
  );
}

const PANEL_ID = "dsh-skill-mcp-vault";

function apply(ctx: {
  locale: { register: (ns: string, dict: unknown) => () => void; bind: (ns: string) => unknown };
  slots: {
    inject: (name: string, callback: () => () => void) => () => void;
    register: (options: Record<string, unknown>, component: unknown) => () => void;
  };
  effect: (callback: () => (() => void) | void, label?: string) => void;
}) {
  ctx.effect(function () {
    return ctx.locale.register(section.NS, section.DICT);
  });

  ctx.slots.inject("sidebar.panellist", function () {
    return ctx.slots.register(
      { name: "sidebar.panellist", id: PANEL_ID, order: 30, label: () => "仓库", registrant: PANEL_ID },
      Icon,
    );
  });

  ctx.slots.inject("main", function () {
    return ctx.slots.register({ name: "main", key: PANEL_ID, registrant: PANEL_ID }, function (slotProps: Record<string, unknown>) {
      const t = ctx.locale.bind(section.NS);
      return React.createElement(
        Panel,
        Object.assign({}, standardProps(), slotProps, {
          t: t,
          close: function () {},
          useOriginalSkills: true,
        }),
      );
    });
  });
}

module.exports.inject = ["slots", "locale"];
module.exports.apply = apply;
