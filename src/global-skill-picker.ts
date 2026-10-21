import * as React from "react";
import { foldChevron } from "./plugin-ui.js";

/**
 * 导入弹窗的第二页签：从已装好的全局技能里挑选，复制到目标位置。
 *
 * 视觉完全复用原版面板的 .dssm-source 折叠卡片：
 *   卡片头 = 折叠箭头 + 来源图标 + 来源名 + 技能数 + 实际路径
 *   卡片体 = 每条技能一行，左侧勾选框，名字在上、描述在下
 * 这样和「全局技能」页里的卡片同一套样式，不再自造排布。
 */

export interface GlobalSkillRow {
  rootKey: string;
  rootLabel: string;
  rootPath: string;
  name: string;
  description: string;
  sourcePath: string;
}

export interface GlobalSkillGroup {
  key: string;
  label: string;
  path: string;
  rows: GlobalSkillRow[];
}

interface PickerProps {
  groups: GlobalSkillGroup[];
  loading: boolean;
  renderRootIcon: (key: string) => React.ReactNode;
  onCopy: (row: GlobalSkillRow) => Promise<string | null>;
  onDone: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
  h: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => React.ReactElement;
}

export function GlobalSkillPicker(props: PickerProps) {
  const { groups, loading, renderRootIcon, onCopy, t, h } = props;
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);

  const keyword = query.trim().toLowerCase();
  const filtered = groups.map(function (group) {
    const rows = keyword
      ? group.rows.filter(function (row) {
          return (row.name + " " + row.description).toLowerCase().indexOf(keyword) >= 0;
        })
      : group.rows;
    return { group: group, rows: rows };
  }).filter(function (entry) {
    return entry.rows.length > 0;
  });

  const picked: GlobalSkillRow[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      if (selected[group.key + "/" + row.name]) picked.push(row);
    }
  }

  function toggleGroup(key: string, rows: GlobalSkillRow[], on: boolean) {
    const next = Object.assign({}, selected);
    for (const row of rows) {
      if (on) next[key + "/" + row.name] = true;
      else delete next[key + "/" + row.name];
    }
    setSelected(next);
  }

  async function submit() {
    if (busy || picked.length === 0) return;
    setBusy(true);
    setFeedback(null);
    const failures: string[] = [];
    let done = 0;
    for (const row of picked) {
      const error = await onCopy(row);
      if (error) failures.push(row.name + "：" + error);
      else done += 1;
    }
    setBusy(false);
    if (failures.length === 0) {
      setFeedback(t("copyGlobal.done", { count: done }));
      setSelected({});
      props.onDone();
      return;
    }
    setFeedback(t("copyGlobal.partial", { count: done, failed: failures.length }) + " " + failures.slice(0, 3).join("；"));
  }

  return h(
    "div",
    { className: "dssm-copy-global" },
    h("input", {
      className: "dssm-input dssm-search",
      type: "search",
      value: query,
      placeholder: t("copyGlobal.search"),
      disabled: busy,
      onChange: function (event: React.ChangeEvent<HTMLInputElement>) {
        setQuery(event.target.value);
      },
    }),
    loading
      ? h("div", { className: "dssm-empty" }, t("copyGlobal.loading"))
      : filtered.length === 0
        ? h("div", { className: "dssm-empty" }, t("copyGlobal.empty"))
        : h(
            "div",
            { className: "dssm-sources" },
            filtered.map(function (entry) {
              const group = entry.group;
              const rows = entry.rows;
              const allSelected = rows.every(function (row) {
                return selected[group.key + "/" + row.name] === true;
              });
              // 默认全部收起；搜索时自动展开，方便直接看到命中项
              const open = expanded[group.key] === undefined ? keyword !== "" : expanded[group.key];
              return h(
                "section",
                { key: group.key, className: "dssm-source", "data-source-key": group.key },
                h(
                  "div",
                  { className: "dssm-source-head" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dssm-source-toggle",
                      "aria-expanded": open,
                      onClick: function () {
                        const next = Object.assign({}, expanded);
                        next[group.key] = !open;
                        setExpanded(next);
                      },
                    },
                    foldChevron(h, open),
                    h(
                      "div",
                      { className: "dssm-source-label" },
                      renderRootIcon(group.key),
                      h("span", { className: "dssm-source-title" }, group.label),
                      h("span", { className: "dssm-count" }, t("copyGlobal.count", { count: rows.length })),
                      h("span", { className: "dssm-source-path", title: group.path }, group.path),
                    ),
                  ),
                  h(
                    "div",
                    { className: "dssm-source-actions" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "dssm-upload-link",
                        disabled: busy,
                        onClick: function () {
                          toggleGroup(group.key, rows, !allSelected);
                        },
                      },
                      allSelected ? t("copyGlobal.unselectAll") : t("copyGlobal.selectAll"),
                    ),
                  ),
                ),
                open
                  ? h(
                      "div",
                      { className: "dssm-source-body", role: "region" },
                      rows.map(function (row) {
                        const key = group.key + "/" + row.name;
                        return h(
                          "label",
                          { key: key, className: "dssm-skill-row dssm-copy-row" },
                          h("input", {
                            type: "checkbox",
                            className: "dssm-copy-check",
                            checked: selected[key] === true,
                            disabled: busy,
                            onChange: function (event: React.ChangeEvent<HTMLInputElement>) {
                              const next = Object.assign({}, selected);
                              if (event.target.checked) next[key] = true;
                              else delete next[key];
                              setSelected(next);
                            },
                          }),
                          h(
                            "span",
                            { className: "dssm-skill-copy" },
                            h("span", { className: "dssm-name" }, row.name),
                            h("span", { className: "dssm-skill-desc", title: row.description }, row.description || t("note.missing")),
                          ),
                        );
                      }),
                    )
                  : null,
              );
            }),
          ),
    feedback ? h("div", { className: "dssm-feedback", role: "status" }, feedback) : null,
    h(
      "div",
      { className: "dssm-copy-actions" },
      h("span", { className: "dssm-count" }, t("copyGlobal.picked", { count: picked.length })),
      h(
        "button",
        { type: "button", className: "dssm-menu-select-trigger", disabled: busy || picked.length === 0, onClick: submit },
        busy ? t("copyGlobal.copying") : t("copyGlobal.copy"),
      ),
    ),
  );
}
