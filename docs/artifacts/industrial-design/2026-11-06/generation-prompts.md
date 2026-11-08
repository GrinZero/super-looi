# Super-LOOI 工业设计图生成记录

日期：2026-11-06。使用内置 image_gen，两张图片均由主 agent 组织参考、构图和提示词。

参考：本目录 app-home-current.png（iPhone 16e 模拟器当前首页，原始截图像素方向为竖向，内容为横屏）；looi-official-reference.jpg（官方产品图，仅供外观参考，来源 https://looirobot.com/products/looi-robot ）。生成图中的界面为参考重绘，精确文字与像素以原截图和源码为准。

## 01 整体效果图

输出：01-product-overview.png

```text
Use case: product-mockup.
Create a refined industrial design presentation board for the existing Super-LOOI project, landscape 3:2 composition, high resolution. This is a realistic visualization of the EXISTING LOOI hardware carrying the CURRENT custom app, not a new invented robot.
Input image 1 is the official LOOI exterior reference: reproduce the WHITE tracked base on the right faithfully, including its low rectangular rounded wedge body, two narrow dark rubber continuous tracks, subtle side inset, front black pill inset with slim cyan light, and central short tilting magnetic phone mount. Do not reproduce the original marketing text or its app interface. Do not invent legs, arms, ears, extra screens, or a circular pedestal.
Input image 2 is the CURRENT Super-LOOI app screenshot. It is sideways because of simulator capture: rotate its CONTENT 90 degrees COUNTERCLOCKWISE to obtain the intended landscape UI (status on upper left, controls on upper right, smile below eyes). Use this current screen as the visual source. Preserve the dark navy-black dotted texture, two enormous solid cyan circular eyes with thin electric blue edge and soft halo, tiny curved smile, small upper-left '陪伴待机' status, upper-right 'LIVE 对话', '对话', and 'LAB' controls. Preserve this visual identity and hierarchy precisely; no dashboard cards or task list. Eyes are filled luminous circles without pupils.
Art direction: sophisticated industrial design portfolio sheet, warm off-white paper #F2F1EC, charcoal typography, hairline gray rules, restrained cyan accents, generous negative space, physically believable studio lighting and microtexture. NO generic sci-fi HUD, NO huge neon light effects, no busy environment.
Layout: top left small 'SUPER-LOOI', large title '具身陪伴，从桌面开始', small subtitle '手机 × LOOI 底座 × 当前 App 首页'. Top right tiny 'INDUSTRIAL DESIGN STUDY / 01'.
Main hero fills left two thirds: one large beautiful three-quarter front view of white LOOI with landscape dark metallic phone magnetically mounted, screen shows current UI. Realistic screen glass but no glare obscuring eyes, correct modest phone/base ratio (phone approx 150 mm wide, body approx 110 mm). Base rests on clean off-white studio surface, natural soft shadow. The phone has a small camera notch along left short edge, not a separate new display.
Right column: a much smaller directly FRONT view of the same assembled product, and beneath it a flat landscape close-up of the current UI with upper controls clearly visible. Fine callout lines label '01 横屏手机 / 当前首页', '02 磁吸俯仰支架', '03 双履带底座'. A short material row shows three swatches, '暖白细纹外壳', '石墨黑履带', '青蓝屏幕光'. Swatches are exterior appearance study, not claims of factory material.
Bottom strip with fine separator, three short phrases spaced evenly: '默认陪伴待机', '轻触开启 LIVE', '拿起手机即可离座'. Very small footer '外观整合效果图 · 结构与材质以实物复核为准'. Only this exact concise text, legible Chinese typographic design, do not add claims about working voice wake, camera access, charging speed, or tested motion. The current interface should look like the screenshot, not the original official LOOI face.
```

## 02 设计拆解板

输出：02-design-breakdown.png

```text
Use case: infographic-diagram and product-mockup.
Create a second coordinated industrial design DETAIL BOARD for Super-LOOI. Landscape 3:2, high resolution, disciplined professional industrial design document, warm off-white paper, charcoal fine typography, hairline grids, subtle cyan accents, generous spacing. Title 'SUPER-LOOI / 设计拆解' and subtitle '外观、结构边界与打样任务'. Small edition mark 'DESIGN DEVELOPMENT / 02'.
References: Image 1 is official existing white LOOI robot EXTERIOR, preserve its body, double rubber continuous tracks, black front pill with a thin cyan bar, central tilting magnetic smartphone holder. Image 2 is current app screen, rotated 90 degrees COUNTERCLOCKWISE for correct landscape orientation. Image 3 is approved first overview board: preserve the exact white body, screen face identity, material palette and product proportions of that board.
Layout six clearly separated modules in a balanced 3 column x 2 row grid. No large marketing hero.
Panel '01 / 组件与装配': largest visual, an EXTERNAL MODULE exploded axonometric of landscape phone raised above circular magnetic contact / short tilting mount, above the closed white main body with two dark continuous track modules shown outside at either side. Alignment dashed lines, precise external geometry. The white body remains CLOSED, no invented battery or circuit detail. Labels '手机', '磁吸接触面', '俯仰连接', '机身总成', '双履带'. Tiny caption '模块关系示意，非原厂内部拆机图'.
Panel '02 / 尺寸边界': front and side fine technical line views, consistent geometry with hero. A small phone outline in landscape on tilting mount above existing LOOI tracked base, dimension arrows ONLY where marked '待实测'. Main clear text '官方整机尺寸：110 × 98 × 110 mm' and small '轴向与手机安装包络须实物复核'. Do not label this as our fabricated manufacturing dimensions; no made-up tolerances or angle specifications. Small three-item labels '手机包络', '桌面接触区', '俯仰避让区'.
Panel '03 / 磁吸与走线': close-up rear three-quarter detail of phone sitting on existing short tilt mount. Show conceptual rear USB-C cable EXIT ROUTE with fine cyan dashed line routed rearward, no plug piercing shell or unexplained new connector. Label '磁吸承载待测', '转轴避让', '线缆向后引出'. Tiny caption '安装与避让研究；接口位置以实物为准'. No modifications covering existing sensors or charging contact.
Panel '04 / CMF': three large material samples and little realistic surface details: warm white finely textured outer shell, graphite black rubber track ridges, glossy dark screen with blue circular eye. Exact labels '暖白 / 细纹外壳', '石墨黑 / 防滑履带', '青蓝 / 屏幕表情'. Tiny '外壳材质及工艺为提案，需供应商确认'. Avoid neon physical new light ring.
Panel '05 / 当前首页': flat LARGE landscape current Super-LOOI screen, navy-black background, two solid large cyan circles with electric blue edge, small curved smile, top left '陪伴待机', top right 'LIVE 对话', '对话', 'LAB'. Below small annotations '状态在上 · 表情居中 · 入口收敛' and '当前需轻触开启 LIVE；唤醒词待实现'. No extra dashboard. Make this UI crisp and immediately recognizable.
Panel '06 / 原型验证': three small simple line illustrations in a row: phone detached upwards, base stationary on tabletop, side phone/mount clearance. Text only '拿起脱座', '静态稳定', '俯仰避让'. Underneath '先测安装与稳定，再开放身体动作'. Last small status '结构实测 → 装配样 → 功能样'.
Footer full width '设计开发提案 · 可用于结构沟通与打样任务拆分 · 非制造工程图'. All Chinese should be clear, concise, professional. The exterior and app must match references. Physically believable shapes, no floating duplicate tracks or fake tech, no claim about tested stopping latency, battery chemistry, phone weight, wireless charging power, or unverified internal construction. This is a helpful, beautiful actual development sheet, not arbitrary fantasy rendering.
```

提示词中的 approved first overview 指主 agent 已检查并选用的前一张结果，不代表用户已经批准设计。参考描述中的约 150 mm 手机宽度仅为构图尺度假设，不是目标手机实测尺寸。
