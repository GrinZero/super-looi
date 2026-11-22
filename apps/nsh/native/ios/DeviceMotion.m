#import <CoreMotion/CoreMotion.h>
#import <Foundation/Foundation.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef void (*LooiDeviceMotionSampleCallback)(
    void *ctx,
    double qx,
    double qy,
    double qz,
    double qw,
    double monotonic_ms,
    int32_t accuracy);

typedef void (*LooiDeviceMotionErrorCallback)(
    void *ctx,
    const char *stage,
    const char *code,
    const char *reason);

static double LDMMonotonicMs(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0) {
        return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
    }
    return [[NSProcessInfo processInfo] systemUptime] * 1000.0;
}

static char *LDMDupString(NSString *value) {
    if (!value) return NULL;
    const char *utf8 = value.UTF8String;
    if (!utf8) return NULL;
    size_t len = strlen(utf8) + 1;
    char *copy = (char *)malloc(len);
    if (copy) memcpy(copy, utf8, len);
    return copy;
}

@interface LDMDeviceMotionSession : NSObject
@property (nonatomic, strong) CMMotionManager *manager;
@property (nonatomic, strong) NSOperationQueue *queue;
@property (nonatomic, strong) id lockToken;
@property (nonatomic, assign) BOOL active;
@property (nonatomic, assign) void *ctx;
@property (nonatomic, assign) LooiDeviceMotionSampleCallback onSample;
@property (nonatomic, assign) LooiDeviceMotionErrorCallback onError;
@end

@implementation LDMDeviceMotionSession
@end

int32_t looi_device_motion_availability(void) {
    @autoreleasepool {
        CMMotionManager *mgr = [CMMotionManager new];
        BOOL ok = mgr.deviceMotionAvailable;
        if (ok) {
            CMAttitudeReferenceFrame frames = [CMMotionManager availableAttitudeReferenceFrames];
            ok = (frames & CMAttitudeReferenceFrameXArbitraryZVertical) != 0;
        }
        return ok ? 1 : 0;
    }
}

void *looi_device_motion_start(
    int32_t rate_hz,
    void *ctx,
    LooiDeviceMotionSampleCallback on_sample,
    LooiDeviceMotionErrorCallback on_error,
    char **error_out) {
    @autoreleasepool {
        CMMotionManager *mgr = [CMMotionManager new];
        if (!mgr.deviceMotionAvailable) {
            if (error_out) {
                *error_out = LDMDupString(@"ERR_DEVICE_MOTION_UNAVAILABLE: CMMotionManager deviceMotionAvailable is false");
            }
            return NULL;
        }
        CMAttitudeReferenceFrame frames = [CMMotionManager availableAttitudeReferenceFrames];
        if ((frames & CMAttitudeReferenceFrameXArbitraryZVertical) == 0) {
            if (error_out) {
                *error_out = LDMDupString(@"ERR_DEVICE_MOTION_UNAVAILABLE: CMAttitudeReferenceFrameXArbitraryZVertical unsupported");
            }
            return NULL;
        }

        int32_t clampedHz = rate_hz < 10 ? 10 : (rate_hz > 200 ? 200 : rate_hz);
        mgr.deviceMotionUpdateInterval = 1.0 / (double)clampedHz;

        NSOperationQueue *queue = [NSOperationQueue new];
        queue.maxConcurrentOperationCount = 1;
        queue.qualityOfService = NSQualityOfServiceUserInteractive;
        queue.name = @"com.superlooi.nsh.device-motion";

        LDMDeviceMotionSession *session = [LDMDeviceMotionSession new];
        session.manager = mgr;
        session.queue = queue;
        session.lockToken = [NSObject new];
        session.active = YES;
        session.ctx = ctx;
        session.onSample = on_sample;
        session.onError = on_error;

        __weak LDMDeviceMotionSession *weakSession = session;
        [mgr startDeviceMotionUpdatesUsingReferenceFrame:CMAttitudeReferenceFrameXArbitraryZVertical
                                                 toQueue:queue
                                             withHandler:^(CMDeviceMotion * _Nullable motion, NSError * _Nullable error) {
            LDMDeviceMotionSession *strong = weakSession;
            if (!strong) return;
            @synchronized(strong.lockToken) {
                if (!strong.active) return;
                if (error != nil) {
                    if (strong.onError) {
                        NSString *formatted = [NSString stringWithFormat:@"%@ (code=%ld): %@",
                            error.domain ?: @"CMErrorDomain",
                            (long)error.code,
                            error.localizedDescription ?: @"CoreMotion update failed"];
                        strong.onError(
                            strong.ctx,
                            "native.ios.motion.stream",
                            "ERR_DEVICE_MOTION_HARDWARE_FAULT",
                            formatted.UTF8String ?: "CoreMotion update failed");
                    }
                    return;
                }
                if (motion != nil && strong.onSample) {
                    CMQuaternion q = motion.attitude.quaternion;
                    double monoMs = LDMMonotonicMs();
                    strong.onSample(strong.ctx, q.x, q.y, q.z, q.w, monoMs, 3);
                }
            }
        }];
        return (__bridge_retained void *)session;
    }
}

void looi_device_motion_stop(void *handle) {
    if (!handle) return;
    @autoreleasepool {
        LDMDeviceMotionSession *session = CFBridgingRelease(handle);
        @synchronized(session.lockToken) {
            session.active = NO;
            session.onSample = NULL;
            session.onError = NULL;
            session.ctx = NULL;
        }
        [session.manager stopDeviceMotionUpdates];
        [session.queue cancelAllOperations];
    }
}

void looi_device_motion_string_free(char *ptr) {
    free(ptr);
}
