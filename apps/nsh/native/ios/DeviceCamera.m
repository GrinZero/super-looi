#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <VideoToolbox/VideoToolbox.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

extern void looi_device_camera_background(void);
extern void looi_device_camera_foreground(void);

typedef struct {
    int32_t track_id;
    float offset_x;
    float offset_y;
    float width;
    float height;
    float confidence;
} LCDetectedFace;

static char *LCDupError(NSString *message) {
    const char *utf8 = message ? message.UTF8String : "ERR_DEVICE_CAMERA_UNKNOWN";
    size_t len = strlen(utf8);
    char *copy = (char *)malloc(len + 1);
    if (copy) memcpy(copy, utf8, len + 1);
    return copy;
}

static void LCRunOnMainSync(dispatch_block_t block) {
    if (NSThread.isMainThread) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }
}

static void LCReadActiveSceneContext(CALayer * __strong *layerOut, UIInterfaceOrientation *orientationOut) {
    __block CALayer *foundLayer = nil;
    __block UIInterfaceOrientation foundOrientation = UIInterfaceOrientationLandscapeRight;
    LCRunOnMainSync(^{
        for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
            if (![scene isKindOfClass:UIWindowScene.class]) continue;
            UIWindowScene *windowScene = (UIWindowScene *)scene;
            if (windowScene.activationState == UISceneActivationStateForegroundActive ||
                windowScene.activationState == UISceneActivationStateForegroundInactive ||
                !foundLayer) {
                if (orientationOut) {
                    UIInterfaceOrientation io;
                    if (@available(iOS 26.0, *)) {
                        io = windowScene.effectiveGeometry.interfaceOrientation;
                    } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
                        io = windowScene.interfaceOrientation;
#pragma clang diagnostic pop
                    }
                    if (io == UIInterfaceOrientationLandscapeLeft || io == UIInterfaceOrientationLandscapeRight) {
                        foundOrientation = io;
                    }
                }
                for (UIWindow *win in windowScene.windows) {
                    if (win.isKeyWindow || !foundLayer) {
                        foundLayer = win.layer;
                        if (win.isKeyWindow) break;
                    }
                }
                if (windowScene.activationState == UISceneActivationStateForegroundActive && foundLayer) {
                    break;
                }
            }
        }
    });
    if (layerOut) *layerOut = foundLayer;
    if (orientationOut) *orientationOut = foundOrientation;
}

@interface LCDeviceCameraSession : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureMetadataOutputObjectsDelegate> {
@public
    dispatch_queue_t _sessionQueue;
    dispatch_queue_t _sampleQueue;
    dispatch_queue_t _metadataQueue;
    NSLock *_lock;
    AVCaptureSession *_session;
    AVCaptureDevice *_device;
    AVCaptureDeviceInput *_input;
    AVCaptureVideoDataOutput *_output;
    AVCaptureMetadataOutput *_metadataOutput;
    id _rotationCoordinator;
    id _runtimeErrorObserver;
    id _orientationObserver;
    id _activeSceneObserver;
    CVPixelBufferRef _latest;
    LCDetectedFace _faces[8];
    int32_t _faceCount;
    int64_t _facesUpdatedAtMs;
    uint64_t _frames;
    int64_t _capturedAtMs;
    int64_t _lastAcceptedAtMs;
    int32_t _width;
    int32_t _height;
    int32_t _maxDimension;
    int32_t _maxFps;
    int32_t _facing;
    int32_t _error;
    NSString *_failureMessage;
    BOOL _closed;
    BOOL _displayScheduled;
    BOOL _displayed;
    __weak AVSampleBufferDisplayLayer *_display;
}
- (BOOL)configureWithFacing:(int32_t)facing
               maxDimension:(int32_t)maxDimension
                     maxFps:(int32_t)maxFps
                      error:(NSString **)errorOut;
- (void)reconfigureMaxDimension:(int32_t)maxDimension maxFps:(int32_t)maxFps;
- (void)refreshVideoOrientationFromMain;
- (void)close;
@end

static void LCFlushDisplayLayer(AVSampleBufferDisplayLayer *display, BOOL removeImage) {
    if (!display) return;
    if (@available(iOS 18.0, *)) {
        if (removeImage) {
            [display.sampleBufferRenderer flushWithRemovalOfDisplayedImage:YES completionHandler:nil];
        } else {
            [display.sampleBufferRenderer flush];
        }
    } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        if (removeImage) [display flushAndRemoveImage];
        else [display flush];
#pragma clang diagnostic pop
    }
}

static void LCApplyFrameRate(AVCaptureDevice *device, int32_t maxFps) {
    if (!device) return;
    int32_t targetFps = MAX(1, MIN(30, maxFps));
    AVFrameRateRange *matched = nil;
    double bestMin = 1000.0;
    for (AVFrameRateRange *range in device.activeFormat.videoSupportedFrameRateRanges) {
        if (range.minFrameRate <= targetFps && targetFps <= range.maxFrameRate) {
            matched = range;
            break;
        }
        if (range.minFrameRate < bestMin) {
            bestMin = range.minFrameRate;
            matched = range;
        }
    }
    if (!matched) return;
    double clamped = MAX(matched.minFrameRate, MIN(matched.maxFrameRate, (double)targetFps));
    CMTime duration = CMTimeMake(1, (int32_t)llround(clamped));
    NSError *lockError = nil;
    if ([device lockForConfiguration:&lockError]) {
        device.activeVideoMinFrameDuration = duration;
        device.activeVideoMaxFrameDuration = duration;
        [device unlockForConfiguration];
    }
}

static void LCApplyLandscapeConnection(AVCaptureConnection *connection,
                                       BOOL isFront,
                                       CGFloat preferredAngle,
                                       BOOL hasPreferredAngle,
                                       UIInterfaceOrientation interfaceOrientation) {
    if (!connection) return;
    BOOL isLandscapeLeft = (interfaceOrientation == UIInterfaceOrientationLandscapeLeft);
    if (@available(iOS 17.0, *)) {
        CGFloat angle = hasPreferredAngle
            ? preferredAngle
            : (isLandscapeLeft ? (isFront ? 0.0 : 180.0) : (isFront ? 180.0 : 0.0));
        if ([connection isVideoRotationAngleSupported:angle]) {
            connection.videoRotationAngle = angle;
        } else if ([connection isVideoRotationAngleSupported:0.0]) {
            connection.videoRotationAngle = 0.0;
        }
    } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        if (connection.isVideoOrientationSupported) {
            connection.videoOrientation = isLandscapeLeft
                ? AVCaptureVideoOrientationLandscapeLeft
                : AVCaptureVideoOrientationLandscapeRight;
        }
#pragma clang diagnostic pop
    }
    if (connection.isVideoMirroringSupported) {
        connection.automaticallyAdjustsVideoMirroring = NO;
        connection.videoMirrored = isFront;
    }
}

@implementation LCDeviceCameraSession

- (instancetype)init {
    if ((self = [super init])) {
        _sessionQueue = dispatch_queue_create("com.superlooi.device_camera.session", DISPATCH_QUEUE_SERIAL);
        _sampleQueue = dispatch_queue_create("com.superlooi.device_camera.sample", DISPATCH_QUEUE_SERIAL);
        _metadataQueue = dispatch_queue_create("com.superlooi.device_camera.metadata", DISPATCH_QUEUE_SERIAL);
        _lock = [NSLock new];
    }
    return self;
}

- (void)queryRotationAngle:(CGFloat *)angleOut
                  hasAngle:(BOOL *)hasAngleOut
      interfaceOrientation:(UIInterfaceOrientation *)orientationOut {
    CALayer *windowLayer = nil;
    UIInterfaceOrientation io = UIInterfaceOrientationLandscapeRight;
    LCReadActiveSceneContext(&windowLayer, &io);
    if (orientationOut) *orientationOut = io;

    if (@available(iOS 17.0, *)) {
        __block CGFloat resolvedAngle = 0.0;
        __block BOOL resolved = NO;
        AVCaptureDevice *device = _device;
        LCRunOnMainSync(^{
            if (!device) return;
            AVCaptureDeviceRotationCoordinator *coord = (AVCaptureDeviceRotationCoordinator *)self->_rotationCoordinator;
            if (!coord || (windowLayer && coord.previewLayer != windowLayer)) {
                coord = [[AVCaptureDeviceRotationCoordinator alloc] initWithDevice:device previewLayer:windowLayer];
                self->_rotationCoordinator = coord;
            }
            if (windowLayer) {
                resolvedAngle = coord.videoRotationAngleForHorizonLevelPreview;
                resolved = YES;
            } else {
                CGFloat captureAngle = coord.videoRotationAngleForHorizonLevelCapture;
                if (captureAngle == 0.0 || captureAngle == 180.0) {
                    resolvedAngle = captureAngle;
                    resolved = YES;
                }
            }
        });
        if (angleOut) *angleOut = resolvedAngle;
        if (hasAngleOut) *hasAngleOut = resolved;
        return;
    }

    if (angleOut) *angleOut = 0.0;
    if (hasAngleOut) *hasAngleOut = NO;
}

- (void)refreshVideoOrientationFromMain {
    [_lock lock];
    if (_closed) {
        [_lock unlock];
        return;
    }
    int32_t facing = _facing;
    [_lock unlock];

    CGFloat angle = 0.0;
    BOOL hasAngle = NO;
    UIInterfaceOrientation io = UIInterfaceOrientationLandscapeRight;
    [self queryRotationAngle:&angle hasAngle:&hasAngle interfaceOrientation:&io];

    dispatch_async(_sessionQueue, ^{
        [self->_lock lock];
        BOOL closed = self->_closed;
        [self->_lock unlock];
        if (closed || !self->_session || !self->_output) return;
        LCApplyLandscapeConnection(
            [self->_output connectionWithMediaType:AVMediaTypeVideo],
            facing == 0,
            angle,
            hasAngle,
            io);
    });
}

- (BOOL)configureWithFacing:(int32_t)facing
               maxDimension:(int32_t)maxDimension
                     maxFps:(int32_t)maxFps
                      error:(NSString **)errorOut {
    __block BOOL ok = NO;
    __block NSString *failure = nil;
    dispatch_sync(_sessionQueue, ^{
        @autoreleasepool {
            AVAuthorizationStatus auth = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
            if (auth != AVAuthorizationStatusAuthorized) {
                failure = auth == AVAuthorizationStatusNotDetermined
                    ? @"ERR_CAMERA_PERMISSION_UNDETERMINED: Camera permission has not been requested"
                    : @"ERR_CAMERA_PERMISSION_DENIED: Camera permission denied by OS";
                return;
            }
            AVCaptureDevicePosition pos = (facing == 1) ? AVCaptureDevicePositionBack : AVCaptureDevicePositionFront;
            AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                                                                         mediaType:AVMediaTypeVideo
                                                                          position:pos];
            if (!device) {
                failure = [NSString stringWithFormat:@"ERR_DEVICE_CAMERA_NO_DEVICE: Camera lens (%@) unavailable on this device",
                           facing == 1 ? @"back" : @"front"];
                return;
            }
            NSError *inputError = nil;
            AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&inputError];
            if (!input || inputError) {
                failure = [NSString stringWithFormat:@"ERR_DEVICE_CAMERA_INPUT_FAILED: code=%ld %@",
                           (long)inputError.code, inputError.localizedDescription ?: @"Cannot open camera input"];
                return;
            }

            AVCaptureSession *session = [AVCaptureSession new];
            [session beginConfiguration];
            NSString *desiredPreset = maxDimension > 640 ? AVCaptureSessionPreset1280x720 : AVCaptureSessionPreset640x480;
            if ([session canSetSessionPreset:desiredPreset]) {
                session.sessionPreset = desiredPreset;
            } else if ([session canSetSessionPreset:AVCaptureSessionPresetMedium]) {
                session.sessionPreset = AVCaptureSessionPresetMedium;
            }
            if (![session canAddInput:input]) {
                [session commitConfiguration];
                failure = @"ERR_DEVICE_CAMERA_ADD_INPUT_REJECTED: AVCaptureSession rejected camera input";
                return;
            }
            [session addInput:input];

            AVCaptureVideoDataOutput *output = [AVCaptureVideoDataOutput new];
            output.alwaysDiscardsLateVideoFrames = YES;
            output.videoSettings = @{
                (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
                (id)kCVPixelBufferCGImageCompatibilityKey : @YES,
            };
            [output setSampleBufferDelegate:self queue:self->_sampleQueue];
            if (![session canAddOutput:output]) {
                [session commitConfiguration];
                failure = @"ERR_DEVICE_CAMERA_ADD_OUTPUT_REJECTED: AVCaptureSession rejected video output";
                return;
            }
            [session addOutput:output];

            AVCaptureMetadataOutput *metadataOutput = [AVCaptureMetadataOutput new];
            [metadataOutput setMetadataObjectsDelegate:self queue:self->_metadataQueue];
            if ([session canAddOutput:metadataOutput]) {
                [session addOutput:metadataOutput];
                if ([metadataOutput.availableMetadataObjectTypes containsObject:AVMetadataObjectTypeFace]) {
                    metadataOutput.metadataObjectTypes = @[AVMetadataObjectTypeFace];
                }
                self->_metadataOutput = metadataOutput;
            }

            self->_device = device;
            CGFloat initialAngle = 0.0;
            BOOL hasInitialAngle = NO;
            UIInterfaceOrientation initialIo = UIInterfaceOrientationLandscapeRight;
            [self queryRotationAngle:&initialAngle hasAngle:&hasInitialAngle interfaceOrientation:&initialIo];
            LCApplyLandscapeConnection(
                [output connectionWithMediaType:AVMediaTypeVideo],
                facing == 0,
                initialAngle,
                hasInitialAngle,
                initialIo);

            [session commitConfiguration];
            LCApplyFrameRate(device, maxFps);

            self->_session = session;
            self->_input = input;
            self->_output = output;
            [self->_lock lock];
            self->_facing = facing;
            self->_maxDimension = MAX(160, MIN(1920, maxDimension));
            self->_maxFps = MAX(1, MIN(30, maxFps));
            [self->_lock unlock];

            __weak LCDeviceCameraSession *weakSelf = self;
            self->_runtimeErrorObserver = [NSNotificationCenter.defaultCenter
                addObserverForName:AVCaptureSessionRuntimeErrorNotification
                            object:session
                             queue:nil
                        usingBlock:^(NSNotification *note) {
                            LCDeviceCameraSession *strongSelf = weakSelf;
                            if (!strongSelf) return;
                            NSError *err = note.userInfo[AVCaptureSessionErrorKey];
                            [strongSelf->_lock lock];
                            strongSelf->_error = (int32_t)(err ? err.code : -1);
                            strongSelf->_failureMessage = [NSString stringWithFormat:@"ERR_DEVICE_CAMERA_RUNTIME: code=%ld %@",
                                (long)(err ? err.code : -1), err.localizedDescription ?: @"AVCaptureSession interrupted"];
                            [strongSelf->_lock unlock];
                        }];

            self->_orientationObserver = [NSNotificationCenter.defaultCenter
                addObserverForName:UIDeviceOrientationDidChangeNotification
                            object:nil
                             queue:NSOperationQueue.mainQueue
                        usingBlock:^(NSNotification *note) {
                            (void)note;
                            [weakSelf refreshVideoOrientationFromMain];
                        }];

            self->_activeSceneObserver = [NSNotificationCenter.defaultCenter
                addObserverForName:UIApplicationDidBecomeActiveNotification
                            object:nil
                             queue:NSOperationQueue.mainQueue
                        usingBlock:^(NSNotification *note) {
                            (void)note;
                            [weakSelf refreshVideoOrientationFromMain];
                        }];

            ok = YES;
            dispatch_async(self->_sessionQueue, ^{
                @autoreleasepool {
                    [self->_lock lock];
                    BOOL closed = self->_closed;
                    [self->_lock unlock];
                    if (!closed && self->_session && !self->_session.running) {
                        [self->_session startRunning];
                    }
                }
            });
        }
    });

    if (!ok && errorOut) {
        *errorOut = failure ?: @"ERR_DEVICE_CAMERA_OPEN_FAILED";
    }
    return ok;
}

- (void)reconfigureMaxDimension:(int32_t)maxDimension maxFps:(int32_t)maxFps {
    int32_t clampedDim = MAX(160, MIN(1920, maxDimension));
    int32_t clampedFps = MAX(1, MIN(30, maxFps));
    [_lock lock];
    if (_closed) {
        [_lock unlock];
        return;
    }
    BOOL dimChanged = (_maxDimension > 640) != (clampedDim > 640);
    _maxDimension = clampedDim;
    _maxFps = clampedFps;
    int32_t facing = _facing;
    [_lock unlock];

    dispatch_async(_sessionQueue, ^{
        @autoreleasepool {
            [self->_lock lock];
            BOOL closed = self->_closed;
            [self->_lock unlock];
            if (closed || !self->_session) return;
            if (dimChanged) {
                NSString *desiredPreset = clampedDim > 640 ? AVCaptureSessionPreset1280x720 : AVCaptureSessionPreset640x480;
                if ([self->_session canSetSessionPreset:desiredPreset]) {
                    CGFloat angle = 0.0;
                    BOOL hasAngle = NO;
                    UIInterfaceOrientation io = UIInterfaceOrientationLandscapeRight;
                    [self queryRotationAngle:&angle hasAngle:&hasAngle interfaceOrientation:&io];
                    [self->_session beginConfiguration];
                    self->_session.sessionPreset = desiredPreset;
                    LCApplyLandscapeConnection(
                        [self->_output connectionWithMediaType:AVMediaTypeVideo],
                        facing == 0,
                        angle,
                        hasAngle,
                        io);
                    [self->_session commitConfiguration];
                }
            }
            LCApplyFrameRate(self->_device, clampedFps);
        }
    });
}

- (void)captureOutput:(AVCaptureOutput *)output
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
       fromConnection:(AVCaptureConnection *)connection {
    (void)output;
    (void)connection;
    @autoreleasepool {
        CVImageBufferRef image = CMSampleBufferGetImageBuffer(sampleBuffer);
        if (!image) return;

        int64_t nowMs = (int64_t)llround(NSDate.date.timeIntervalSince1970 * 1000.0);
        [_lock lock];
        if (_closed) {
            [_lock unlock];
            return;
        }
        int64_t minIntervalMs = MAX(1, 1000 / MAX(1, _maxFps));
        if (_lastAcceptedAtMs > 0 && (nowMs - _lastAcceptedAtMs) + 4 < minIntervalMs) {
            [_lock unlock];
            return;
        }
        _lastAcceptedAtMs = nowMs;
        CVPixelBufferRetain(image);
        if (_latest) CVPixelBufferRelease(_latest);
        _latest = image;
        _width = (int32_t)CVPixelBufferGetWidth(image);
        _height = (int32_t)CVPixelBufferGetHeight(image);
        _capturedAtMs = nowMs;
        _frames += 1;

        BOOL schedule = (_display != nil) && !_displayScheduled;
        if (schedule) _displayScheduled = YES;
        [_lock unlock];

        if (!schedule) return;
        dispatch_async(dispatch_get_main_queue(), ^{
            @autoreleasepool {
                [self->_lock lock];
                self->_displayScheduled = NO;
                AVSampleBufferDisplayLayer *display = self->_display;
                CVPixelBufferRef pixel = (!self->_closed && display) ? self->_latest : NULL;
                if (pixel) CVPixelBufferRetain(pixel);
                [self->_lock unlock];
                if (!pixel) return;

                CMVideoFormatDescriptionRef format = NULL;
                CMSampleBufferRef previewSample = NULL;
                if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixel, &format) == noErr) {
                    CMSampleTimingInfo timing = { kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid };
                    if (CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pixel, format, &timing, &previewSample) == noErr) {
                        CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(previewSample, YES);
                        if (attachments && CFArrayGetCount(attachments) > 0) {
                            CFMutableDictionaryRef attrs = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
                            CFDictionarySetValue(attrs, kCMSampleAttachmentKey_DisplayImmediately, kCFBooleanTrue);
                        }
                        if (@available(iOS 18.0, *)) {
                            AVSampleBufferVideoRenderer *renderer = display.sampleBufferRenderer;
                            if (renderer.status == AVQueuedSampleBufferRenderingStatusFailed) [renderer flush];
                            if (renderer.readyForMoreMediaData) [renderer enqueueSampleBuffer:previewSample];
                        } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
                            if (display.status == AVQueuedSampleBufferRenderingStatusFailed) [display flush];
                            if (display.readyForMoreMediaData) [display enqueueSampleBuffer:previewSample];
#pragma clang diagnostic pop
                        }
                        if (@available(iOS 17.4, *)) {
                            [self->_lock lock];
                            self->_displayed = display.readyForDisplay;
                            [self->_lock unlock];
                        }
                        CFRelease(previewSample);
                    }
                    CFRelease(format);
                }
                CVPixelBufferRelease(pixel);
            }
        });
    }
}

- (void)captureOutput:(AVCaptureOutput *)output
didOutputMetadataObjects:(NSArray<__kindof AVMetadataObject *> *)metadataObjects
       fromConnection:(AVCaptureConnection *)connection {
    (void)output;
    (void)connection;
    @autoreleasepool {
        [_lock lock];
        if (_closed) {
            [_lock unlock];
            return;
        }
        int32_t frameW = _width;
        int32_t frameH = _height;
        [_lock unlock];

        int64_t nowMs = (int64_t)llround(NSDate.date.timeIntervalSince1970 * 1000.0);
        AVCaptureVideoDataOutput *videoOutput = _output;
        AVCaptureConnection *videoConn = videoOutput ? [videoOutput connectionWithMediaType:AVMediaTypeVideo] : nil;

        LCDetectedFace candidates[16];
        int32_t count = 0;

        for (AVMetadataObject *obj in metadataObjects) {
            if (![obj isKindOfClass:AVMetadataFaceObject.class]) continue;
            AVMetadataFaceObject *face = (AVMetadataFaceObject *)obj;
            AVMetadataObject *transformed = (videoOutput && videoConn)
                ? [videoOutput transformedMetadataObjectForMetadataObject:face connection:videoConn]
                : nil;
            CGFloat cx = 0.5;
            CGFloat cy = 0.5;
            CGFloat nw = 0.0;
            CGFloat nh = 0.0;
            if (transformed) {
                CGRect r = transformed.bounds;
                if (frameW > 1 && frameH > 1 &&
                    (r.size.width > 1.5 || r.size.height > 1.5 || r.origin.x > 1.05 || r.origin.y > 1.05)) {
                    cx = CGRectGetMidX(r) / (CGFloat)frameW;
                    cy = CGRectGetMidY(r) / (CGFloat)frameH;
                    nw = r.size.width / (CGFloat)frameW;
                    nh = r.size.height / (CGFloat)frameH;
                } else {
                    cx = CGRectGetMidX(r);
                    cy = CGRectGetMidY(r);
                    nw = r.size.width;
                    nh = r.size.height;
                }
            } else {
                CGRect r = face.bounds;
                cx = CGRectGetMidX(r);
                cy = CGRectGetMidY(r);
                nw = r.size.width;
                nh = r.size.height;
                if (videoConn && videoConn.isVideoMirrored) {
                    cx = 1.0 - cx;
                }
            }
            if (nw <= 0.0 || nh <= 0.0) continue;
            LCDetectedFace item;
            item.track_id = (int32_t)MAX(1, face.faceID);
            item.offset_x = (float)MAX(-1.0, MIN(1.0, cx * 2.0 - 1.0));
            item.offset_y = (float)MAX(-1.0, MIN(1.0, cy * 2.0 - 1.0));
            item.width = (float)MAX(0.0, MIN(1.0, nw));
            item.height = (float)MAX(0.0, MIN(1.0, nh));
            item.confidence = 0.95f;
            candidates[count++] = item;
            if (count >= 16) break;
        }

        // Sort descending by bounding-box area so primary/closest faces come first
        for (int32_t i = 0; i < count; i++) {
            for (int32_t j = i + 1; j < count; j++) {
                float areaI = candidates[i].width * candidates[i].height;
                float areaJ = candidates[j].width * candidates[j].height;
                if (areaJ > areaI) {
                    LCDetectedFace tmp = candidates[i];
                    candidates[i] = candidates[j];
                    candidates[j] = tmp;
                }
            }
        }

        int32_t kept = MIN(8, count);
        [_lock lock];
        if (!_closed) {
            _faceCount = kept;
            _facesUpdatedAtMs = nowMs;
            if (kept > 0) {
                memcpy(_faces, candidates, (size_t)kept * sizeof(LCDetectedFace));
            }
        }
        [_lock unlock];
    }
}

- (void)close {
    [_lock lock];
    if (_closed) {
        [_lock unlock];
        return;
    }
    _closed = YES;
    AVSampleBufferDisplayLayer *display = _display;
    _display = nil;
    [_lock unlock];

    if (display) {
        dispatch_async(dispatch_get_main_queue(), ^{
            LCFlushDisplayLayer(display, YES);
        });
    }

    dispatch_async(_sessionQueue, ^{
        @autoreleasepool {
            if (self->_runtimeErrorObserver) {
                [NSNotificationCenter.defaultCenter removeObserver:self->_runtimeErrorObserver];
                self->_runtimeErrorObserver = nil;
            }
            if (self->_orientationObserver) {
                [NSNotificationCenter.defaultCenter removeObserver:self->_orientationObserver];
                self->_orientationObserver = nil;
            }
            if (self->_activeSceneObserver) {
                [NSNotificationCenter.defaultCenter removeObserver:self->_activeSceneObserver];
                self->_activeSceneObserver = nil;
            }
            self->_rotationCoordinator = nil;
            if (self->_output) {
                [self->_output setSampleBufferDelegate:nil queue:NULL];
            }
            if (self->_metadataOutput) {
                [self->_metadataOutput setMetadataObjectsDelegate:nil queue:NULL];
            }
            if (self->_session) {
                if (self->_session.running) {
                    [self->_session stopRunning];
                }
                if (self->_input) [self->_session removeInput:self->_input];
                if (self->_output) [self->_session removeOutput:self->_output];
                if (self->_metadataOutput) [self->_session removeOutput:self->_metadataOutput];
                self->_session = nil;
            }
            self->_input = nil;
            self->_output = nil;
            self->_metadataOutput = nil;
            self->_device = nil;
            [self->_lock lock];
            self->_faceCount = 0;
            if (self->_latest) {
                CVPixelBufferRelease(self->_latest);
                self->_latest = NULL;
            }
            [self->_lock unlock];
        }
    });
}

- (void)dealloc {
    if (_runtimeErrorObserver) {
        [NSNotificationCenter.defaultCenter removeObserver:_runtimeErrorObserver];
    }
    if (_orientationObserver) {
        [NSNotificationCenter.defaultCenter removeObserver:_orientationObserver];
    }
    if (_activeSceneObserver) {
        [NSNotificationCenter.defaultCenter removeObserver:_activeSceneObserver];
    }
    if (_latest) {
        CVPixelBufferRelease(_latest);
    }
}

@end

@interface LCDeviceCameraView : UIView {
@public
    _Atomic(uint64_t) _sampleEpoch;
}
@property(nonatomic, strong) LCDeviceCameraSession *session;
@end

@implementation LCDeviceCameraView
+ (Class)layerClass { return AVSampleBufferDisplayLayer.class; }
- (instancetype)init {
    if ((self = [super initWithFrame:CGRectZero])) {
        self.backgroundColor = UIColor.blackColor;
        ((AVSampleBufferDisplayLayer *)self.layer).videoGravity = AVLayerVideoGravityResizeAspectFill;
    }
    return self;
}
- (void)setSession:(LCDeviceCameraSession *)session {
    if (_session == session) return;
    if (_session) {
        [_session->_lock lock];
        if (_session->_display == self.layer) _session->_display = nil;
        [_session->_lock unlock];
    }
    LCFlushDisplayLayer((AVSampleBufferDisplayLayer *)self.layer, YES);
    _session = session;
    if (session) {
        [session->_lock lock];
        session->_display = (AVSampleBufferDisplayLayer *)self.layer;
        session->_displayed = NO;
        [session->_lock unlock];
    }
}
- (void)dealloc {
    if (_session) {
        [_session->_lock lock];
        if (_session->_display == self.layer) _session->_display = nil;
        [_session->_lock unlock];
    }
}
@end

static void LCEnsureLifecycleObserver(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        [NSNotificationCenter.defaultCenter
            addObserverForName:UIApplicationDidEnterBackgroundNotification
                        object:nil
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(NSNotification *note) {
                        (void)note;
                        looi_device_camera_background();
                    }];
        [NSNotificationCenter.defaultCenter
            addObserverForName:UIApplicationWillEnterForegroundNotification
                        object:nil
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(NSNotification *note) {
                        (void)note;
                        looi_device_camera_foreground();
                    }];
    });
}

int32_t looi_device_camera_permission(void) {
    @autoreleasepool {
        LCEnsureLifecycleObserver();
        AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
        if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted) {
            return 2; // denied
        }
        if ([AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo] == nil) {
            return 3; // unavailable (e.g. simulator without camera hardware)
        }
        if (status == AVAuthorizationStatusAuthorized) {
            return 1; // granted
        }
        return 0; // undetermined
    }
}

int32_t looi_device_camera_request_permission(void) {
    @autoreleasepool {
        int32_t current = looi_device_camera_permission();
        if (current != 0) return current;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block BOOL grantedResult = NO;
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
            grantedResult = granted;
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
        return grantedResult ? 1 : 2;
    }
}

void *looi_device_camera_create(int32_t facing, int32_t max_dimension, int32_t max_fps, char **error_out) {
    @autoreleasepool {
        LCEnsureLifecycleObserver();
        LCDeviceCameraSession *session = [LCDeviceCameraSession new];
        NSString *error = nil;
        if (![session configureWithFacing:facing maxDimension:max_dimension maxFps:max_fps error:&error]) {
            if (error_out) *error_out = LCDupError(error);
            return NULL;
        }
        return (__bridge_retained void *)session;
    }
}

void looi_device_camera_reconfigure(void *handle, int32_t max_dimension, int32_t max_fps) {
    if (!handle) return;
    @autoreleasepool {
        LCDeviceCameraSession *session = (__bridge LCDeviceCameraSession *)handle;
        [session reconfigureMaxDimension:max_dimension maxFps:max_fps];
    }
}

void looi_device_camera_close(void *handle) {
    if (!handle) return;
    @autoreleasepool {
        LCDeviceCameraSession *session = (__bridge LCDeviceCameraSession *)handle;
        [session close];
    }
}

void looi_device_camera_release(void *handle) {
    if (!handle) return;
    @autoreleasepool {
        LCDeviceCameraSession *session = CFBridgingRelease(handle);
        [session close];
    }
}

void looi_device_camera_status(void *handle, uint64_t *frames, int32_t *width, int32_t *height,
                               int64_t *captured_at_ms, int32_t *error, int32_t *displayed,
                               char **failure_out) {
    if (!handle) return;
    @autoreleasepool {
        LCDeviceCameraSession *session = (__bridge LCDeviceCameraSession *)handle;
        [session->_lock lock];
        *frames = session->_frames;
        *width = session->_width;
        *height = session->_height;
        *captured_at_ms = session->_capturedAtMs;
        *error = session->_error;
        if (@available(iOS 17.4, *)) {
            *displayed = session->_displayed ? 1 : 0;
        } else {
            *displayed = -1;
        }
        if (failure_out) {
            *failure_out = session->_failureMessage ? LCDupError(session->_failureMessage) : NULL;
        }
        [session->_lock unlock];
    }
}

uint8_t *looi_device_camera_jpeg(void *handle, int32_t max_dimension, size_t *length,
                                 int32_t *width, int32_t *height, int64_t *captured_at_ms,
                                 uint64_t *seq) {
    if (!handle) return NULL;
    @autoreleasepool {
        LCDeviceCameraSession *session = (__bridge LCDeviceCameraSession *)handle;
        [session->_lock lock];
        CVPixelBufferRef pixel = session->_closed ? NULL : session->_latest;
        *captured_at_ms = session->_capturedAtMs;
        *seq = session->_frames;
        int32_t fallbackMaxDim = session->_maxDimension;
        if (pixel) CVPixelBufferRetain(pixel);
        [session->_lock unlock];

        if (!pixel) return NULL;
        CGImageRef image = NULL;
        OSStatus status = VTCreateCGImageFromCVPixelBuffer(pixel, NULL, &image);
        CVPixelBufferRelease(pixel);
        if (status != noErr || !image) return NULL;

        int32_t reqDim = max_dimension > 0 ? max_dimension : fallbackMaxDim;
        size_t sourceMax = MAX(CGImageGetWidth(image), CGImageGetHeight(image));
        size_t targetMax = MIN((size_t)MAX(160, MIN(1920, reqDim)), sourceMax);

        NSMutableData *data = [NSMutableData data];
        CGImageDestinationRef dest = CGImageDestinationCreateWithData(
            (__bridge CFMutableDataRef)data, CFSTR("public.jpeg"), 1, NULL);
        if (!dest) {
            CGImageRelease(image);
            return NULL;
        }
        CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)@{
            (id)kCGImageDestinationLossyCompressionQuality : @0.78,
            (id)kCGImageDestinationImageMaxPixelSize : @(targetMax),
        });
        BOOL ok = CGImageDestinationFinalize(dest);
        CFRelease(dest);
        CGImageRelease(image);
        if (!ok || data.length == 0) return NULL;

        CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
        if (!source) return NULL;
        NSDictionary *props = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
        CFRelease(source);
        *length = data.length;
        *width = [props[(id)kCGImagePropertyPixelWidth] intValue];
        *height = [props[(id)kCGImagePropertyPixelHeight] intValue];
        uint8_t *out = (uint8_t *)malloc(*length);
        if (out) memcpy(out, data.bytes, *length);
        return out;
    }
}

void looi_device_camera_bytes_free(void *bytes) {
    free(bytes);
}

int32_t looi_device_camera_faces(void *handle, LCDetectedFace *out_faces, int32_t max_faces) {
    if (!handle || !out_faces || max_faces <= 0) return 0;
    @autoreleasepool {
        int64_t nowMs = (int64_t)llround(NSDate.date.timeIntervalSince1970 * 1000.0);
        LCDeviceCameraSession *session = (__bridge LCDeviceCameraSession *)handle;
        [session->_lock lock];
        if (session->_closed || session->_faceCount <= 0 ||
            (session->_facesUpdatedAtMs > 0 && (nowMs - session->_facesUpdatedAtMs) > 1500)) {
            [session->_lock unlock];
            return 0;
        }
        int32_t count = MIN(session->_faceCount, MIN(8, max_faces));
        memcpy(out_faces, session->_faces, (size_t)count * sizeof(LCDetectedFace));
        [session->_lock unlock];
        return count;
    }
}

void *looi_device_camera_view_create(void) {
    @autoreleasepool {
        return (__bridge_retained void *)[LCDeviceCameraView new];
    }
}

void looi_device_camera_view_bind(void *view, void *handle) {
    if (!view) return;
    @autoreleasepool {
        LCDeviceCameraView *surface = (__bridge LCDeviceCameraView *)view;
        LCDeviceCameraSession *target = handle ? (__bridge LCDeviceCameraSession *)handle : nil;
        atomic_fetch_add_explicit(&surface->_sampleEpoch, 1, memory_order_acq_rel);
        dispatch_block_t apply = ^{
            surface.session = target;
            if (!target) {
                LCFlushDisplayLayer((AVSampleBufferDisplayLayer *)surface.layer, YES);
            }
        };
        if (NSThread.isMainThread) {
            apply();
        } else {
            dispatch_async(dispatch_get_main_queue(), apply);
        }
    }
}

void looi_device_camera_view_present_sample(
    void *view,
    int32_t facing,
    uint64_t seq,
    float offset_x,
    float offset_y,
    float face_w,
    float face_h
) {
    if (!view) return;
    @autoreleasepool {
        LCDeviceCameraView *surface = (__bridge LCDeviceCameraView *)view;
        uint64_t expectedEpoch = atomic_load_explicit(&surface->_sampleEpoch, memory_order_acquire);
        dispatch_async(dispatch_get_main_queue(), ^{
            @autoreleasepool {
                AVSampleBufferDisplayLayer *display = (AVSampleBufferDisplayLayer *)surface.layer;
                if (!display || surface.session != nil) return;
                if (atomic_load_explicit(&surface->_sampleEpoch, memory_order_acquire) != expectedEpoch) {
                    return;
                }

                const size_t w = 320;
                const size_t h = 180;
                NSDictionary *attrs = @{
                    (id)kCVPixelBufferCGImageCompatibilityKey : @YES,
                    (id)kCVPixelBufferCGBitmapContextCompatibilityKey : @YES,
                    (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
                };
                CVPixelBufferRef pixel = NULL;
                if (CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)attrs, &pixel) != kCVReturnSuccess || !pixel) {
                    return;
                }

                if (CVPixelBufferLockBaseAddress(pixel, 0) == kCVReturnSuccess) {
                    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
                    CGContextRef cg = CGBitmapContextCreate(
                        CVPixelBufferGetBaseAddress(pixel),
                        w,
                        h,
                        8,
                        CVPixelBufferGetBytesPerRow(pixel),
                        cs,
                        kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst
                    );
                    if (cg) {
                        // Flip Y so normalized offset_y < 0 maps cleanly to the top of the frame.
                        CGContextTranslateCTM(cg, 0.0, (CGFloat)h);
                        CGContextScaleCTM(cg, 1.0, -1.0);

                        // Dark studio background + subtle grid lines.
                        CGContextSetRGBFillColor(cg, 0.08, 0.10, 0.14, 1.0);
                        CGContextFillRect(cg, CGRectMake(0, 0, w, h));

                        CGContextSetRGBStrokeColor(cg, 1.0, 1.0, 1.0, 0.09);
                        CGContextSetLineWidth(cg, 1.0);
                        for (size_t gx = 40; gx < w; gx += 40) {
                            CGContextMoveToPoint(cg, (CGFloat)gx, 0.0);
                            CGContextAddLineToPoint(cg, (CGFloat)gx, (CGFloat)h);
                        }
                        for (size_t gy = 30; gy < h; gy += 30) {
                            CGContextMoveToPoint(cg, 0.0, (CGFloat)gy);
                            CGContextAddLineToPoint(cg, (CGFloat)w, (CGFloat)gy);
                        }
                        CGContextStrokePath(cg);

                        if (facing == 0 && face_w > 0.0f && face_h > 0.0f) {
                            CGFloat cx = ((CGFloat)offset_x + 1.0) * 0.5 * (CGFloat)w;
                            CGFloat cy = ((CGFloat)offset_y + 1.0) * 0.5 * (CGFloat)h;
                            CGFloat fw = MAX(28.0, (CGFloat)face_w * (CGFloat)w);
                            CGFloat fh = MAX(32.0, (CGFloat)face_h * (CGFloat)h);

                            // Soft halo behind the subject.
                            CGContextSetRGBFillColor(cg, 0.22, 0.34, 0.48, 0.28);
                            CGContextFillEllipseInRect(cg, CGRectMake(cx - fw * 1.1, cy - fh * 0.9, fw * 2.2, fh * 2.1));

                            // Shoulders & neck.
                            CGContextSetRGBFillColor(cg, 0.27, 0.36, 0.49, 1.0);
                            CGContextFillEllipseInRect(cg, CGRectMake(cx - fw * 0.95, cy + fh * 0.42, fw * 1.9, fh * 1.25));
                            CGContextSetRGBFillColor(cg, 0.85, 0.71, 0.61, 1.0);
                            CGContextFillRect(cg, CGRectMake(cx - fw * 0.14, cy + fh * 0.26, fw * 0.28, fh * 0.24));

                            // Head.
                            CGRect headRect = CGRectMake(cx - fw * 0.40, cy - fh * 0.48, fw * 0.80, fh * 0.88);
                            CGContextSetRGBFillColor(cg, 0.93, 0.80, 0.69, 1.0);
                            CGContextFillEllipseInRect(cg, headRect);

                            // Hair crown.
                            CGContextSetRGBFillColor(cg, 0.16, 0.19, 0.26, 1.0);
                            CGContextFillEllipseInRect(cg, CGRectMake(cx - fw * 0.41, cy - fh * 0.52, fw * 0.82, fh * 0.34));

                            // Eyes (periodic quick blink on simulator stream).
                            BOOL blinking = (seq % 28) == 0;
                            CGFloat eyeH = blinking ? 1.5 : 4.5;
                            CGFloat eyeY = cy - fh * 0.08 - eyeH * 0.5;
                            CGContextSetRGBFillColor(cg, 0.14, 0.16, 0.20, 1.0);
                            CGContextFillEllipseInRect(cg, CGRectMake(cx - fw * 0.18 - 2.5, eyeY, 5.0, eyeH));
                            CGContextFillEllipseInRect(cg, CGRectMake(cx + fw * 0.18 - 2.5, eyeY, 5.0, eyeH));

                            // Smile arc.
                            CGContextSetRGBStrokeColor(cg, 0.58, 0.36, 0.32, 1.0);
                            CGContextSetLineWidth(cg, 1.8);
                            CGContextAddArc(cg, cx, cy + fh * 0.10, fw * 0.14, 0.25, M_PI - 0.25, 0);
                            CGContextStrokePath(cg);
                        } else {
                            // Back camera moving calibration stripe.
                            CGFloat barX = fmod((CGFloat)(seq * 18), (CGFloat)w);
                            CGContextSetRGBFillColor(cg, 0.28, 0.52, 0.72, 0.45);
                            CGContextFillRect(cg, CGRectMake(barX, 0, 28, h));
                        }
                        CGContextRelease(cg);
                    }
                    CGColorSpaceRelease(cs);
                    CVPixelBufferUnlockBaseAddress(pixel, 0);
                }

                CMVideoFormatDescriptionRef format = NULL;
                CMSampleBufferRef previewSample = NULL;
                if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixel, &format) == noErr) {
                    CMSampleTimingInfo timing = {
                        CMTimeMake(1, 15),
                        CMTimeMake((int64_t)(seq + 1), 15),
                        kCMTimeInvalid
                    };
                    if (CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pixel, format, &timing, &previewSample) == noErr) {
                        CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(previewSample, YES);
                        if (attachments && CFArrayGetCount(attachments) > 0) {
                            CFMutableDictionaryRef sampleAttrs = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
                            CFDictionarySetValue(sampleAttrs, kCMSampleAttachmentKey_DisplayImmediately, kCFBooleanTrue);
                        }
                        if (@available(iOS 18.0, *)) {
                            AVSampleBufferVideoRenderer *renderer = display.sampleBufferRenderer;
                            if (renderer.status == AVQueuedSampleBufferRenderingStatusFailed) [renderer flush];
                            if (renderer.readyForMoreMediaData) [renderer enqueueSampleBuffer:previewSample];
                        } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
                            if (display.status == AVQueuedSampleBufferRenderingStatusFailed) [display flush];
                            if (display.readyForMoreMediaData) [display enqueueSampleBuffer:previewSample];
#pragma clang diagnostic pop
                        }
                        CFRelease(previewSample);
                    }
                    CFRelease(format);
                }
                CVPixelBufferRelease(pixel);
            }
        });
    }
}

void looi_device_camera_view_release(void *view) {
    if (!view) return;
    LCDeviceCameraView *unretained = (__bridge LCDeviceCameraView *)view;
    atomic_fetch_add_explicit(&unretained->_sampleEpoch, 1, memory_order_acq_rel);
    if (NSThread.isMainThread) {
        @autoreleasepool {
            LCDeviceCameraView *surface = CFBridgingRelease(view);
            surface.session = nil;
        }
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{
            @autoreleasepool {
                LCDeviceCameraView *surface = CFBridgingRelease(view);
                surface.session = nil;
            }
        });
    }
}
