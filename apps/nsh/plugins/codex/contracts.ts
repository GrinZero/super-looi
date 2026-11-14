export interface CodexPluginState {
  cliVersion?: string;
  environment: string;
  branch: string;
}

export type CodexPluginCommand = {
  readonly type: "save_cloud_defaults";
  readonly environment: string;
  readonly branch: string;
};
