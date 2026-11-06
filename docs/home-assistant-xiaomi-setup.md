# 米家接入与运行

## 当前安装

当前 Mac 已运行 `super-looi-homeassistant`，入口为 http://localhost:8123 。米家 OAuth 与 Hub 访问令牌绑定已完成，已导入 45 台设备、1121 个实体。这是本机联调实例，尚未迁移到用户提到的 Mac mini。

- Home Assistant：2026.11.0，官方 ARM64 镜像摘要 `sha256:d486ced003d3b45b4e55fc4684fed76dccd2ce583b3618a92efe842abb26c3dc`。
- 官方 Xiaomi Home 集成源码：`75b3acb6325a3a8d295688b13904737d6738a6a5`，安装在 `data/home-assistant/custom_components/xiaomi_home`。
- 配置与账号数据：`data/home-assistant/`，受仓库 `data/` 忽略规则保护。
- 本机 Docker 20.10 不支持上游 zstd 镜像层；已用 `crane export` 解出官方镜像文件系统，并保留原始 Env、Entrypoint、WorkingDir 与 Labels 导入为 `super-looi/home-assistant:2026.11.0-compat`。源摘要与配置保存在 `data/home-assistant-image-config.json` 及本文。
- 容器设为 `unless-stopped` 自动重启；Docker Desktop 本身仍须运行。
- 本地账号初始化已完成。当前通过 `dns-sd -P` 临时发布 `homeassistant.local`，已实测回调入口可达；主机重启或网络地址改变后需重新发布，迁移时应配置稳定的名称解析。

## 完成账号绑定

1. 在浏览器完成 Home Assistant 本地账号创建与初始化。此账号独立于小米账号。
2. 设置 → 设备与服务 → 添加集成 → Xiaomi Home，按界面登录小米账号。
3. 地区选米家 App 实际使用的地区，导入全部目标家庭。设备能否导入取决于小米官方集成支持范围。
4. 官方集成 OAuth 回调固定使用 `http://homeassistant.local:8123`，授权所在浏览器必须能解析该主机名并访问此实例。Docker Desktop 的端口映射不会自动发布这个 mDNS 名称；如回调无法解析，需先配置此名称到当前主机，不能把本机 `localhost` 当作另一台主机地址。
5. Home Assistant 个人资料 → 安全 → 长期访问令牌，创建供 Super-LOOI 使用的令牌，写入根目录 `.env` 的 `HA_TOKEN`。不要将小米密码写入 Hub。
6. 确认 `.env` 的 `HA_URL` 指向此实例；`HA_ALLOWED_ENTITIES=*` 表示用户要求导入的全部实体，也可改成逗号分隔的指定实体。
7. 重启 Hub，打开 `/api/home/connection` 或手机家居页核对设备。

## 运行命令

现代 Docker 可直接使用官方镜像：

```sh
docker compose -f docker-compose.home.yml up -d
pnpm --filter @super-looi/hub dev
```

本机兼容镜像通过 `.env` 的 `HA_IMAGE=super-looi/home-assistant:2026.11.0-compat` 选择。该镜像只存在当前 Docker 实例；迁移到 Mac mini 时使用官方镜像和配置目录，不要假定兼容镜像已存在。

## 当前能力与验证边界

- 根目录 `.env` 的 `HA_TOKEN` 已配置并限制文件权限；`HA_INTEGRATION=xiaomi_home` 通过 HA WebSocket 注册表过滤集成，读入设备名称、房间与功能分类。
- Mobile 自动读取全部设备状态，支持常用控制 / 传感器 / 全部功能分类、搜索与分页；灯、风扇及已识别的基础电源开关提供控件，亮度与色温遵守设备范围。其他功能先只读；未知开关名、保护开关及受限设备不开放控制。
- Web 控制台使用真实设备列表及搜索，按批量状态接口获取数据；1100 实体的回归测试验证每次接口仅进行一次上游状态读取，不按实体并发轮询。
- 语音使用 `list_home_devices` 查询已导入状态，再用 `control_home_device` 控制明确的实体。门锁、安防等高危域仍拒绝控制。
- Hub 使用 REST 读状态、下发幂等服务后有界轮询确认；不因服务返回 200 就宣称成功，不自动重发未知结果的指令。
- 设备属性仅向客户端提供明确允许的遥测字段，不转发相机访问令牌或带凭据 URL；文本实体内容隐藏，避免包含设备密码。
- 已实测 Hub、Mobile、Web 读取真实状态；语音查询工具读取空气检测器的 6 项状态，其中 4 项可读。未触发物理设备动作；真实控制与控制后的物理回读仍待验收。
- 全仓 239 项测试、类型检查与构建通过，独立 review 无阻断项。当前 HA 返回部分设备 / 属性 unavailable，界面如实保留未知状态，不将导入数当作在线数。

官方资料：[小米官方集成](https://github.com/XiaoMi/ha_xiaomi_home/blob/main/doc/README_zh.md)、[Home Assistant REST API](https://contributors.home-assistant.io/core/internals/rest-api/)。
