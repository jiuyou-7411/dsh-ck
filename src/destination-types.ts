import type * as React from "react";
import type { Translate } from "./client-types.js";
import type { WorkspaceRow } from "./core.js";
import type { RepositoryDestination } from "./types.js";

/** 目标选择：用户目录（默认）、已登记工作区，或插件包内的 skills 仓库。位置只在用户目录下才有两项可选。 */
export type DestinationScope = "user" | "workspace" | "vault";
export interface DestinationValue {
  scope: DestinationScope;
  location: "dsh" | "agents";
  /** 已登记工作区路径；用户目录下为空串。 */
  workspace: string;
}
export type UserDestination = RepositoryDestination;
export interface DestinationPickerProps {
  t: Translate;
  value: DestinationValue;
  onChange: (next: Partial<DestinationValue>) => void;
  workspaces: readonly WorkspaceRow[];
  userDestinations: readonly UserDestination[];
  /** 创建与导入入口不开放 Shared Agent。 */
  allowAgents: boolean;
  /** 是否允许把技能写进插件包里的 skills 仓库（只有创建、导入弹窗开放）。 */
  allowVault?: boolean;
  disabled?: boolean;
}
export type DestinationPickerComponent = React.ComponentType<DestinationPickerProps>;
/** 注入给各入口的一套选择器能力，保证三处共用同一实现。 */
export interface DestinationKit {
  DestinationPicker: DestinationPickerComponent;
  defaultDestination: () => DestinationValue;
  destinationPayload: (value: DestinationValue) => { root?: "dsh" | "agents"; workspace?: string; vault?: true };
  destinationReady: (value: DestinationValue, workspaces: readonly WorkspaceRow[], userDestinations?: readonly UserDestination[]) => boolean;
}
