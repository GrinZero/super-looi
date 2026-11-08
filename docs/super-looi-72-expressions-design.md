# Super-LOOI 72 桌宠表情设计规范与视觉图鉴

基于 `apps/nsh/ui/RobotFace.tsx`、`apps/nsh/theme.json` 与 `apps/nsh/DESIGN.md` 的前台光学规范——纯黑省电 OLED 舞台（`#040405`）、纯平自发光暖米圆眼（`#E8DAC3` / `#FBF7F0`）、零瞳孔挖空与零白翳反光——将现有的 7 个基础表情扩展为 **6 大维度 × 12 个表情 = 72 个桌宠表情**。

## 1. 设计图板归档（`docs/artifacts/face-expressions/`）

- [01-hero-dock-showcase.png](artifacts/face-expressions/01-hero-dock-showcase.png)：具身桌面底座实装预览（5 个典型桌面瞬间）
- [02-core-and-joy-12.png](artifacts/face-expressions/02-core-and-joy-12.png)：卷一 · 核心交互与喜悦亲密（`#01, #03, #05, #07, #06, #09, #10, #13, #15, #16, #17, #20`）
- [03-moods-and-daily-12.png](artifacts/face-expressions/03-moods-and-daily-12.png)：卷二 · 微情绪小脾气与桌面日常（`#25, #27, #29, #30, #31, #33, #34, #18, #39, #40, #43, #44`）
- [04-agent-and-dock-12.png](artifacts/face-expressions/04-agent-and-dock-12.png)：卷三 · Agent 任务、具身底座与环境感知（`#49, #51, #52, #57, #61, #62, #63, #66, #67, #68, #70, #72`）
- [05-voice-and-affection-ext-12.png](artifacts/face-expressions/05-voice-and-affection-ext-12.png)：卷四 · 对话流转与亲密情感补完（`#02, #04, #08, #11, #12, #14, #19, #21, #22, #23, #24, #26`）
- [06-quirky-and-daily-ext-12.png](artifacts/face-expressions/06-quirky-and-daily-ext-12.png)：卷五 · 戏剧性格与桌面生活补完（`#28, #32, #35, #36, #37, #38, #41, #42, #45, #46, #47, #48`）
- [07-agent-and-embodied-ext-12.png](artifacts/face-expressions/07-agent-and-embodied-ext-12.png)：卷六 · Agent 状态与具身感知补完（`#50, #53, #54, #55, #56, #58, #59, #60, #64, #65, #69, #71`）

## 2. 五通道正交几何合成规则

1. **眼型基底（Eye Shape）**：实心圆 `orb`、上弦笑弧 `crescent_up`（`⌒`）、下弦闭眼弧 `crescent_down`（`︶`）、闭合线 `line`（`—`）、符号眼（`heart`、`star4`、`spiral`、`chevron` `><`）。严禁在圆眼内部挖黑瞳孔或叠加高光圆斑。
2. **眼睑遮罩（Eyelid Clip）**：无遮罩、顶部水平半耷、底部平托半月、内倾斜切 `\` `/`、外倾斜切 `/` `\`。
3. **双目姿态（Kinematics）**：左右独立等比缩放与整圆平移聚散，与实时 `gaze` 和 `blinkProgress` 叠加。
4. **眉嘴描边（Brow & Mouth）**：统一圆头描边（`face-stroke`），支持微笑弧、开口笑 `D`、惊讶圆 `o`、平直线 `—`、扁嘴 `︵`、波浪嘴 `~`、猫嘴 `ω`、折线嘴 `∧`、飞吻嘴 `3`、三点脉冲 `···`。
5. **平面微符号与语义色（Glyph & Tint）**：仅使用同色系平面几何路径微符号与低饱和语义色（`eye-core` 暖米、`destructive` 珊瑚红、`verified` 鼠尾草绿、`warning` 琥珀黄、柔粉腮红、冰雾蓝），不引入 3D Emoji 贴图或外部位图序列。

## 3. 全量 72 表情清单（`#01–#72`）

| 编号 | 图板 | Key | 中文名 | 场景分类 |
| :--- | :--- | :--- | :--- | :--- |
| `#01` | Sheet 02 | `neutral` | 陪伴待机 | 核心与语音 |
| `#02` | Sheet 05 | `listening` | 专注聆听 | 核心与语音 |
| `#03` | Sheet 02 | `thinking` | 凝神思考 | 核心与语音 |
| `#04` | Sheet 05 | `speaking` | 温和回应 | 核心与语音 |
| `#05` | Sheet 01 / 02 | `curious` | 歪头好奇 | 核心与语音 |
| `#06` | Sheet 02 | `sleeping` | 静谧休眠 | 核心与语音 |
| `#07` | Sheet 01 / 02 | `alarmed` | 紧急警觉 | 核心与语音 |
| `#08` | Sheet 05 | `wake_spark` | 唤醒亮眸 | 核心与语音 |
| `#09` | Sheet 02 | `aha_eureka` | 灵光一现 | 核心与语音 |
| `#10` | Sheet 02 | `confused` | 疑惑不解 | 核心与语音 |
| `#11` | Sheet 05 | `interrupted` | 打断收声 | 核心与语音 |
| `#12` | Sheet 05 | `wave_bye` | 温柔道别 | 核心与语音 |
| `#13` | Sheet 01 / 02 | `happy_squint` | 弯眼开心 | 喜悦与亲密 |
| `#14` | Sheet 05 | `laughing` | 开怀大笑 | 喜悦与亲密 |
| `#15` | Sheet 02 | `wink` | 俏皮眨眼 | 喜悦与亲密 |
| `#16` | Sheet 02 | `love_eyes` | 满眼喜欢 | 喜悦与亲密 |
| `#17` | Sheet 02 | `shy_blush` | 害羞脸红 | 喜悦与亲密 |
| `#18` | Sheet 03 | `starry_eyed` | 崇拜星星眼 | 喜悦与亲密 |
| `#19` | Sheet 05 | `smug_proud` | 得意骄傲 | 喜悦与亲密 |
| `#20` | Sheet 02 | `kitty_playful` | 卖萌猫嘴 | 喜悦与亲密 |
| `#21` | Sheet 05 | `touched_warm` | 感动眼润 | 喜悦与亲密 |
| `#22` | Sheet 05 | `kissy` | 飞吻比心 | 喜悦与亲密 |
| `#23` | Sheet 05 | `excited_bounce` | 雀跃期待 | 喜悦与亲密 |
| `#24` | Sheet 05 | `zen_content` | 满足惬意 | 喜悦与亲密 |
| `#25` | Sheet 03 | `pouty` | 委屈扁嘴 | 小脾气与戏剧反应 |
| `#26` | Sheet 05 | `sad_droop` | 失落难过 | 小脾气与戏剧反应 |
| `#27` | Sheet 03 | `teary_cry` | 委屈落泪 | 小脾气与戏剧反应 |
| `#28` | Sheet 06 | `grumpy_puff` | 傲娇鼓腮 | 小脾气与戏剧反应 |
| `#29` | Sheet 03 | `angry_glare` | 生气瞪眼 | 小脾气与戏剧反应 |
| `#30` | Sheet 03 | `speechless` | 无语凝噎 | 小脾气与戏剧反应 |
| `#31` | Sheet 03 | `side_eye` | 暗中观察 | 小脾气与戏剧反应 |
| `#32` | Sheet 06 | `shocked` | 震惊瞳缩 | 小脾气与戏剧反应 |
| `#33` | Sheet 03 | `dizzy_spiral` | 晕头转向 | 小脾气与戏剧反应 |
| `#34` | Sheet 03 | `nervous_sweat` | 心虚冒汗 | 小脾气与戏剧反应 |
| `#35` | Sheet 06 | `mischievous` | 坏笑搞怪 | 小脾气与戏剧反应 |
| `#36` | Sheet 06 | `relieved_sigh` | 长舒一口气 | 小脾气与戏剧反应 |
| `#37` | Sheet 06 | `sleepy_drowsy` | 犯困打盹 | 桌面日常剧场 |
| `#38` | Sheet 06 | `yawning` | 张嘴哈欠 | 桌面日常剧场 |
| `#39` | Sheet 01 / 03 | `deep_snore` | 呼呼酣睡 | 桌面日常剧场 |
| `#40` | Sheet 01 / 03 | `coffee_sip` | 早安咖啡 | 桌面日常剧场 |
| `#41` | Sheet 06 | `munching` | 开心咀嚼 | 桌面日常剧场 |
| `#42` | Sheet 06 | `sipping_straw` | 吸管喝水 | 桌面日常剧场 |
| `#43` | Sheet 03 | `music_vibe` | 听歌律动 | 桌面日常剧场 |
| `#44` | Sheet 03 | `focus_glasses` | 专注学霸 | 桌面日常剧场 |
| `#45` | Sheet 06 | `reading_scan` | 阅读扫视 | 桌面日常剧场 |
| `#46` | Sheet 06 | `pomodoro_timer` | 计时守候 | 桌面日常剧场 |
| `#47` | Sheet 06 | `celebrate_party` | 庆祝撒花 | 桌面日常剧场 |
| `#48` | Sheet 06 | `bored_sigh` | 百无聊赖 | 桌面日常剧场 |
| `#49` | Sheet 04 | `coding_terminal` | 代码推演 | Agent 与工具状态 |
| `#50` | Sheet 07 | `searching_radar` | 检索搜寻 | Agent 与工具状态 |
| `#51` | Sheet 04 | `approval_ask` | 请求许可 | Agent 与工具状态 |
| `#52` | Sheet 04 | `task_verified` | 任务搞定 | Agent 与工具状态 |
| `#53` | Sheet 07 | `task_warning` | 执行受阻 | Agent 与工具状态 |
| `#54` | Sheet 07 | `memory_recall` | 翻阅记忆 | Agent 与工具状态 |
| `#55` | Sheet 07 | `memory_saved` | 铭记于心 | Agent 与工具状态 |
| `#56` | Sheet 07 | `sync_pulse` | 同步加载 | Agent 与工具状态 |
| `#57` | Sheet 04 | `privacy_shield` | 隐私静默 | Agent 与工具状态 |
| `#58` | Sheet 07 | `rate_limited` | 稍作喘息 | Agent 与工具状态 |
| `#59` | Sheet 07 | `offline_lost` | 断网迷茫 | Agent 与工具状态 |
| `#60` | Sheet 07 | `night_watch` | 暗夜值守 | Agent 与工具状态 |
| `#61` | Sheet 04 | `dock_snap` | 磁吸上座 | 具身底座与环境感知 |
| `#62` | Sheet 04 | `undock_float` | 腾空拿起 | 具身底座与环境感知 |
| `#63` | Sheet 04 | `drive_forward` | 全速前进 | 具身底座与环境感知 |
| `#64` | Sheet 07 | `turn_peek` | 侧身探头 | 具身底座与环境感知 |
| `#65` | Sheet 07 | `head_up_sky` | 昂首仰望 | 具身底座与环境感知 |
| `#66` | Sheet 04 | `head_down_floor` | 低头俯察 | 具身底座与环境感知 |
| `#67` | Sheet 04 | `charging_pulse` | 能量充沛 | 具身底座与环境感知 |
| `#68` | Sheet 04 | `low_battery` | 电量告急 | 具身底座与环境感知 |
| `#69` | Sheet 07 | `fill_light_glow` | 补光开启 | 具身底座与环境感知 |
| `#70` | Sheet 04 | `home_command` | 智控家居 | 具身底座与环境感知 |
| `#71` | Sheet 07 | `weather_sunny` | 晴日暖阳 | 具身底座与环境感知 |
| `#72` | Sheet 04 | `weather_rain_chill` | 听雨微凉 | 具身底座与环境感知 |
