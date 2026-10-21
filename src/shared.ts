import * as React from "react";
import { Button as PrimitiveButton, SegmentedTabs } from "@deepseek-ai/dsh-client-ui-primitives";

declare const module: { exports: Record<string, unknown> };
const section = module.exports as { getRootBrandIcon: (key: string) => React.ReactElement };

/** 16×16 线性图标，与技能页工具栏同一画法。 */
export function strokeIcon(d: string) {
  return React.createElement(
    "svg",
    { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true, focusable: "false" },
    React.createElement("path", { d, fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }),
  );
}

export function filterActionButton(label: string, icon: React.ReactElement, onClick: () => void, disabled?: boolean) {
  return React.createElement(PrimitiveButton, {
    className: "dssm-icon-action",
    variant: "outline",
    size: "sm",
    disabled: disabled,
    "aria-label": label,
    title: label,
    icon: icon,
    style: {
      width: 22, minWidth: 22, height: 22, padding: 0,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: "var(--dsw-radius-sm, 8px)",
    },
    onClick: onClick,
  });
}

/** 来源品牌图标，与技能页 renderRootIcon 一致。 */
export function brandIcon(key: string) {
  return React.createElement(
    "span",
    { className: "dssm-brand-icon", "aria-hidden": true, style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, flexShrink: 0 } },
    section.getRootBrandIcon(key),
  );
}

export function modeTabs(options: { value: string; onChange: (value: string) => void }) {
  return React.createElement(SegmentedTabs, {
    className: "dssm-scope-tabs dssm-mode-tabs",
    label: "仓库视图",
    value: options.value,
    onChange: options.onChange,
    items: [
      { value: "skills", id: "dshv-mode-skills", panelId: "dshv-mode-panel", label: "技能" },
      { value: "mcp", id: "dshv-mode-mcp", panelId: "dshv-mode-panel", label: "MCP" },
    ],
  });
}
