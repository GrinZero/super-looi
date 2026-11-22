package com.superlooi.nsh;

import android.Manifest;
import android.app.Activity;
import android.app.Fragment;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.Face;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Range;
import android.util.Size;
import android.util.SizeF;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import java.io.ByteArrayOutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.Proxy;
import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** App-owned Camera2 capture bridge for front/back phone camera plugins and preview surfaces. */
public final class DeviceCameraBridge {
    public static final class Snapshot {
        public final byte[] data;
        public final int width;
        public final int height;
        public final long capturedAt;
        public final long capturedMonotonicMs;
        public final long facesMonotonicMs;
        public final float hfovDeg;
        public final long seq;
        public final float[] faces;

        Snapshot(
                byte[] data,
                int width,
                int height,
                long capturedAt,
                long capturedMonotonicMs,
                long facesMonotonicMs,
                float hfovDeg,
                long seq,
                float[] faces) {
            this.data = data;
            this.width = width;
            this.height = height;
            this.capturedAt = capturedAt;
            this.capturedMonotonicMs = capturedMonotonicMs;
            this.facesMonotonicMs = facesMonotonicMs;
            this.hfovDeg = hfovDeg;
            this.seq = seq;
            this.faces = faces != null ? faces : new float[0];
        }
    }

    public static final class FacesSnapshot {
        public final int width;
        public final int height;
        public final long capturedAt;
        public final long capturedMonotonicMs;
        public final long facesMonotonicMs;
        public final float hfovDeg;
        public final long seq;
        public final float[] faces;

        FacesSnapshot(
                int width,
                int height,
                long capturedAt,
                long capturedMonotonicMs,
                long facesMonotonicMs,
                float hfovDeg,
                long seq,
                float[] faces) {
            this.width = width;
            this.height = height;
            this.capturedAt = capturedAt;
            this.capturedMonotonicMs = capturedMonotonicMs;
            this.facesMonotonicMs = facesMonotonicMs;
            this.hfovDeg = hfovDeg;
            this.seq = seq;
            this.faces = faces != null ? faces : new float[0];
        }
    }

    public static final class CropResult {
        public final byte[] data;
        public final int width;
        public final int height;
        public final long capturedMonotonicMs;

        CropResult(byte[] data, int width, int height, long capturedMonotonicMs) {
            this.data = data;
            this.width = width;
            this.height = height;
            this.capturedMonotonicMs = capturedMonotonicMs;
        }
    }

    static native void registerVm();
    private static native void foregroundChanged(boolean active);

    private static final ConcurrentHashMap<String, WeakReference<DeviceCameraBridge>> sessions =
            new ConcurrentHashMap<>();
    private static volatile boolean permissionPending;
    private static volatile boolean permissionCancelled;

    private final String id;
    private final int facing; // 0 = front, 1 = back
    private final HandlerThread thread;
    private final Handler handler;
    private final Object lock = new Object();

    private CameraDevice cameraDevice;
    private CameraCaptureSession captureSession;
    private CaptureRequest.Builder previewRequestBuilder;
    private ImageReader imageReader;
    private Range<Integer>[] availableFpsRanges;
    private int sensorOrientation;
    private Rect sensorActiveRect;
    private int faceDetectMode = CaptureRequest.STATISTICS_FACE_DETECT_MODE_OFF;
    private volatile int maxDimension;
    private volatile int maxFps;
    private volatile boolean closed;

    private byte[] latestNv21;
    private float[] latestFaces = new float[0];
    private long facesUpdatedAtMs;
    private long facesMonotonicMs;
    private int rawWidth;
    private int rawHeight;
    private long frames;
    private long capturedAtMs;
    private long capturedMonotonicMs;
    private float hfovDeg;
    private long lastAcceptedAtMs;
    private int errorCode;
    private String failureMessage;

    private Preview boundPreview;
    private boolean previewDisplayed;

    static void foreground(boolean active) {
        foregroundChanged(active);
        if (!active) {
            for (WeakReference<DeviceCameraBridge> ref : sessions.values()) {
                DeviceCameraBridge bridge = ref.get();
                if (bridge != null) bridge.close();
            }
        }
    }

    public static boolean isPermissionRequestPending() {
        return permissionPending;
    }

    public static String permission() {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) return "unavailable";
        CameraManager mgr = (CameraManager) app.getSystemService(Context.CAMERA_SERVICE);
        try {
            if (mgr == null || mgr.getCameraIdList().length == 0) return "unavailable";
        } catch (CameraAccessException | RuntimeException error) {
            return "unavailable";
        }
        if (Build.VERSION.SDK_INT < 23) return "granted";
        if (app.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            return "granted";
        }
        if (permissionPending) return "undetermined";
        if (permissionCancelled) return "denied";
        return app.getSharedPreferences("camera-permission", Context.MODE_PRIVATE)
                .getBoolean("asked", false) ? "denied" : "undetermined";
    }

    public static String requestPermission() {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) return "unavailable";
        String state = permission();
        if ("granted".equals(state) || "unavailable".equals(state)) return state;
        final Activity owner = SuperLooiApplication.foregroundActivity();
        if (owner == null || Build.VERSION.SDK_INT < 23) return "unavailable";
        if (!permissionPending) {
            permissionCancelled = false;
            permissionPending = true;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (SuperLooiApplication.foregroundActivity() != owner || owner.isFinishing()) {
                    permissionPending = false;
                    return;
                }
                try {
                    owner.getFragmentManager()
                            .beginTransaction()
                            .add(new CameraPermissionFragment(), "looi-camera-permission")
                            .commit();
                } catch (RuntimeException error) {
                    permissionPending = false;
                }
            });
        }
        return "undetermined";
    }

    public static final class CameraPermissionFragment extends Fragment {
        private boolean requested;

        @Override public void onResume() {
            super.onResume();
            if (!requested && Build.VERSION.SDK_INT >= 23) {
                requested = true;
                requestPermissions(new String[]{Manifest.permission.CAMERA}, 7402);
            }
        }

        @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
            if (code == 7402) {
                SuperLooiApplication app = SuperLooiApplication.appContext();
                permissionCancelled = results.length == 0;
                if (!permissionCancelled && app != null) {
                    app.getSharedPreferences("camera-permission", Context.MODE_PRIVATE)
                            .edit()
                            .putBoolean("asked", true)
                            .apply();
                }
                permissionPending = false;
                getFragmentManager().beginTransaction().remove(this).commitAllowingStateLoss();
            }
        }
    }

    public static DeviceCameraBridge create(String id, int facing, int maxDimension, int maxFps) {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) {
            throw new IllegalStateException("ERR_DEVICE_CAMERA_UNAVAILABLE: Application context unavailable");
        }
        if (Build.VERSION.SDK_INT >= 23
                && app.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            throw new IllegalStateException("ERR_CAMERA_PERMISSION_DENIED: Manifest.permission.CAMERA not granted");
        }
        DeviceCameraBridge bridge = new DeviceCameraBridge(id, facing, maxDimension, maxFps);
        bridge.open(app);
        sessions.put(id, new WeakReference<>(bridge));
        return bridge;
    }

    private DeviceCameraBridge(String id, int facing, int maxDimension, int maxFps) {
        this.id = id;
        this.facing = facing;
        this.maxDimension = Math.max(160, Math.min(1920, maxDimension));
        this.maxFps = Math.max(1, Math.min(30, maxFps));
        this.thread = new HandlerThread("looi-device-camera-" + id);
        this.thread.start();
        this.handler = new Handler(this.thread.getLooper());
    }

    private void open(Context context) {
        CameraManager mgr = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        if (mgr == null) {
            closeWithError(-1, "ERR_DEVICE_CAMERA_UNAVAILABLE: CameraManager unavailable");
            throw new IllegalStateException(failureMessage);
        }
        final String selectedCameraId;
        final Size selectedSize;
        final Range<Integer> selectedFpsRange;
        try {
            int desiredFacing = facing == 1
                    ? CameraCharacteristics.LENS_FACING_BACK
                    : CameraCharacteristics.LENS_FACING_FRONT;
            String foundId = null;
            CameraCharacteristics foundChars = null;
            for (String candidate : mgr.getCameraIdList()) {
                CameraCharacteristics chars = mgr.getCameraCharacteristics(candidate);
                Integer lens = chars.get(CameraCharacteristics.LENS_FACING);
                if (lens != null && lens == desiredFacing) {
                    foundId = candidate;
                    foundChars = chars;
                    break;
                }
            }
            if (foundId == null || foundChars == null) {
                throw new IllegalStateException(
                        "ERR_DEVICE_CAMERA_NO_DEVICE: Camera lens (" + (facing == 1 ? "back" : "front") + ") unavailable");
            }
            selectedCameraId = foundId;
            Integer sensor = foundChars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            this.sensorOrientation = sensor != null ? sensor : 0;
            this.sensorActiveRect = foundChars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            this.hfovDeg = computeLandscapeHfovDeg(foundChars);
            int[] faceModes = foundChars.get(CameraCharacteristics.STATISTICS_INFO_AVAILABLE_FACE_DETECT_MODES);
            this.faceDetectMode = chooseFaceDetectMode(faceModes);
            StreamConfigurationMap map = foundChars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size[] sizes = map != null ? map.getOutputSizes(ImageFormat.YUV_420_888) : null;
            // Open ImageReader at a <=1280 landscape-capable sensor size so dynamic reconfigure()
            // between 320/640/1280 never requires tearing down CameraCaptureSession.
            selectedSize = chooseOptimalSize(sizes, 1280);
            this.availableFpsRanges = foundChars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            selectedFpsRange = chooseFpsRange(this.availableFpsRanges, this.maxFps);
        } catch (CameraAccessException error) {
            closeWithError(error.getReason(), "ERR_DEVICE_CAMERA_ACCESS: reason=" + error.getReason() + " " + error.getMessage());
            throw new IllegalStateException(failureMessage, error);
        } catch (RuntimeException error) {
            closeWithError(-2, error.getMessage() != null ? error.getMessage() : "ERR_DEVICE_CAMERA_OPEN_FAILED");
            throw error;
        }

        final CountDownLatch openLatch = new CountDownLatch(1);
        final String[] openFailure = new String[1];

        handler.post(() -> {
            if (closed) {
                openFailure[0] = "ERR_DEVICE_CAMERA_CLOSED";
                openLatch.countDown();
                return;
            }
            try {
                imageReader = ImageReader.newInstance(
                        selectedSize.getWidth(), selectedSize.getHeight(), ImageFormat.YUV_420_888, 2);
                imageReader.setOnImageAvailableListener(this::onImageAvailable, handler);
                mgr.openCamera(selectedCameraId, new CameraDevice.StateCallback() {
                    @Override public void onOpened(CameraDevice camera) {
                        if (closed) {
                            camera.close();
                            openFailure[0] = "ERR_DEVICE_CAMERA_CLOSED";
                            openLatch.countDown();
                            return;
                        }
                        cameraDevice = camera;
                        try {
                            final CaptureRequest.Builder req =
                                    camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                            req.addTarget(imageReader.getSurface());
                            req.set(CaptureRequest.CONTROL_AF_MODE,
                                    CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                             if (selectedFpsRange != null) {
                                req.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, selectedFpsRange);
                            }
                            if (faceDetectMode != CaptureRequest.STATISTICS_FACE_DETECT_MODE_OFF) {
                                req.set(CaptureRequest.STATISTICS_FACE_DETECT_MODE, faceDetectMode);
                            }
                            previewRequestBuilder = req;
                            camera.createCaptureSession(
                                    Collections.singletonList(imageReader.getSurface()),
                                    new CameraCaptureSession.StateCallback() {
                                        @Override public void onConfigured(CameraCaptureSession session) {
                                            if (closed) {
                                                session.close();
                                                openFailure[0] = "ERR_DEVICE_CAMERA_CLOSED";
                                                openLatch.countDown();
                                                return;
                                            }
                                            captureSession = session;
                                            try {
                                                Range<Integer> currentRange =
                                                        chooseFpsRange(availableFpsRanges, maxFps);
                                                if (currentRange != null) {
                                                    req.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, currentRange);
                                                }
                                                session.setRepeatingRequest(req.build(), captureCallback, handler);
                                                openLatch.countDown();
                                            } catch (CameraAccessException | RuntimeException err) {
                                                openFailure[0] = "ERR_DEVICE_CAMERA_CAPTURE_REQUEST: " + err.getMessage();
                                                closeWithError(-3, openFailure[0]);
                                                openLatch.countDown();
                                            }
                                        }

                                        @Override public void onConfigureFailed(CameraCaptureSession session) {
                                            openFailure[0] = "ERR_DEVICE_CAMERA_CONFIGURE_FAILED: Capture session rejected";
                                            closeWithError(-4, openFailure[0]);
                                            openLatch.countDown();
                                        }
                                    },
                                    handler);
                        } catch (CameraAccessException | RuntimeException err) {
                            openFailure[0] = "ERR_DEVICE_CAMERA_SESSION_CREATE: " + err.getMessage();
                            closeWithError(-5, openFailure[0]);
                            openLatch.countDown();
                        }
                    }

                    @Override public void onDisconnected(CameraDevice camera) {
                        camera.close();
                        openFailure[0] = "ERR_DEVICE_CAMERA_DISCONNECTED: Camera disconnected by OS";
                        closeWithError(-6, openFailure[0]);
                        openLatch.countDown();
                    }

                    @Override public void onError(CameraDevice camera, int error) {
                        camera.close();
                        openFailure[0] = "ERR_DEVICE_CAMERA_HARDWARE: code=" + error;
                        closeWithError(error, openFailure[0]);
                        openLatch.countDown();
                    }
                }, handler);
            } catch (CameraAccessException | RuntimeException err) {
                openFailure[0] = "ERR_DEVICE_CAMERA_OPEN_FAILED: " + err.getMessage();
                closeWithError(-7, openFailure[0]);
                openLatch.countDown();
            }
        });

        try {
            if (!openLatch.await(5, TimeUnit.SECONDS)) {
                close();
                throw new IllegalStateException("ERR_DEVICE_CAMERA_OPEN_TIMEOUT: Camera2 session timed out");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            close();
            throw new IllegalStateException("ERR_DEVICE_CAMERA_OPEN_INTERRUPTED");
        }
        if (openFailure[0] != null) {
            close();
            throw new IllegalStateException(openFailure[0]);
        }
    }

    private static Size chooseOptimalSize(Size[] sizes, int maxDim) {
        int cap = maxDim > 640 ? 1280 : 640;
        if (sizes == null || sizes.length == 0) {
            return maxDim > 640 ? new Size(1280, 720) : new Size(640, 480);
        }
        Size bestFit = null;
        int bestArea = 0;
        Size smallest = sizes[0];
        for (Size s : sizes) {
            if (s.getWidth() * s.getHeight() < smallest.getWidth() * smallest.getHeight()) {
                smallest = s;
            }
            int longest = Math.max(s.getWidth(), s.getHeight());
            if (longest <= cap) {
                int area = s.getWidth() * s.getHeight();
                if (area > bestArea) {
                    bestArea = area;
                    bestFit = s;
                }
            }
        }
        return bestFit != null ? bestFit : smallest;
    }

    private static Range<Integer> chooseFpsRange(Range<Integer>[] ranges, int maxFps) {
        if (ranges == null || ranges.length == 0) return null;
        Range<Integer> best = ranges[0];
        int bestDiff = Integer.MAX_VALUE;
        for (Range<Integer> r : ranges) {
            int diff = Math.abs(r.getUpper() - maxFps);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = r;
            }
        }
        return best;
    }

    private static int chooseFaceDetectMode(int[] modes) {
        if (modes == null || modes.length == 0) {
            return CaptureRequest.STATISTICS_FACE_DETECT_MODE_OFF;
        }
        boolean hasSimple = false;
        boolean hasFull = false;
        for (int mode : modes) {
            if (mode == CaptureRequest.STATISTICS_FACE_DETECT_MODE_SIMPLE) hasSimple = true;
            if (mode == CaptureRequest.STATISTICS_FACE_DETECT_MODE_FULL) hasFull = true;
        }
        if (hasSimple) return CaptureRequest.STATISTICS_FACE_DETECT_MODE_SIMPLE;
        if (hasFull) return CaptureRequest.STATISTICS_FACE_DETECT_MODE_FULL;
        return CaptureRequest.STATISTICS_FACE_DETECT_MODE_OFF;
    }

    private final CameraCaptureSession.CaptureCallback captureCallback =
            new CameraCaptureSession.CaptureCallback() {
                @Override
                public void onCaptureCompleted(
                        CameraCaptureSession session,
                        CaptureRequest request,
                        TotalCaptureResult result) {
                    updateDetectedFaces(result);
                }
            };

    private void updateDetectedFaces(TotalCaptureResult result) {
        if (closed || result == null) return;
        Face[] rawFaces = result.get(CaptureResult.STATISTICS_FACES);
        Rect active = sensorActiveRect;
        long now = System.currentTimeMillis();
        long monoMs = System.nanoTime() / 1_000_000L;
        if (rawFaces == null || rawFaces.length == 0 || active == null || active.width() <= 0 || active.height() <= 0) {
            synchronized (lock) {
                if (!closed) {
                    latestFaces = new float[0];
                    facesUpdatedAtMs = now;
                    facesMonotonicMs = monoMs;
                }
            }
            return;
        }
        int rotation = computeUprightRotationDegrees();
        boolean mirrorHorizontal = (facing == 0);
        float activeW = (float) active.width();
        float activeH = (float) active.height();

        float[][] candidates = new float[Math.min(16, rawFaces.length)][6];
        int count = 0;
        for (Face f : rawFaces) {
            if (f == null) continue;
            Rect b = f.getBounds();
            if (b == null || b.width() <= 0 || b.height() <= 0) continue;
            float sx = ((b.exactCenterX() - active.left) / activeW);
            float sy = ((b.exactCenterY() - active.top) / activeH);
            float sw = b.width() / activeW;
            float sh = b.height() / activeH;

            float nx;
            float ny;
            float nw;
            float nh;
            if (rotation == 90) {
                nx = 1f - sy;
                ny = sx;
                nw = sh;
                nh = sw;
            } else if (rotation == 180) {
                nx = 1f - sx;
                ny = 1f - sy;
                nw = sw;
                nh = sh;
            } else if (rotation == 270) {
                nx = sy;
                ny = 1f - sx;
                nw = sh;
                nh = sw;
            } else {
                nx = sx;
                ny = sy;
                nw = sw;
                nh = sh;
            }
            if (mirrorHorizontal) {
                nx = 1f - nx;
            }
            int rawId = f.getId();
            int trackId = rawId > 0 ? rawId : (count + 1);
            int rawScore = f.getScore();
            float confidence = rawScore > 0
                    ? Math.max(0.1f, Math.min(1.0f, rawScore / 100.0f))
                    : 0.9f;
            candidates[count][0] = (float) trackId;
            candidates[count][1] = Math.max(-1f, Math.min(1f, nx * 2f - 1f));
            candidates[count][2] = Math.max(-1f, Math.min(1f, ny * 2f - 1f));
            candidates[count][3] = Math.max(0f, Math.min(1f, nw));
            candidates[count][4] = Math.max(0f, Math.min(1f, nh));
            candidates[count][5] = confidence;
            count++;
            if (count >= candidates.length) break;
        }

        for (int i = 0; i < count; i++) {
            for (int j = i + 1; j < count; j++) {
                float areaI = candidates[i][3] * candidates[i][4];
                float areaJ = candidates[j][3] * candidates[j][4];
                if (areaJ > areaI) {
                    float[] tmp = candidates[i];
                    candidates[i] = candidates[j];
                    candidates[j] = tmp;
                }
            }
        }

        int kept = Math.min(8, count);
        float[] packed = new float[kept * 6];
        for (int i = 0; i < kept; i++) {
            System.arraycopy(candidates[i], 0, packed, i * 6, 6);
        }
        synchronized (lock) {
            if (!closed) {
                latestFaces = packed;
                facesUpdatedAtMs = now;
                facesMonotonicMs = monoMs;
            }
        }
    }

    public void reconfigure(int nextMaxDimension, int nextMaxFps) {
        final int clampedDim = Math.max(160, Math.min(1920, nextMaxDimension));
        final int clampedFps = Math.max(1, Math.min(30, nextMaxFps));
        final boolean fpsChanged = (this.maxFps != clampedFps);
        this.maxDimension = clampedDim;
        this.maxFps = clampedFps;
        if (!fpsChanged || closed) return;
        handler.post(() -> {
            if (closed || captureSession == null || previewRequestBuilder == null) return;
            Range<Integer> nextRange = chooseFpsRange(availableFpsRanges, clampedFps);
            if (nextRange != null) {
                previewRequestBuilder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, nextRange);
                try {
                    captureSession.setRepeatingRequest(previewRequestBuilder.build(), captureCallback, handler);
                } catch (CameraAccessException | RuntimeException ignored) {
                }
            }
        });
    }

    private void onImageAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null || closed) return;
            long now = System.currentTimeMillis();
            long monoMs = System.nanoTime() / 1_000_000L;
            long minIntervalMs = Math.max(1L, 1000L / Math.max(1, maxFps));
            synchronized (lock) {
                if (lastAcceptedAtMs > 0 && (now - lastAcceptedAtMs) + 4 < minIntervalMs) {
                    return;
                }
                lastAcceptedAtMs = now;
            }
            byte[] nv21 = yuv420ToNv21(image);
            int w = image.getWidth();
            int h = image.getHeight();
            Preview previewTarget;
            synchronized (lock) {
                if (closed) return;
                latestNv21 = nv21;
                rawWidth = w;
                rawHeight = h;
                capturedAtMs = now;
                capturedMonotonicMs = monoMs;
                frames += 1;
                previewTarget = boundPreview;
            }
            if (previewTarget != null) {
                renderPreviewFrame(previewTarget, nv21, w, h);
            }
        } catch (RuntimeException ignored) {
        } finally {
            if (image != null) image.close();
        }
    }

    private static byte[] yuv420ToNv21(Image image) {
        int width = image.getWidth();
        int height = image.getHeight();
        byte[] nv21 = new byte[width * height + (width * height) / 2];
        Image.Plane[] planes = image.getPlanes();
        ByteBuffer yBuf = planes[0].getBuffer();
        ByteBuffer uBuf = planes[1].getBuffer();
        ByteBuffer vBuf = planes[2].getBuffer();
        int yRowStride = planes[0].getRowStride();
        int yPixelStride = planes[0].getPixelStride();
        int pos = 0;
        if (yPixelStride == 1 && yRowStride == width) {
            yBuf.get(nv21, 0, width * height);
            pos = width * height;
        } else {
            byte[] row = new byte[yRowStride];
            for (int r = 0; r < height; r++) {
                int len = Math.min(yRowStride, yBuf.remaining());
                yBuf.get(row, 0, len);
                for (int c = 0; c < width; c++) {
                    nv21[pos++] = row[c * yPixelStride];
                }
            }
        }
        int uvRowStride = planes[2].getRowStride();
        int uvPixelStride = planes[2].getPixelStride();
        int chromaHeight = height / 2;
        int chromaWidth = width / 2;
        for (int r = 0; r < chromaHeight; r++) {
            int rowBase = r * uvRowStride;
            for (int c = 0; c < chromaWidth; c++) {
                int idx = rowBase + c * uvPixelStride;
                nv21[pos++] = vBuf.get(idx);
                nv21[pos++] = uBuf.get(idx);
            }
        }
        return nv21;
    }

    private Bitmap decodeUprightBitmap(byte[] encoded, int targetMax) {
        Bitmap src = BitmapFactory.decodeByteArray(encoded, 0, encoded.length);
        if (src == null) return null;
        int rotation = computeUprightRotationDegrees();
        boolean mirrorHorizontal = (facing == 0);
        int rotatedW = (rotation == 90 || rotation == 270) ? src.getHeight() : src.getWidth();
        int rotatedH = (rotation == 90 || rotation == 270) ? src.getWidth() : src.getHeight();
        int rotatedLongest = Math.max(rotatedW, rotatedH);

        if (rotation == 0 && !mirrorHorizontal && (targetMax <= 0 || rotatedLongest <= targetMax)) {
            return src;
        }

        Matrix matrix = new Matrix();
        if (rotation != 0) {
            matrix.postRotate(rotation);
        }
        if (mirrorHorizontal) {
            matrix.postScale(-1f, 1f);
        }
        if (targetMax > 0 && rotatedLongest > targetMax) {
            float scale = (float) targetMax / (float) rotatedLongest;
            matrix.postScale(scale, scale);
        }
        Bitmap transformed = Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), matrix, true);
        if (transformed != src) {
            src.recycle();
        }
        return transformed;
    }

    private void renderPreviewFrame(Preview view, byte[] nv21, int w, int h) {
        if (!view.surfaceAvailable) return;
        YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, w, h, null);
        ByteArrayOutputStream jpegOut = new ByteArrayOutputStream();
        if (!yuv.compressToJpeg(new Rect(0, 0, w, h), 72, jpegOut)) return;
        byte[] jpegBytes = jpegOut.toByteArray();
        Bitmap bmp = decodeUprightBitmap(jpegBytes, 0);
        if (bmp == null) return;

        try {
            synchronized (view.surfaceLock) {
                if (!view.surfaceAvailable || !view.isAvailable()) return;
                Canvas canvas = view.lockCanvas();
                if (canvas == null) return;
                try {
                    int cw = canvas.getWidth();
                    int ch = canvas.getHeight();
                    int bw = bmp.getWidth();
                    int bh = bmp.getHeight();
                    canvas.drawColor(Color.BLACK);
                    if (cw > 0 && ch > 0 && bw > 0 && bh > 0) {
                        float scale = Math.max((float) cw / (float) bw, (float) ch / (float) bh);
                        float dx = (cw - bw * scale) * 0.5f;
                        float dy = (ch - bh * scale) * 0.5f;
                        Matrix fit = new Matrix();
                        fit.postScale(scale, scale);
                        fit.postTranslate(dx, dy);
                        canvas.drawBitmap(bmp, fit, new Paint(Paint.FILTER_BITMAP_FLAG));
                    }
                    synchronized (lock) {
                        previewDisplayed = true;
                    }
                } finally {
                    view.unlockCanvasAndPost(canvas);
                }
            }
        } finally {
            bmp.recycle();
        }
    }

    private static float computeLandscapeHfovDeg(CameraCharacteristics chars) {
        if (chars == null) return 0f;
        try {
            float[] focalLengths = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
            SizeF phys = chars.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
            if (focalLengths == null || focalLengths.length == 0 || phys == null) return 0f;
            float focal = focalLengths[0];
            float sensorLongMm = Math.max(phys.getWidth(), phys.getHeight());
            if (!(focal > 0f) || !(sensorLongMm > 0f)) return 0f;
            return (float) Math.toDegrees(2.0 * Math.atan(sensorLongMm / (2.0 * focal)));
        } catch (RuntimeException ignored) {
            return 0f;
        }
    }

    public static float queryHfovDeg(int facing) {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) return 0f;
        CameraManager mgr = (CameraManager) app.getSystemService(Context.CAMERA_SERVICE);
        if (mgr == null) return 0f;
        int desiredFacing = facing == 1
                ? CameraCharacteristics.LENS_FACING_BACK
                : CameraCharacteristics.LENS_FACING_FRONT;
        try {
            for (String candidate : mgr.getCameraIdList()) {
                CameraCharacteristics chars = mgr.getCameraCharacteristics(candidate);
                Integer lens = chars.get(CameraCharacteristics.LENS_FACING);
                if (lens != null && lens == desiredFacing) {
                    return computeLandscapeHfovDeg(chars);
                }
            }
        } catch (CameraAccessException | RuntimeException ignored) {}
        return 0f;
    }

    public Snapshot jpeg(int reqMaxDimension) {
        byte[] nv21;
        int w;
        int h;
        long ts;
        long monoMs;
        long facesMonoMs;
        float fov;
        long seq;
        int fallbackDim;
        float[] facesSnapshot;
        long now = System.currentTimeMillis();
        synchronized (lock) {
            if (closed || latestNv21 == null || frames == 0) return null;
            nv21 = latestNv21;
            w = rawWidth;
            h = rawHeight;
            ts = capturedAtMs;
            monoMs = capturedMonotonicMs;
            facesMonoMs = facesMonotonicMs;
            fov = hfovDeg;
            seq = frames;
            fallbackDim = maxDimension;
            facesSnapshot = (facesUpdatedAtMs > 0 && (now - facesUpdatedAtMs) <= 1500 && latestFaces != null)
                    ? latestFaces.clone()
                    : new float[0];
        }
        int targetMax = Math.max(160, Math.min(1920, reqMaxDimension > 0 ? reqMaxDimension : fallbackDim));
        YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, w, h, null);
        ByteArrayOutputStream rawJpeg = new ByteArrayOutputStream();
        if (!yuv.compressToJpeg(new Rect(0, 0, w, h), 84, rawJpeg)) return null;
        byte[] encoded = rawJpeg.toByteArray();

        int longest = Math.max(w, h);
        int rotation = computeUprightRotationDegrees();
        boolean mirrorHorizontal = (facing == 0);
        if (longest <= targetMax && rotation == 0 && !mirrorHorizontal) {
            return new Snapshot(encoded, w, h, ts, monoMs, facesMonoMs, fov, seq, facesSnapshot);
        }

        Bitmap transformed = decodeUprightBitmap(encoded, targetMax);
        if (transformed == null) return null;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        boolean ok = transformed.compress(Bitmap.CompressFormat.JPEG, 78, out);
        int finalW = transformed.getWidth();
        int finalH = transformed.getHeight();
        transformed.recycle();
        if (!ok) return null;
        return new Snapshot(out.toByteArray(), finalW, finalH, ts, monoMs, facesMonoMs, fov, seq, facesSnapshot);
    }

    public FacesSnapshot facesSnapshot() {
        int w;
        int h;
        long ts;
        long monoMs;
        long facesMonoMs;
        float fov;
        long seq;
        float[] facesSnapshot;
        long now = System.currentTimeMillis();
        synchronized (lock) {
            if (closed || frames == 0) return null;
            w = rawWidth;
            h = rawHeight;
            ts = capturedAtMs;
            monoMs = capturedMonotonicMs;
            facesMonoMs = facesMonotonicMs;
            fov = hfovDeg;
            seq = frames;
            facesSnapshot = (facesUpdatedAtMs > 0 && (now - facesUpdatedAtMs) <= 1500 && latestFaces != null)
                    ? latestFaces.clone()
                    : new float[0];
        }
        return new FacesSnapshot(w, h, ts, monoMs, facesMonoMs, fov, seq, facesSnapshot);
    }

    public CropResult cropJpeg(
            float nx,
            float ny,
            float nw,
            float nh,
            int reqMaxDimension,
            int jpegQuality) {
        byte[] nv21;
        int w;
        int h;
        long monoMs;
        synchronized (lock) {
            if (closed || latestNv21 == null || frames == 0) return null;
            nv21 = latestNv21;
            w = rawWidth;
            h = rawHeight;
            monoMs = capturedMonotonicMs;
        }
        YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, w, h, null);
        ByteArrayOutputStream rawJpeg = new ByteArrayOutputStream();
        if (!yuv.compressToJpeg(new Rect(0, 0, w, h), 92, rawJpeg)) return null;
        Bitmap upright = decodeUprightBitmap(rawJpeg.toByteArray(), 1280);
        if (upright == null) return null;

        Bitmap cropped = null;
        Bitmap scaled = null;
        try {
            int bw = upright.getWidth();
            int bh = upright.getHeight();
            if (bw <= 0 || bh <= 0) return null;

            float cx = Math.max(0f, Math.min(1f, nx));
            float cy = Math.max(0f, Math.min(1f, ny));
            float cw = Math.max(0.01f, Math.min(1f - cx, nw));
            float ch = Math.max(0.01f, Math.min(1f - cy, nh));

            int px = Math.max(0, Math.min(bw - 1, Math.round(cx * bw)));
            int py = Math.max(0, Math.min(bh - 1, Math.round(cy * bh)));
            int pw = Math.max(1, Math.min(bw - px, Math.round(cw * bw)));
            int ph = Math.max(1, Math.min(bh - py, Math.round(ch * bh)));

            cropped = Bitmap.createBitmap(upright, px, py, pw, ph);
            int targetMax = Math.max(64, Math.min(1024, reqMaxDimension > 0 ? reqMaxDimension : 320));
            int longest = Math.max(pw, ph);
            Bitmap outputBmp = cropped;
            if (longest > targetMax) {
                float scale = (float) targetMax / (float) longest;
                int outW = Math.max(1, Math.round(pw * scale));
                int outH = Math.max(1, Math.round(ph * scale));
                scaled = Bitmap.createScaledBitmap(cropped, outW, outH, true);
                outputBmp = scaled;
            }
            ByteArrayOutputStream jpegOut = new ByteArrayOutputStream();
            int quality = Math.max(40, Math.min(95, jpegQuality > 0 ? jpegQuality : 84));
            if (!outputBmp.compress(Bitmap.CompressFormat.JPEG, quality, jpegOut)) {
                return null;
            }
            return new CropResult(jpegOut.toByteArray(), outputBmp.getWidth(), outputBmp.getHeight(), monoMs);
        } finally {
            upright.recycle();
            if (cropped != null && cropped != upright && !cropped.isRecycled()) {
                cropped.recycle();
            }
            if (scaled != null && scaled != cropped && !scaled.isRecycled()) {
                scaled.recycle();
            }
        }
    }

    private int computeUprightRotationDegrees() {
        Activity owner = SuperLooiApplication.foregroundActivity();
        int displayRotation = owner != null
                ? owner.getWindowManager().getDefaultDisplay().getRotation()
                : Surface.ROTATION_90;
        int degrees = displayRotation == Surface.ROTATION_90 ? 90
                : displayRotation == Surface.ROTATION_180 ? 180
                : displayRotation == Surface.ROTATION_270 ? 270 : 0;
        if (facing == 0) {
            return (sensorOrientation + degrees) % 360;
        }
        return (sensorOrientation - degrees + 360) % 360;
    }

    public long[] status() {
        synchronized (lock) {
            return new long[]{
                    frames,
                    rawWidth,
                    rawHeight,
                    capturedAtMs,
                    errorCode,
                    previewDisplayed ? 1 : 0,
                    closed ? 1 : 0,
            };
        }
    }

    public String failure() {
        synchronized (lock) {
            return failureMessage;
        }
    }

    private void closeWithError(int code, String message) {
        synchronized (lock) {
            errorCode = code;
            failureMessage = message;
        }
        close();
    }

    public void close() {
        synchronized (lock) {
            if (closed) return;
            closed = true;
            boundPreview = null;
            latestNv21 = null;
            latestFaces = new float[0];
        }
        WeakReference<DeviceCameraBridge> currentRef = sessions.get(id);
        if (currentRef != null) {
            DeviceCameraBridge current = currentRef.get();
            if (current == null || current == this) {
                sessions.remove(id, currentRef);
            }
        }
        handler.post(() -> {
            try {
                previewRequestBuilder = null;
                if (captureSession != null) {
                    try { captureSession.close(); } catch (RuntimeException ignored) {}
                    captureSession = null;
                }
                if (cameraDevice != null) {
                    try { cameraDevice.close(); } catch (RuntimeException ignored) {}
                    cameraDevice = null;
                }
                if (imageReader != null) {
                    try { imageReader.close(); } catch (RuntimeException ignored) {}
                    imageReader = null;
                }
            } finally {
                thread.quitSafely();
            }
        });
    }

    static void registerComponents(Activity activity) {
        View content = activity.findViewById(android.R.id.content);
        if (!(content instanceof FrameLayout) || ((FrameLayout) content).getChildCount() == 0) return;
        View host = ((FrameLayout) content).getChildAt(0);
        if (!host.getClass().getName().equals("com.longbridge.nsh.NshView")) return;
        try {
            ClassLoader loader = host.getClass().getClassLoader();
            Class<?> factory = Class.forName("com.longbridge.nsh.NshComponent$Factory", true, loader);
            Class<?> component = Class.forName("com.longbridge.nsh.NshComponent", true, loader);
            Object value = Proxy.newProxyInstance(loader, new Class<?>[]{factory}, (proxy, method, args) -> {
                if ("create".equals(method.getName())) {
                    Preview preview = new Preview(activity, args[0]);
                    return Proxy.newProxyInstance(loader, new Class<?>[]{component}, (p, m, a) -> {
                        switch (m.getName()) {
                            case "view":
                                return preview;
                            case "setProp":
                                if ("sessionId".equals(a[0])) {
                                    preview.bind(a[1] instanceof String ? (String) a[1] : "");
                                }
                                return null;
                            case "destroy":
                                preview.destroy();
                                return null;
                            case "toString":
                                return "DeviceCameraPreview";
                            case "hashCode":
                                return System.identityHashCode(p);
                            case "equals":
                                return p == a[0];
                            default:
                                return null;
                        }
                    });
                }
                if ("hashCode".equals(method.getName())) return System.identityHashCode(proxy);
                if ("equals".equals(method.getName())) return proxy == args[0];
                return "DeviceCameraPreviewFactory";
            });
            host.getClass().getMethod("registerComponent", String.class, factory)
                    .invoke(host, "looi.DeviceCameraPreview", value);
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException("device_camera_component_register", failure);
        }
    }

    private static final class Preview extends TextureView implements TextureView.SurfaceTextureListener {
        final Object surfaceLock = new Object();
        volatile boolean surfaceAvailable;
        private String wantedSessionId = "";
        private DeviceCameraBridge bridge;
        private DeviceCameraBridge lastClosedEmitted;
        private boolean destroyed;
        private final Object context;
        private final Handler main = new Handler(Looper.getMainLooper());
        private final Runnable observer = new Runnable() {
            @Override public void run() {
                if (destroyed || wantedSessionId.isEmpty()) return;
                reconcileBinding();
                DeviceCameraBridge current = bridge;
                if (current != null) {
                    long[] s = current.status();
                    boolean isClosed = s[6] != 0;
                    if (!isClosed || lastClosedEmitted != current) {
                        if (isClosed) {
                            lastClosedEmitted = current;
                        }
                        Map<String, Object> state = new HashMap<>();
                        state.put("sessionId", current.id);
                        state.put("facing", current.facing == 1 ? "back" : "front");
                        state.put("frames", s[0]);
                        state.put("width", s[1]);
                        state.put("height", s[2]);
                        state.put("capturedAtMs", s[3]);
                        state.put("error", s[4]);
                        state.put("displayed", s[5] != 0);
                        state.put("closed", isClosed);
                        state.put("failure", current.failure());
                        try {
                            context.getClass().getMethod("emit", String.class, Object.class)
                                    .invoke(context, "state", state);
                        } catch (ReflectiveOperationException failure) {
                            throw new IllegalStateException("device_camera_component_event", failure);
                        }
                    }
                }
                main.postDelayed(this, 250);
            }
        };

        Preview(Context owner, Object context) {
            super(owner);
            this.context = context;
            this.surfaceAvailable = isAvailable();
            setSurfaceTextureListener(this);
        }

        private void detachCurrentBridge() {
            if (bridge != null) {
                synchronized (bridge.lock) {
                    if (bridge.boundPreview == this) {
                        bridge.boundPreview = null;
                    }
                }
                bridge = null;
            }
        }

        private void reconcileBinding() {
            WeakReference<DeviceCameraBridge> ref =
                    wantedSessionId.isEmpty() ? null : sessions.get(wantedSessionId);
            DeviceCameraBridge candidate = ref == null ? null : ref.get();
            if (candidate == bridge) return;
            detachCurrentBridge();
            bridge = candidate;
            if (bridge != null) {
                synchronized (bridge.lock) {
                    if (!bridge.closed) {
                        bridge.boundPreview = this;
                        bridge.previewDisplayed = false;
                    }
                }
            }
        }

        void bind(String sessionId) {
            if (destroyed) return;
            main.removeCallbacks(observer);
            wantedSessionId = sessionId != null ? sessionId.trim() : "";
            reconcileBinding();
            if (!wantedSessionId.isEmpty()) {
                main.post(observer);
            } else {
                detachCurrentBridge();
            }
        }

        void destroy() {
            destroyed = true;
            wantedSessionId = "";
            main.removeCallbacks(observer);
            detachCurrentBridge();
        }

        @Override public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
            synchronized (surfaceLock) {
                surfaceAvailable = true;
            }
        }

        @Override public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {}

        @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
            synchronized (surfaceLock) {
                surfaceAvailable = false;
            }
            return true;
        }

        @Override public void onSurfaceTextureUpdated(SurfaceTexture surface) {}
    }
}
