# 米家摄像头在 NSH 手机宿主中的原生媒体边界

研究日期：2026-11-10。NSH 固定提交为 `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`；本机 Apple SDK 为 iPhoneOS 26.2。依据三台摄像头已完成的 [CS2/TCP 实测](xiaomi-camera-community-verification.md)，讨论 App 内从 H.265 编码帧到显示画面的接入方式。

## 推荐结论

首版同时支持预览与 Agent 按需取帧，采用 **Rust 协议会话 → 一个原生解码会话 → 预览与 JPEG 两个消费者**。TSX 传会话标识与显示属性，Agent 只在需要时取得单张 JPEG；持续视频帧不经过 QuickJS 和 JSON props。App 在前台、详情未打开时，取帧请求仍可独立持有解码会话。

- **iOS**：显式 `VTDecompressionSession` 解码一次，输出 `CVPixelBuffer`；预览交未压缩样本给 `AVSampleBufferDisplayLayer`，JPEG 由相同像素帧经 VideoToolbox 的 CGImage 转换和 ImageIO 编码。此时显式解码的具体用途，就是为预览和 Agent 共享可访问的像素帧。
- **Android**：推荐 `MediaCodec → 独立 SurfaceTexture → EGL`，解码纹理由会话拥有，详情组件只挂载可选预览输出。Agent 请求时在离屏目标读取像素并编码 JPEG，无需打开详情或截取窗口。它增加一套小型 EGL 渲染适配，但避免持续的 YUV CPU 拷贝，也不要求某个设备支持特定 ImageReader 输出格式。

这两条推荐是基于系统 API 与 AOSP 测试代码的设计推导；手机端解码／预览／JPEG 尚未实现。后面的两端比较说明新增成本和落地验证点。

## 现有 Video 能做什么

| 平台 | 固定 NSH 源码 | 实际入口 | 对接编码帧的差距 |
| --- | --- | --- | --- |
| iOS | `nsh-platform-ios/src/video.rs` 的 `VideoHost::url/open` | 字符串转 `NSURL`，`AVPlayer.playerWithURL`，显示于 `AVPlayerLayer` 或 `AVPlayerViewController` | 没有 `CMSampleBuffer`、任意内存数据源、资源加载代理或帧输入方法 |
| Android | `VideoBox.java` 与 `NshView.setMediaSource` | `MediaPlayer` + `TextureView`；URI 调用 `setDataSource(Context, Uri)`，再 `prepareAsync` | 没有 `MediaCodec` 编码帧输入，也未暴露 `MediaDataSource` 重载；不是 Media3/ExoPlayer |

源码：[iOS Video](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-ios/src/video.rs)、[Android VideoBox](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-android/java/com/longbridge/nsh/VideoBox.java)、[Android NshView](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-android/java/com/longbridge/nsh/NshView.java)。

因此，`Video.src` 中填入会话 ID、Annex B 字节或自行发明的 URL scheme，并不会让现有宿主接收帧。Apple 的 `AVAssetResourceLoader` 可以由代理处理资产请求，Android 的 `MediaDataSource` 可以按位置读取数据，但这两种原生入口都不在当前 NSH Video API 中。[Apple ResourceLoader 代理](https://developer.apple.com/documentation/avfoundation/avassetresourceloader/delegate)、[Android MediaDataSource](https://developer.android.com/reference/android/media/MediaDataSource)

## 原生显示路线

### iOS：一次 VideoToolbox 解码，分发像素帧

拟采用的处理过程：

1. 原生侧按访问单元整理解密后的 Annex B NAL，提取 H.265 VPS/SPS/PPS 或 H.264 SPS/PPS，组装长度前缀 NAL 的压缩 `CMSampleBuffer`。
2. 在媒体工作队列中调用 `VTDecompressionSessionDecodeFrame`。输出回调取得像素缓冲与 PTS；保留当前消费者需要的引用，不改写 decoder 可能仍引用的像素内容。
3. 有预览消费者时，由同一 `CVPixelBuffer` 生成匹配的未压缩格式描述和 `CMSampleBufferCreateReadyWithImageBuffer`，交给显示层。显示层处理像素显示，不再重复解码该 H.265 码流。
4. Agent 请求时，从同一解码会话取得所需像素帧，调用 `VTCreateCGImageFromCVPixelBuffer`，再以 ImageIO 的 `CGImageDestinationCreateWithData`、`CGImageDestinationAddImage`、`CGImageDestinationFinalize` 生成内存 JPEG。ImageIO 的 `kCGImageDestinationImageMaxPixelSize` 可处理请求尺寸上限，`kCGImageDestinationLossyCompressionQuality` 设置质量，首版不需要另加 CoreImage。

依据：[VideoToolbox 输出回调](https://developer.apple.com/documentation/videotoolbox/vtdecompressionoutputcallback)、[从图像缓冲构造样本](https://developer.apple.com/documentation/coremedia/cmsamplebuffercreatereadywithimagebuffer(allocator:imagebuffer:formatdescription:sampletiming:samplebufferout:))、[像素转 CGImage](https://developer.apple.com/documentation/videotoolbox/vtcreatecgimagefromcvpixelbuffer(_:options:imageout:))、[ImageIO 目的地](https://developer.apple.com/documentation/imageio/cgimagedestination)、[ImageIO 尺寸上限](https://developer.apple.com/documentation/imageio/kcgimagedestinationimagemaxpixelsize)。

`VTCreateCGImageFromCVPixelBuffer` 不支持任意像素格式。为了先得到确定的预览／JPEG 共用路径，首版原生验证可请求 32-bit BGRA 与 CGImage 兼容属性，再确认设备的实际输出与转换结果。此选择的成本是全速 YUV→BGRA 转换和更大像素带宽：864×480 的紧密 BGRA 帧约 1.58 MiB，而 8-bit YUV420 约 0.59 MiB。二者是格式尺寸计算，不是手机内存或耗电实测。原生帧仍按引用传给两个消费者，无须把每帧复制为 JS 图片。[CoreVideo 兼容属性](https://developer.apple.com/documentation/corevideo/kcvpixelbuffercgimagecompatibilitykey)、[输出格式属性](https://developer.apple.com/documentation/corevideo/kcvpixelbufferpixelformattypekey)

解码会话由原生视频 session 持有，详情页关闭只解除显示层；仍有 Agent 取帧请求时继续解码。没有消费者时停止输入，在工作队列等待在途异步解码结束，释放保留帧并使 session 失效；该等待不占 UI 线程。JPEG 任务对其像素帧保有自己的引用，编码完成后释放。参数集或重连导致 session 重建时，以新会话重新建立时间基。[异步帧收尾](https://developer.apple.com/documentation/videotoolbox/vtdecompressionsessionwaitforasynchronousframes(_:))、[解码 session 生命周期](https://developer.apple.com/documentation/videotoolbox/vtdecompressionsession-api-collection)

显示层与视图创建、布局在主线程；解码和 JPEG 在工作队列。VideoToolbox 即使启用异步解码，输入调用也可能受到 decoder 队列背压而阻塞，因此不能放到 UI 线程。[Apple 直接解码说明](https://developer.apple.com/videos/play/wwdc2014/513/)

当前 NSH 生成与打包宿主的最低 iOS 为 15.0（固定 CLI 的 `run.rs` / `package.rs`），共享显示路径应保留该基线的显示层接口。本机 SDK 26.2 有 iOS 17+ 的 `AVSampleBufferVideoRenderer`；其显示层 `isReadyForDisplay` 头文件标注 iOS 17.4+。在线文档最新的 `Receiver` 类型元数据标注 iOS 27，不能照搬到本机 SDK。使用原生解码并不自动证明实际硬解，VideoToolbox 提供所选解码器的硬解属性查询。[renderer](https://developer.apple.com/documentation/avfoundation/avsamplebuffervideorenderer)、[首帧状态](https://developer.apple.com/documentation/avfoundation/avsamplebufferdisplaylayer/isreadyfordisplay)、[硬解查询](https://developer.apple.com/documentation/videotoolbox/kvtdecompressionpropertykey_usinghardwareacceleratedvideodecoder)

### Android：三种一次解码方案

| 路线 | 无详情页面的 Agent 取帧 | 与预览共享像素的方式 | 具体实现成本 |
| --- | --- | --- | --- |
| `MediaCodec.configure(..., null, ...)` + `getOutputImage` | 支持；decoder 不依赖窗口 Surface | 将 YUV 平面复制到会话自己的最新帧，预览用 YUV shader 上传，JPEG 按需转换为 NV21 | 明确的 CPU 像素契约；需处理 plane row/pixel stride、crop、YUV→RGB 预览及持续 CPU 拷贝 |
| `MediaCodec → ImageReader(YUV_420_888).Surface` | 支持；ImageReader 不属于详情 view | acquire 解码图像后供 YUV 预览与 JPEG | 与前者共享大部分 YUV 处理，另有 BufferQueue、ImageReader/codec 格式协商和 image 持有预算 |
| `MediaCodec → 独立 SurfaceTexture → EGL` | 支持；离屏 pbuffer 与 decoder texture 由 session 拥有 | 同一外部纹理绘制预览窗口；有请求才绘制离屏图并 readback | 增加 EGL/context/OES shader/输出 Surface 生命周期；JPEG 请求发生 GPU→CPU 同步读回，预览期间不必逐帧搬运 YUV 到 CPU |

**无 Surface 的证据与约束。** MediaCodec 文档说明 API 22 起视频 codec 支持灵活 YUV420，ByteBuffer 模式可用 `getOutputImage` 访问各平面；配置了输出 Surface 时该方法返回 null。现代 AOSP CTS 的 `ImageReaderDecoderTest` 明确包含 HEVC 参数组，并分别测试 `configure(..., null, ...) + getOutputImage` 和 ImageReader Surface 两种模式，且先核对被测 codec 的格式、尺寸与颜色格式支持。原始 `Image` 只在输出缓冲仍由调用方持有时有效，需要复制留用的数据后 `close`／释放 codec 输出；不能把未释放的 codec 输出缓冲当作长期帧缓存。[MediaCodec 像素契约](https://developer.android.com/reference/android/media/MediaCodec)、[固定 CTS 源码](https://android.googlesource.com/platform/cts/+/1daba777fa1cc472226da4104041849ccbc65b80/tests/tests/media/decoder/src/android/media/decoder/cts/ImageReaderDecoderTest.java)

**ImageReader 的实际可用性。** 同一份 CTS 给出了 HEVC→YUV ImageReader 的原生先例，但不是所有宽高、颜色格式、usage 组合的无条件保证。`PRIVATE` 格式的 Image 没有可读平面，不能据此给 Agent 生成 JPEG。若使用 YUV ImageReader，每个 acquired Image 都必须归还，超出 maxImages 会让输出停滞；仅保留 Surface 也不能替代持有 ImageReader 本体。对于本项目，既然还需要 YUV 预览上传与 JPEG 平面处理，这一路额外的 ImageReader 所带来的收益不足以作为默认方案。[ImageReader 格式及资源契约](https://developer.android.com/reference/android/media/ImageReader)

CPU YUV 路线生成 JPEG 时，不能直接把 `YUV_420_888` 三个平面的 Buffer 拼接后传给 `YuvImage`。`YuvImage.compressToJpeg` 接受 NV21 或 YUY2，必须先按 stride 与 crop 重排为目标布局。这个平面适配是明确的工程成本，不需要为它再引入整套媒体服务器。[Android YuvImage](https://developer.android.com/reference/android/graphics/YuvImage)

### Android 推荐：独立解码纹理与可选窗口输出

以“持续预览 + Agent 稀疏请求 JPEG”的调用方式，推荐 EGL 路线：

1. session 创建媒体线程、EGL context、离屏 pbuffer、`GL_TEXTURE_EXTERNAL_OES` 纹理和独立 `SurfaceTexture`；它们不属于详情页。由该 SurfaceTexture 创建的 Surface 固定作为 MediaCodec 输出。
2. 帧到达后，在拥有 EGL context 的线程调用 `updateTexImage` 并取得纹理矩阵／时间戳；即使没有预览，也继续消费所需解码输出。
3. 详情可见时，将它的 TextureView Surface 包装为可选 EGL window surface，并把同一 decoder texture 绘制过去；页面退出只释放这个 window surface，不销毁仍被取帧请求使用的 decoder texture。
4. Agent 请求时，将同一纹理绘制到指定大小的离屏目标，`glReadPixels` 取 RGBA，再交 `Bitmap.compress(JPEG)`。这读取的是 session 的解码纹理，不是 `TextureView.getBitmap` 或窗口截图，未打开详情也能工作。

AOSP CTS 的 `OutputSurface` 实现了 decoder SurfaceTexture、EGL pbuffer 与纹理绘制；`TextureRender` 有离屏像素读取，CTS Verifier 的 `PreviewRecorder` 给出 RGBA readback 到 Bitmap/JPEG 的实现。预览与离屏共用 context、可选 window surface 的组合是本项目据此推导的适配设计。[CTS OutputSurface](https://android.googlesource.com/platform/cts/+/c5e87101dcd5509acc068463b4a858440a20c980/tests/media/src/android/mediav2/cts/OutputSurface.java)、[CTS TextureRender](https://android.googlesource.com/platform/cts/+/4552e4eefac/tests/media/src/android/mediav2/cts/TextureRender.java)、[CTS Verifier JPEG readback](https://android.googlesource.com/platform/cts/+/f898b14e2bd5d54ac5c2169a60f528a83580da67/apps/CtsVerifier/src/com/android/cts/verifier/camera/its/PreviewRecorder.java)

SurfaceTexture 官方接口明确不要求 TextureView，并要求 `updateTexImage` 运行在持有对应 GL context 的线程。纹理矩阵可能随帧改变，JPEG 和预览应使用同一个源矩阵，另明确处理离屏坐标／纵向方向及 RGBA→Bitmap 布局。JPEG 工作不在 UI 线程，readback 仅由实际取帧需求触发。[SurfaceTexture 契约](https://developer.android.com/reference/android/graphics/SurfaceTexture)

session 结束时先停止 codec 向 decoder Surface 继续产出，再在媒体线程结束帧回调、释放 Surface/SurfaceTexture、纹理、pbuffer、window surface 和 EGL context；窗口卸载与整个 session 关闭是两个不同操作。该路线使用 Android 系统 MediaCodec/EGL/GLES/Bitmap，不增加 FFmpeg、libyuv 或媒体播放器依赖。相比无 Surface 模式，付出的新增复杂度集中于一个媒体渲染线程和离屏／窗口目标切换，换来同一解码纹理同时服务预览与独立 Agent 取帧。

## 自有原生组件的可用注册入口

固定 NSH 的原生组件 props、命令参数和事件按 JSON 传输，源码指南明确将大二进制数据放在组件外。建议显示组件绑定已有视频 session：例如传 `sessionId`、`resizeMode`、`active`，事件只传真实显示就绪、尺寸与错误。以下名称是拟议 App API，不是现有 NSH 导出：

```tsx
<CameraVideo sessionId={session.id} resizeMode="contain" active={isActive()}
  onReady={handleFirstDisplay} onError={handlePlaybackError} />
```

这里新增一个视频组件的具体用途，是容纳现有 Video 未暴露的编码帧输出；成本是两个系统视图适配器和一个注册入口。Rust 视频会话持有协议传输与原生媒体句柄；原生媒体会话持有解码器和取帧所需的像素／纹理，组件只持有预览显示资源。预览消费者与按需取帧请求共同决定会话是否继续工作，详情组件销毁不等于立即销毁 decoder。TSX 不复制帧状态，只映射状态事件；Agent 只接收请求对应的 JPEG 与采样元数据。[固定 NSH 原生组件契约](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/website/docs/native-components.md)

### iOS

App 自有 Rust crate 可以使用 `#[native_components(ios)]` 向 `nsh_platform_ios::Components` 注册工厂，实现 `NativeComponent::view/set_prop/command`，并以 Rust `Drop` 释放显示侧资源。需要给 App 的 iOS 目标增加与当前 NSH 相同提交的 `nsh-platform-ios` 依赖，以及所选系统媒体绑定；不需要修改 NSH 上游或生成宿主文件。[固定宏](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-macros/src/native_components.rs)、[iOS NativeComponent](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-ios/src/component.rs)

### Android

固定宏没有 Android 分支。Android 使用 Java `NshView.registerComponent`；该方法是实例方法，`mounter.components` 是每个实例自己的 `HashMap`，不存在可在 ContentProvider 中直接注册一次的全局表。[NshView 实例注册](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-android/java/com/longbridge/nsh/NshView.java)、[Mounter 工厂查找](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-android/java/com/longbridge/nsh/Mounter.java)

现有 `SuperLooiApplication` 已注册 Activity 生命周期回调，可以扩展这个插件入口。固定 `DevActivity` 和 `AppActivity` 都先调用 `super.onCreate`，随后才创建 NshView、`setContentView` 和加载 bundle；Android 的 `onActivityCreated` 在 `super.onCreate` 时发生。可在这个回调中向主线程 `Handler.post` 一个注册任务：任务执行时 NshView 已装入内容视图，且它早于后续加载产生的 mount 批次进入主队列。依据是所有 NSH 渲染批次最终都经过 `NshView.submit` 的 `main.post(mounter.apply)`。这是针对固定宿主启动顺序的源码推导，需在真机的开发宿主与打包宿主分别确认首次组件创建，不必先新增 Activity。

源码：[DevActivity](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-android/java/com/longbridge/nsh/DevActivity.java)、[AppActivity](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-android/java/com/longbridge/nsh/AppActivity.java)、[Rust Sink→UI submit](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-platform-android/src/host.rs)、[Android 生命周期时点](https://developer.android.com/reference/android/app/Application.ActivityLifecycleCallbacks)。

当前插件编译脚本 `apps/nsh/scripts/native-plugins.mjs` 的 Java classpath 只有 `android.jar`，直接引用 NshComponent 接口还需构建接线。两种可选处理方式：

- 沿现 App 的反射接入方式，用小型注册适配器调用运行时已有的公开 `registerComponent`，通过动态代理实现工厂和组件接口；媒体视图本体仅依赖 Android API。成本是注册适配器缺少编译期 NSH 类型检查，但反射不进入逐帧通道。
- 提供与固定 NSH Java API 匹配的 compile-only jar，插件只编译 App 自有类。成本是新增构建输入与其版本维护，收益是静态接口检查。

优先评估前者，以利用既有 APK 插件链路；原生实现仍放在 `apps/nsh/native/android`，不直接改生成的 Activity 或 APK 中的 NSH 类。

## fMP4 加现有 Video 路线的取舍

| 方案 | 可复用部分 | 新增成本与未解决的具体接口 |
| --- | --- | --- |
| 原生单解码双消费者 | 公共协议解析、系统解码器、NSH 原生组件布局 | NAL/参数集与时间戳适配；两端像素／纹理分发、JPEG 请求与预览显示；session 和显示资源分别关闭 |
| fMP4 + App 内 HTTP + 现有 Video | 现有 URL 播放 UI、AVPlayer/MediaPlayer 的播放控制 | 自己维护初始化段、片段、时间线和 HTTP 读取语义；连续无界 progressive fMP4 是否按预期低延迟启动，不能由“支持 MP4”推出；App 现有网络/明文传输配置也需对应新 HTTP 入口 |
| fMP4 HLS + 现有 Video | iOS AVPlayer 的 HLS 播放链 | 另增播放列表、片段窗口和更新节奏；Apple 的 HEVC HLS 要求 fMP4，而 Android 平台文档对内置 HLS 列出的基线仍为 MPEG-2 TS，不能据此承诺当前 MediaPlayer 能播放 HEVC fMP4 HLS |
| fMP4 + 两端自有内存数据源 | 可减少 loopback HTTP | 仍要新建 AVURLAsset/resourceLoader 或 Android MediaDataSource 适配器，现有 NSH Video 没有接入口；已经付出原生组件成本，却继续保留 muxer 与播放器缓存层 |

AVPlayer 通过 URL 或 player item 加载媒体；Android `MediaPlayer` 的 URL 与数据源入口也各有原生契约。存在本机 HTTP URL，并不意味着该播放器已具备无限增长 fMP4 的直播语义。[Apple AVPlayer](https://developer.apple.com/documentation/avfoundation/avplayer/)、[Android MediaPlayer](https://developer.android.com/reference/android/media/MediaPlayer)

Apple 的 HLS 规范要求 HEVC 使用 fMP4，并要求相应的初始化段与时间线；Android 官方内置网络协议表不能支撑 HEVC fMP4 HLS 的跨机型承诺。[Apple HLS 规范](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/)、[Android 内置媒体协议](https://developer.android.com/media/platform/supported-formats#network-protocols)

上述重封装可以保留原编码而不转码，成本主要在容器／播放服务和缓存语义。对于当前三台已产出原始 H.265 的摄像头，新增这些层没有抵偿其复杂度的已验证收益，推荐原生单解码双消费者。

## 需要落地验证的媒体问题

两端第一个原生验证都应覆盖“App 在前台、从未打开摄像头详情，Agent 单独请求一张 JPEG”，并确认该 JPEG 来自实际解码帧。之后同时打开预览与发出 JPEG 请求，验证两者共享同一 decoder、画面方向和颜色一致；退出预览后，在取帧请求仍进行时不得拆掉它依赖的资源。最后确认无消费者时释放 session、App 进入后台结束工作，以及恢复后的新会话能重新取得真实帧。

设备应记录实际首帧显示、JPEG 完成时间、输出格式和解码器。Mac 的首个编码包耗时和完整解码结果是协议依据，不能代替手机上的这些结果。hlc7 初始参数集／尺寸变化也应沿真实媒体路径观察。

本轮协议关闭了音频，媒体接口以视频为已验证输入；音频解码、双向通话及与现有实时语音的会话协调，需要另有实际输入和调用方后再设计。
