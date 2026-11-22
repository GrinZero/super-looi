// 0.171.0 is the latest stable release verified to resolve only the legacy catalog.
export const lastLegacyCloudCliVersion = "0.171.0";

export interface CodexCloudEnvironment {
  id: string;
  name: string;
  scope: "user" | "workspace" | "legacy";
}

export interface CodexPluginState {
  cliVersion?: string;
  latestCliVersion?: string;
  cliUpdateAvailable?: boolean;
  currentCloudSubmitUnsupported?: boolean;
  cloudEnvironments?: CodexCloudEnvironment[];
  environment: string;
  branch: string;
}

export type CodexPluginCommand =
  | { readonly type: "save_cloud_defaults"; readonly environment: string; readonly branch: string }
  | { readonly type: "check_cli_update" }
  | { readonly type: "install_cli_update" }
  | { readonly type: "load_cloud_environments" };
