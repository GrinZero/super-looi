#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <VideoToolbox/VideoToolbox.h>
#import <CoreMedia/CoreMedia.h>
#import <ImageIO/ImageIO.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// One decoded pixel buffer serves both optional preview and on-demand JPEG.
@interface LCCameraMedia : NSObject {
@public
    dispatch_queue_t _queue;
    NSLock *_lock;
    VTDecompressionSessionRef _decoder;
    CMVideoFormatDescriptionRef _format;
    CVPixelBufferRef _latest;
    NSMutableDictionary<NSNumber *, NSData *> *_parameters;
    uint64_t _frames;
    int64_t _lastPts, _receivedAt;
    int32_t _width, _height, _error;
    BOOL _closed, _displayScheduled, _displayed;
    __weak AVSampleBufferDisplayLayer *_display;
}
- (void)close;
@end

static NSArray<NSData *> *LCNals(const uint8_t *bytes, size_t length) {
    NSMutableArray *out = [NSMutableArray array];
    size_t start = SIZE_MAX, i = 0;
    while (i + 3 <= length) {
        size_t prefix = i + 4 <= length && memcmp(bytes+i,"\0\0\0\1",4)==0 ? 4
            : memcmp(bytes+i,"\0\0\1",3)==0 ? 3 : 0;
        if (!prefix) { i++; continue; }
        if (start != SIZE_MAX && i > start) [out addObject:[NSData dataWithBytes:bytes+start length:i-start]];
        start = i + prefix; i += prefix;
    }
    if (start != SIZE_MAX && length > start) [out addObject:[NSData dataWithBytes:bytes+start length:length-start]];
    return out;
}

static void LCDecoded(void *context, void *source, OSStatus status, VTDecodeInfoFlags flags,
                      CVImageBufferRef image, CMTime pts, CMTime duration) {
    (void)flags; (void)duration;
    LCCameraMedia *self = (__bridge LCCameraMedia *)context;
    [self->_lock lock];
    if (status != noErr) self->_error = status;
    if (!image || self->_closed) { [self->_lock unlock]; return; }
    CVPixelBufferRetain(image);
    if (self->_latest) CVPixelBufferRelease(self->_latest);
    self->_latest = image;
    self->_width = (int32_t)CVPixelBufferGetWidth(image);
    self->_height = (int32_t)CVPixelBufferGetHeight(image);
    self->_frames++;
    self->_receivedAt=(int64_t)(uintptr_t)source;
    self->_lastPts = CMTIME_IS_NUMERIC(pts) ? (int64_t)(CMTimeGetSeconds(pts)*1000) : 0;
    BOOL schedule = self->_display && !self->_displayScheduled;
    if (schedule) self->_displayScheduled=YES;
    [self->_lock unlock];
    if (!schedule) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        [self->_lock lock];
        self->_displayScheduled=NO;
        AVSampleBufferDisplayLayer *display=self->_display;
        CVPixelBufferRef pixel=!self->_closed && display ? self->_latest : NULL;
        if (pixel) CVPixelBufferRetain(pixel);
        [self->_lock unlock];
        if (!pixel) return;
        CMVideoFormatDescriptionRef format=NULL; CMSampleBufferRef sample=NULL;
        if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault,pixel,&format)==noErr) {
            CMSampleTimingInfo timing={kCMTimeInvalid,kCMTimeZero,kCMTimeInvalid};
            if (CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault,pixel,format,&timing,&sample)==noErr) {
                CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(sample,YES);
                if (attachments && CFArrayGetCount(attachments)) {
                    CFMutableDictionaryRef attributes=(CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments,0);
                    CFDictionarySetValue(attributes,kCMSampleAttachmentKey_DisplayImmediately,kCFBooleanTrue);
                }
                if (display.status==AVQueuedSampleBufferRenderingStatusFailed) [display flush];
                if (display.readyForMoreMediaData) [display enqueueSampleBuffer:sample];
                if (@available(iOS 17.4,*)) {
                    [self->_lock lock]; self->_displayed=display.readyForDisplay; [self->_lock unlock];
                }
                CFRelease(sample);
            }
            CFRelease(format);
        }
        CVPixelBufferRelease(pixel);
    });
}

@implementation LCCameraMedia
- (instancetype)init {
    if ((self=[super init])) {
        _queue=dispatch_queue_create("com.superlooi.camera.decode",DISPATCH_QUEUE_SERIAL);
        _lock=[NSLock new]; _parameters=[NSMutableDictionary new];
    }
    return self;
}
- (void)close {
    [_lock lock]; if (_closed) { [_lock unlock]; return; } _closed=YES;
    AVSampleBufferDisplayLayer *display=_display; _display=nil; [_lock unlock];
    if (display) dispatch_async(dispatch_get_main_queue(), ^{ [display flushAndRemoveImage]; });
    // The queue owns teardown; neither the engine nor the UI waits on a decoder.
    dispatch_async(_queue, ^{
        if (self->_decoder) {
            VTDecompressionSessionWaitForAsynchronousFrames(self->_decoder);
            VTDecompressionSessionInvalidate(self->_decoder); CFRelease(self->_decoder); self->_decoder=NULL;
        }
        if (self->_format) { CFRelease(self->_format); self->_format=NULL; }
        [self->_lock lock];
        if (self->_latest) { CVPixelBufferRelease(self->_latest); self->_latest=NULL; }
        [self->_lock unlock];
    });
}
- (void)dealloc {
    if (_decoder) { VTDecompressionSessionInvalidate(_decoder); CFRelease(_decoder); }
    if (_format) CFRelease(_format);
    if (_latest) CVPixelBufferRelease(_latest);
}
@end

@interface LCCameraView : UIView
@property(nonatomic,strong) LCCameraMedia *media;
@end
@implementation LCCameraView
+ (Class)layerClass { return AVSampleBufferDisplayLayer.class; }
- (instancetype)init {
    if ((self=[super initWithFrame:CGRectZero])) {
        self.backgroundColor=UIColor.blackColor;
        ((AVSampleBufferDisplayLayer *)self.layer).videoGravity=AVLayerVideoGravityResizeAspect;
    }
    return self;
}
- (void)setMedia:(LCCameraMedia *)media {
    if (_media == media) return;
    if (_media) { [_media->_lock lock]; if (_media->_display == self.layer) _media->_display=nil; [_media->_lock unlock]; }
    [(AVSampleBufferDisplayLayer *)self.layer flushAndRemoveImage];
    _media=media;
    if (media) { [media->_lock lock]; media->_display=(AVSampleBufferDisplayLayer *)self.layer; media->_displayed=NO; [media->_lock unlock]; }
}
- (void)dealloc {
    if (_media) { [_media->_lock lock]; if (_media->_display==self.layer) _media->_display=nil; [_media->_lock unlock]; }
}
@end

extern void looi_camera_background(void);
extern void looi_camera_foreground(void);
void *looi_camera_media_create(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note; looi_camera_background();
        }];
        [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationWillEnterForegroundNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note; looi_camera_foreground();
        }];
    });
    return (__bridge_retained void *)[LCCameraMedia new];
}
void looi_camera_media_close(void *handle) { [(__bridge LCCameraMedia *)handle close]; }
void looi_camera_media_release(void *handle) {
    if (!handle) return; LCCameraMedia *media=CFBridgingRelease(handle); [media close];
}
void *looi_camera_view_create(void) { return (__bridge_retained void *)[LCCameraView new]; }
void looi_camera_view_bind(void *view, void *handle) {
    LCCameraView *surface=(__bridge LCCameraView *)view;
    surface.media=handle ? (__bridge LCCameraMedia *)handle : nil;
}
void looi_camera_view_release(void *view) {
    if (view) { LCCameraView *surface=CFBridgingRelease(view); surface.media=nil; }
}

int32_t looi_camera_media_feed(void *handle, uint32_t codec, const uint8_t *bytes, size_t length, int64_t timestamp) {
    LCCameraMedia *self=(__bridge LCCameraMedia *)handle;
    NSArray<NSData *> *units=LCNals(bytes,length);
    __block OSStatus error=noErr;
    dispatch_sync(self->_queue, ^{
        [self->_lock lock]; BOOL closed=self->_closed; [self->_lock unlock]; if (closed) return;
        BOOL changed=NO; BOOL vcl=NO;
        for (NSData *unit in units) {
            uint8_t type=codec==5 ? (((const uint8_t *)unit.bytes)[0]>>1)&63 : ((const uint8_t *)unit.bytes)[0]&31;
            BOOL parameter=codec==5 ? type>=32 && type<=34 : type==7 || type==8;
            if (parameter && ![self->_parameters[@(type)] isEqual:unit]) { self->_parameters[@(type)]=unit; changed=YES; }
            vcl |= codec==5 ? type<=31 : (type==1 || type==5);
        }
        NSArray<NSNumber *> *types=codec==5 ? @[@32,@33,@34] : @[@7,@8];
        for (NSNumber *type in types) if (!self->_parameters[type]) return;
        if (changed || !self->_decoder) {
            if (self->_decoder) {
                VTDecompressionSessionWaitForAsynchronousFrames(self->_decoder);
                VTDecompressionSessionInvalidate(self->_decoder); CFRelease(self->_decoder); self->_decoder=NULL;
            }
            if (self->_format) { CFRelease(self->_format); self->_format=NULL; }
            const uint8_t *sets[3]; size_t sizes[3];
            for (NSUInteger i=0;i<types.count;i++) { NSData *set=self->_parameters[types[i]]; sets[i]=set.bytes; sizes[i]=set.length; }
            error=codec==5 ? CMVideoFormatDescriptionCreateFromHEVCParameterSets(kCFAllocatorDefault,types.count,sets,sizes,4,NULL,&self->_format)
                : CMVideoFormatDescriptionCreateFromH264ParameterSets(kCFAllocatorDefault,types.count,sets,sizes,4,&self->_format);
            if (error) return;
            VTDecompressionOutputCallbackRecord callback={LCDecoded,(__bridge void *)self};
            NSDictionary *attrs=@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA),
                (id)kCVPixelBufferCGImageCompatibilityKey:@YES,(id)kCVPixelBufferIOSurfacePropertiesKey:@{}};
            NSDictionary *spec=nil;
            if (@available(iOS 17.0,*)) spec=@{(id)kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder:@YES};
            error=VTDecompressionSessionCreate(kCFAllocatorDefault,self->_format,(__bridge CFDictionaryRef)spec,(__bridge CFDictionaryRef)attrs,&callback,&self->_decoder);
            if (error) return;
            VTSessionSetProperty(self->_decoder,kVTDecompressionPropertyKey_RealTime,kCFBooleanTrue);
        }
        if (!vcl) return;
        NSMutableData *payload=[NSMutableData data];
        for (NSData *unit in units) { uint32_t size=CFSwapInt32HostToBig((uint32_t)unit.length); [payload appendBytes:&size length:4]; [payload appendData:unit]; }
        CMBlockBufferRef block=NULL; CMSampleBufferRef sample=NULL;
        error=CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault,NULL,payload.length,kCFAllocatorDefault,NULL,0,payload.length,0,&block);
        if (error) return;
        error=CMBlockBufferReplaceDataBytes(payload.bytes,block,0,payload.length);
        if (!error) {
            CMSampleTimingInfo timing={kCMTimeInvalid,CMTimeMake(timestamp,1000),kCMTimeInvalid}; size_t size=payload.length;
            error=CMSampleBufferCreateReady(kCFAllocatorDefault,block,self->_format,1,1,&timing,1,&size,&sample);
            if (!error) {
                uintptr_t receivedAt=(uintptr_t)(NSDate.date.timeIntervalSince1970*1000);
                error=VTDecompressionSessionDecodeFrame(self->_decoder,sample,kVTDecodeFrame_EnableAsynchronousDecompression,(void *)receivedAt,NULL);
            }
        }
        if (sample) CFRelease(sample); CFRelease(block);
    });
    if (error) { [self->_lock lock]; self->_error=error; [self->_lock unlock]; }
    return error;
}

void looi_camera_media_status(void *handle, uint64_t *frames, int32_t *width, int32_t *height, int64_t *pts, int32_t *error, int32_t *displayed) {
    LCCameraMedia *self=(__bridge LCCameraMedia *)handle;
    [self->_lock lock]; *frames=self->_frames; *width=self->_width; *height=self->_height; *pts=self->_lastPts; *error=self->_error;
    if (@available(iOS 17.4,*)) *displayed=self->_displayed ? 1 : 0; else *displayed=-1;
    [self->_lock unlock];
}
uint8_t *looi_camera_media_jpeg(void *handle, size_t *length, int32_t *width, int32_t *height, int64_t *receivedAt) {
    LCCameraMedia *self=(__bridge LCCameraMedia *)handle;
    [self->_lock lock]; CVPixelBufferRef pixel=self->_closed ? NULL : self->_latest; *receivedAt=self->_receivedAt;
    if (pixel) CVPixelBufferRetain(pixel); [self->_lock unlock];
    if (!pixel) return NULL;
    CGImageRef image=NULL;
    OSStatus error=VTCreateCGImageFromCVPixelBuffer(pixel,NULL,&image);
    CVPixelBufferRelease(pixel);
    if (error || !image) return NULL;
    size_t maxPixel=MIN(1024,MAX(CGImageGetWidth(image),CGImageGetHeight(image)));
    NSMutableData *data=[NSMutableData data];
    CGImageDestinationRef destination=CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data,CFSTR("public.jpeg"),1,NULL);
    if (!destination) { CGImageRelease(image); return NULL; }
    CGImageDestinationAddImage(destination,image,(__bridge CFDictionaryRef)@{(id)kCGImageDestinationLossyCompressionQuality:@0.8,(id)kCGImageDestinationImageMaxPixelSize:@(maxPixel)});
    BOOL ok=CGImageDestinationFinalize(destination); CFRelease(destination); CGImageRelease(image);
    if (!ok) return NULL;
    CGImageSourceRef source=CGImageSourceCreateWithData((__bridge CFDataRef)data,NULL);
    NSDictionary *properties=CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source,0,NULL)); CFRelease(source);
    *length=data.length; *width=[properties[(id)kCGImagePropertyPixelWidth] intValue]; *height=[properties[(id)kCGImagePropertyPixelHeight] intValue];
    uint8_t *out=malloc(*length); if (out) memcpy(out,data.bytes,*length); return out;
}
void looi_camera_bytes_free(void *bytes) { free(bytes); }
