export const homedir = () => "/home";
export const tmpdir = () => "/tmp";
export const platform = () => "nsh";
export const arch = () => "arm64";
export const EOL = "\n";
export const cpus = () => [];
export const hostname = () => "looi";
export const type = () => "NSH";
export const release = () => "0.5.0";
export const constants = { signals: { SIGTERM: 15, SIGKILL: 9, SIGINT: 2 } };
export const userInfo = () => ({
  username: "looi",
  homedir: homedir(),
  shell: "sandbox",
  uid: 0,
  gid: 0,
});
export default {
  homedir,
  tmpdir,
  platform,
  arch,
  EOL,
  cpus,
  hostname,
  type,
  release,
  constants,
  userInfo,
};
