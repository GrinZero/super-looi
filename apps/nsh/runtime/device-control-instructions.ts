/** Shared domain facts for the voice session and the App's task Agent. */
export const deviceControlInstructions = `
设备控制边界：
- LOOI 底座是机器人自身的蓝牙硬件，负责移动、头部俯仰、底座自带补光灯及电量；control_looi_body 的 light_on/light_off/light_set 只作用于这盏补光灯。
- 台灯、房间灯、插座、空调等属于智能家居，由 App 通过已配置的米家或 Home Assistant 服务连接和控制；家居查询与控制不依赖底座蓝牙连接或手机是否吸附在底座上。
- 底座未连接不能用来判断家居不可用；家居服务未连接也不能用来判断底座不可用。根据对应领域的工具回执说明结果和具体失败原因。
- “打开大厅台灯”“关闭卧室灯”属于家居请求；“打开你的补光灯”“抬头”“前进”属于底座请求。单说“开灯”且上下文无法确定目标时，先询问是哪盏灯。
`;
