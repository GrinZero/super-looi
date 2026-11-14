import type { JSX } from "nsh";
import type {
  CliReceipt,
  FaceStagePosture,
  PluginAuthSnapshot,
  PluginCategory,
  PluginDependencyStatus,
  PluginFailure,
  PluginLifecycleState,
  PluginManifest,
  PluginStagePresentation,
  StageDrawerDetent,
} from "../../runtime/plugins/shared-types";

export type {
  FaceStagePosture,
  PluginCategory,
  PluginDependencyStatus,
  PluginLifecycleState,
  PluginManifest,
  PluginStagePresentation,
  StageDrawerDetent,
};

export interface PluginViewContext<
  TState = Record<string, unknown>,
  TCommand = unknown,
> {
  readonly pluginId: string;
  readonly manifest: () => PluginManifest;
  readonly state: () => TState;
  readonly configuration: () => Record<string, string>;
  readonly enabled: () => boolean;
  readonly lifecycle: () => PluginLifecycleState;
  readonly dependencies: () => PluginDependencyStatus[];
  readonly busy: () => boolean;
  readonly uiError: () => string;
  readonly auth: () => PluginAuthSnapshot | undefined;
  readonly lastExecution: () => CliReceipt | undefined;
  readonly lastError: () => PluginFailure | undefined;
  readonly stagePresentation: () => PluginStagePresentation | undefined;
  readonly locale: () => "zh-CN" | "en-US";

  sendCommand: <TResult = unknown>(command: TCommand) => Promise<TResult | undefined>;
  configure: (values: Record<string, string>) => Promise<void>;
  refresh: () => Promise<void>;
  beginLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
  notify: (message: string) => void;
  exitStage: () => void;
  openStage: () => void;
  openPluginSettings: () => void;
}

export interface PluginUiModule<
  TState = any,
  TCommand = any,
> {
  readonly pluginId: string;
  readonly SettingsView?: (props: {
    ctx: PluginViewContext<TState, TCommand>;
  }) => JSX.Element;
  readonly StageCapsule?: (props: {
    ctx: PluginViewContext<TState, TCommand>;
  }) => JSX.Element;
  readonly StageDrawer?: (props: {
    ctx: PluginViewContext<TState, TCommand>;
    detent: () => StageDrawerDetent;
  }) => JSX.Element;
  readonly StageCanvas?: (props: {
    ctx: PluginViewContext<TState, TCommand>;
  }) => JSX.Element;
}
