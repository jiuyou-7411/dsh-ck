import * as React from "react";

/**
 * 本地技能名的联网兜底翻译。
 *
 * 静态表（client.ts 内联的 ZH_SKILL_NAME）只覆盖开发这台机器上出现的技能；
 * 别的用户装了不同的技能，名字就是英文的。这里把静态表没命中的名字
 * 批量发给宿主 /dsh-skill-mcp-vault/api/translate，只翻“名字”，不翻描述
 * （描述长，会把 MyMemory 的每日字符额度一次吃光）。
 */

const ENDPOINT = "/dsh-skill-mcp-vault/api/translate";
const BATCH = 20;

export function skillKey(name: string) {
  // 统一前缀，和发现页的 clawhub: / owner/repo: 区分开
  return "skill:" + name;
}

export function useLiveSkillNames(names: string[], known: (name: string) => boolean) {
  const [live, setLive] = React.useState<Record<string, string>>({});
  const pending = React.useRef<Set<string>>(new Set());
  const mounted = React.useRef(true);

  React.useEffect(function () {
    mounted.current = true;
    return function () {
      mounted.current = false;
    };
  }, []);

  React.useEffect(
    function () {
      const wanted: string[] = [];
      const seen = new Set<string>();
      for (const name of names) {
        if (!name || seen.has(name)) continue;
        seen.add(name);
        if (known(name)) continue;
        if (live[name] !== undefined) continue;
        if (pending.current.has(name)) continue;
        wanted.push(name);
      }
      if (wanted.length === 0) return;
      const batch = wanted.slice(0, BATCH);
      for (const name of batch) pending.current.add(name);
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: batch.map(function (name) {
            return { key: skillKey(name), name: name, description: "" };
          }),
        }),
      })
        .then(function (response) {
          return response.ok ? response.json() : null;
        })
        .then(function (result) {
          if (!result || typeof result.items !== "object" || result.items === null) return;
          if (!mounted.current) return;
          const merged: Record<string, string> = {};
          for (const [key, value] of Object.entries(result.items)) {
            const row = value as { name?: string };
            if (!key.startsWith("skill:")) continue;
            if (typeof row?.name === "string" && row.name) merged[key.slice("skill:".length)] = row.name;
          }
          if (Object.keys(merged).length > 0) {
            setLive(function (previous) {
              return Object.assign({}, previous, merged);
            });
          }
        })
        .catch(function () {
          for (const name of batch) pending.current.delete(name);
        });
    },
    [names.join("\u0000")],
  );

  return live;
}
