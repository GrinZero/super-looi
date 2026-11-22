#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static NSString *const kScheduleAlarmPrefix = @"looi.sched.";
static NSString *const kSchedulePostPrefix = @"looi.sched.post.";
static const NSUInteger kMaxScheduleEvents = 256;
static const NSUInteger kMaxScheduledAlarms = 32;

static NSLock *gScheduleLock = nil;
static NSMutableArray<NSDictionary *> *gEventQueue = nil;
static NSMutableDictionary<NSString *, NSNumber *> *gBgTasks = nil;
static NSMutableSet<NSString *> *gPendingBgHandles = nil;
static NSMutableSet<NSString *> *gExpiredBgHandles = nil;
static uint64_t gNextBgSeq = 1;
static int32_t gCachedPermission = 0;

static void LooiScheduleEnsureGlobals(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        gScheduleLock = [NSLock new];
        gEventQueue = [NSMutableArray new];
        gBgTasks = [NSMutableDictionary new];
        gPendingBgHandles = [NSMutableSet new];
        gExpiredBgHandles = [NSMutableSet new];
    });
}

static char *LooiScheduleDupCString(NSString *text) {
    const char *utf8 = text ? text.UTF8String : "";
    if (!utf8) utf8 = "";
    size_t len = strlen(utf8);
    char *copy = (char *)malloc(len + 1);
    if (copy) memcpy(copy, utf8, len + 1);
    return copy;
}

static NSString *LooiScheduleFormatError(NSString *code, NSError *error, NSString *fallback) {
    if (error) {
        return [NSString stringWithFormat:@"%@: code=%ld %@",
            code, (long)error.code, error.localizedDescription ?: fallback];
    }
    return [NSString stringWithFormat:@"%@: %@", code, fallback];
}

static BOOL LooiScheduleHasBundleId(void) {
    return NSBundle.mainBundle.bundleIdentifier.length > 0;
}

static void LooiScheduleEnqueueEvent(NSDictionary *event) {
    if (!event) return;
    LooiScheduleEnsureGlobals();
    [gScheduleLock lock];
    if (gEventQueue.count >= kMaxScheduleEvents) {
        [gEventQueue removeObjectAtIndex:0];
    }
    [gEventQueue addObject:event];
    [gScheduleLock unlock];
}

static NSString *LooiScheduleJsonString(NSDictionary *dict) {
    if (!dict || dict.count == 0) return @"{}";
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:dict options:0 error:&err];
    if (!data || err) return @"{}";
    NSString *str = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return str ?: @"{}";
}

static int32_t LooiScheduleMapAuthStatus(UNAuthorizationStatus status) {
    switch (status) {
        case UNAuthorizationStatusNotDetermined:
            return 0;
        case UNAuthorizationStatusDenied:
            return 2;
        case UNAuthorizationStatusAuthorized:
        case UNAuthorizationStatusProvisional:
            return 1;
        default:
            if (@available(iOS 14.0, *)) {
                if (status == UNAuthorizationStatusEphemeral) return 1;
            }
            return 0;
    }
}

@interface LooiScheduleNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, strong, nullable) id<UNUserNotificationCenterDelegate> previousDelegate;
@end

static LooiScheduleNotificationDelegate *gScheduleDelegate = nil;

@implementation LooiScheduleNotificationDelegate

+ (void)load {
    @autoreleasepool {
        [NSNotificationCenter.defaultCenter
            addObserverForName:UIApplicationDidFinishLaunchingNotification
                        object:nil
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(NSNotification *note) {
                        (void)note;
                        if (LooiScheduleHasBundleId()) {
                            extern void looi_schedule_install(void);
                            looi_schedule_install();
                        }
                    }];
    }
}

- (BOOL)isScheduleNotificationRequest:(UNNotificationRequest *)request {
    NSString *ident = request.identifier ?: @"";
    if ([ident hasPrefix:kScheduleAlarmPrefix]) {
        return YES;
    }
    NSDictionary *info = request.content.userInfo;
    return info[@"looiScheduleRuleId"] != nil;
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
    UNNotificationRequest *request = notification.request;
    if ([self isScheduleNotificationRequest:request]) {
        NSDictionary *info = request.content.userInfo ?: @{};
        NSString *source = [info[@"looiScheduleSource"] isKindOfClass:NSString.class]
            ? info[@"looiScheduleSource"]
            : @"";
        NSString *ident = request.identifier ?: @"";
        BOOL isPreSyncedAlarm = [source isEqualToString:@"alarm"]
            || ([ident hasPrefix:kScheduleAlarmPrefix] && ![ident hasPrefix:kSchedulePostPrefix]);
        if (isPreSyncedAlarm) {
            // App is active in foreground; ScheduleEngine's lookahead timer executes due rules silently.
            completionHandler(0);
            return;
        }
        UNNotificationPresentationOptions options = UNNotificationPresentationOptionBadge;
        if (@available(iOS 14.0, *)) {
            options |= UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList;
        } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            options |= UNNotificationPresentationOptionAlert;
#pragma clang diagnostic pop
        }
        if (request.content.sound != nil) {
            options |= UNNotificationPresentationOptionSound;
        }
        completionHandler(options);
        return;
    }
    id<UNUserNotificationCenterDelegate> prev = self.previousDelegate;
    if (prev && [prev respondsToSelector:@selector(userNotificationCenter:willPresentNotification:withCompletionHandler:)]) {
        [prev userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completionHandler];
        return;
    }
    completionHandler(0);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    UNNotificationRequest *request = response.notification.request;
    if ([self isScheduleNotificationRequest:request]) {
        NSString *ident = request.identifier ?: @"";
        NSDictionary *info = request.content.userInfo ?: @{};
        NSString *ruleId = [info[@"looiScheduleRuleId"] isKindOfClass:NSString.class]
            ? info[@"looiScheduleRuleId"]
            : @"";
        if (ruleId.length == 0 && [ident hasPrefix:kScheduleAlarmPrefix] && ![ident hasPrefix:kSchedulePostPrefix]) {
            ruleId = [ident substringFromIndex:kScheduleAlarmPrefix.length];
        }
        NSString *runId = [info[@"looiScheduleRunId"] isKindOfClass:NSString.class]
            ? info[@"looiScheduleRunId"]
            : @"";
        NSString *sessionId = [info[@"looiScheduleSessionId"] isKindOfClass:NSString.class]
            ? info[@"looiScheduleSessionId"]
            : @"";
        NSString *source = [info[@"looiScheduleSource"] isKindOfClass:NSString.class]
            ? info[@"looiScheduleSource"]
            : @"alarm";
        NSString *metaJson = LooiScheduleJsonString(@{
            @"source": source,
            @"sessionId": sessionId ?: @"",
            @"actionIdentifier": response.actionIdentifier ?: @"",
        });
        LooiScheduleEnqueueEvent(@{
            @"kind": @"notification_tapped",
            @"ruleId": ruleId ?: @"",
            @"notificationId": ident,
            @"handle": runId ?: @"",
            @"payloadJson": metaJson,
            @"occurredAtMs": @((double)([[NSDate date] timeIntervalSince1970] * 1000.0)),
        });
        completionHandler();
        return;
    }
    id<UNUserNotificationCenterDelegate> prev = self.previousDelegate;
    if (prev && [prev respondsToSelector:@selector(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:)]) {
        [prev userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:completionHandler];
        return;
    }
    completionHandler();
}

@end

void looi_schedule_install(void) {
    @autoreleasepool {
        LooiScheduleEnsureGlobals();
        if (!LooiScheduleHasBundleId()) return;
        dispatch_block_t attach = ^{
            @synchronized ([LooiScheduleNotificationDelegate class]) {
                if (!gScheduleDelegate) {
                    gScheduleDelegate = [LooiScheduleNotificationDelegate new];
                }
                UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
                id<UNUserNotificationCenterDelegate> current = center.delegate;
                if (current != gScheduleDelegate) {
                    if (current != nil && ![current isKindOfClass:[LooiScheduleNotificationDelegate class]]) {
                        gScheduleDelegate.previousDelegate = current;
                    }
                    center.delegate = gScheduleDelegate;
                }
            }
        };
        if (NSThread.isMainThread) {
            attach();
        } else {
            dispatch_async(dispatch_get_main_queue(), attach);
        }
    }
}

int32_t looi_schedule_permission_status(void) {
    @autoreleasepool {
        LooiScheduleEnsureGlobals();
        if (!LooiScheduleHasBundleId()) {
            return 3; // unavailable
        }
        looi_schedule_install();
        if (NSThread.isMainThread) {
            return gCachedPermission;
        }
        __block int32_t result = gCachedPermission;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            result = LooiScheduleMapAuthStatus(settings.authorizationStatus);
            gCachedPermission = result;
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
        return result;
    }
}

int32_t looi_schedule_request_permission(char **error_out) {
    @autoreleasepool {
        LooiScheduleEnsureGlobals();
        if (!LooiScheduleHasBundleId()) {
            return 3; // unavailable
        }
        looi_schedule_install();
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        UNAuthorizationOptions opts = UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge;
        __block BOOL completed = NO;
        __block BOOL grantedOut = NO;
        __block NSError *authError = nil;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        [center requestAuthorizationWithOptions:opts completionHandler:^(BOOL granted, NSError *error) {
            grantedOut = granted;
            authError = error;
            completed = YES;
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC));
        if (!completed) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(@"ERR_IOS_NOTIFICATION_PERMISSION_TIMEOUT: Timed out waiting for notification authorization");
            }
            return -1;
        }
        if (authError) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(LooiScheduleFormatError(
                    @"ERR_IOS_NOTIFICATION_PERMISSION",
                    authError,
                    @"Notification authorization failed"));
            }
            return -1;
        }
        int32_t status = looi_schedule_permission_status();
        if (status == 0) {
            status = grantedOut ? 1 : 2;
            gCachedPermission = status;
        }
        return status;
    }
}

int32_t looi_schedule_sync_alarms(
    const char *alarms_json,
    int32_t *synced_out,
    int32_t *cancelled_out,
    char **error_out
) {
    @autoreleasepool {
        LooiScheduleEnsureGlobals();
        if (synced_out) *synced_out = 0;
        if (cancelled_out) *cancelled_out = 0;
        if (!LooiScheduleHasBundleId()) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(@"ERR_IOS_NOTIFICATION_UNAVAILABLE: Missing bundle identifier");
            }
            return 0;
        }
        looi_schedule_install();

        NSData *jsonData = alarms_json
            ? [NSData dataWithBytes:alarms_json length:strlen(alarms_json)]
            : [NSData data];
        NSError *parseErr = nil;
        id parsed = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&parseErr];
        if (![parsed isKindOfClass:NSArray.class] || parseErr) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(LooiScheduleFormatError(
                    @"ERR_INVALID_ALARMS_JSON",
                    parseErr,
                    @"Expected JSON array of alarms"));
            }
            return 0;
        }
        NSArray *alarms = (NSArray *)parsed;
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];

        __block NSArray<UNNotificationRequest *> *pending = @[];
        dispatch_semaphore_t listSem = dispatch_semaphore_create(0);
        [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *requests) {
            pending = requests ?: @[];
            dispatch_semaphore_signal(listSem);
        }];
        dispatch_semaphore_wait(listSem, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));

        NSMutableSet<NSString *> *targetIds = [NSMutableSet new];
        NSMutableArray<NSDictionary *> *validated = [NSMutableArray new];
        for (id item in alarms) {
            if (validated.count >= kMaxScheduledAlarms) break;
            if (![item isKindOfClass:NSDictionary.class]) continue;
            NSDictionary *dict = (NSDictionary *)item;
            NSString *ruleId = [dict[@"ruleId"] isKindOfClass:NSString.class] ? dict[@"ruleId"] : @"";
            NSString *title = [dict[@"title"] isKindOfClass:NSString.class] ? dict[@"title"] : @"";
            NSNumber *triggerAtMs = [dict[@"triggerAtMs"] isKindOfClass:NSNumber.class] ? dict[@"triggerAtMs"] : nil;
            if (ruleId.length == 0 || title.length == 0 || !triggerAtMs) continue;
            NSString *ident = [kScheduleAlarmPrefix stringByAppendingString:ruleId];
            [targetIds addObject:ident];
            [validated addObject:dict];
        }

        // Remove ONLY stale scheduled alarms with prefix "looi.sched." (excluding posted notifications and unrelated requests).
        NSMutableArray<NSString *> *toRemove = [NSMutableArray new];
        for (UNNotificationRequest *req in pending) {
            NSString *ident = req.identifier ?: @"";
            if ([ident hasPrefix:kScheduleAlarmPrefix]
                && ![ident hasPrefix:kSchedulePostPrefix]
                && ![targetIds containsObject:ident]) {
                [toRemove addObject:ident];
            }
        }
        if (toRemove.count > 0) {
            [center removePendingNotificationRequestsWithIdentifiers:toRemove];
        }

        dispatch_group_t group = dispatch_group_create();
        __block NSError *firstErr = nil;
        NSLock *errLock = [NSLock new];
        NSTimeInterval nowSec = [[NSDate date] timeIntervalSince1970];

        for (NSDictionary *dict in validated) {
            NSString *ruleId = dict[@"ruleId"];
            NSString *title = dict[@"title"];
            NSString *body = [dict[@"body"] isKindOfClass:NSString.class] ? dict[@"body"] : @"";
            BOOL silent = [dict[@"silent"] respondsToSelector:@selector(boolValue)]
                ? [dict[@"silent"] boolValue]
                : NO;
            double triggerAtMs = [dict[@"triggerAtMs"] doubleValue];
            NSTimeInterval delaySec = MAX(1.0, (triggerAtMs / 1000.0) - nowSec);

            UNMutableNotificationContent *content = [UNMutableNotificationContent new];
            content.title = title;
            if (body.length > 0) content.body = body;
            content.sound = silent ? nil : [UNNotificationSound defaultSound];
            content.userInfo = @{
                @"looiScheduleRuleId": ruleId,
                @"looiScheduleSource": @"alarm",
                @"looiScheduleSilent": @(silent),
            };

            NSString *ident = [kScheduleAlarmPrefix stringByAppendingString:ruleId];
            UNTimeIntervalNotificationTrigger *trigger =
                [UNTimeIntervalNotificationTrigger triggerWithTimeInterval:delaySec repeats:NO];
            UNNotificationRequest *req =
                [UNNotificationRequest requestWithIdentifier:ident content:content trigger:trigger];

            dispatch_group_enter(group);
            [center addNotificationRequest:req withCompletionHandler:^(NSError *error) {
                if (error) {
                    [errLock lock];
                    if (!firstErr) firstErr = error;
                    [errLock unlock];
                }
                dispatch_group_leave(group);
            }];
        }

        dispatch_group_wait(group, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
        if (firstErr) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(LooiScheduleFormatError(
                    @"ERR_IOS_NOTIFICATION_SCHEDULE_FAILED",
                    firstErr,
                    @"Failed to schedule local alarm notifications"));
            }
            return 0;
        }
        if (synced_out) *synced_out = (int32_t)validated.count;
        if (cancelled_out) *cancelled_out = (int32_t)toRemove.count;
        return 1;
    }
}

int32_t looi_schedule_cancel_alarm(const char *rule_id) {
    @autoreleasepool {
        if (!rule_id || !LooiScheduleHasBundleId()) return 0;
        NSString *ruleIdStr = [NSString stringWithUTF8String:rule_id];
        if (ruleIdStr.length == 0) return 0;
        NSString *ident = [kScheduleAlarmPrefix stringByAppendingString:ruleIdStr];
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];

        __block BOOL existed = NO;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *requests) {
            for (UNNotificationRequest *req in requests) {
                if ([req.identifier isEqualToString:ident]) {
                    existed = YES;
                    break;
                }
            }
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));

        [center removePendingNotificationRequestsWithIdentifiers:@[ident]];
        [center removeDeliveredNotificationsWithIdentifiers:@[ident]];
        return existed ? 1 : 0;
    }
}

int32_t looi_schedule_post_notification(const char *payload_json, char **id_out, char **error_out) {
    @autoreleasepool {
        LooiScheduleEnsureGlobals();
        if (!LooiScheduleHasBundleId()) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(@"ERR_IOS_NOTIFICATION_UNAVAILABLE: Missing bundle identifier");
            }
            return 0;
        }
        looi_schedule_install();

        int32_t perm = looi_schedule_permission_status();
        if (perm != 1) {
            if (error_out) {
                NSString *msg = [NSString stringWithFormat:@"ERR_NOTIFICATION_PERMISSION_DENIED: iOS notification authorization status is %d", perm];
                *error_out = LooiScheduleDupCString(msg);
            }
            return 0;
        }

        NSData *jsonData = payload_json
            ? [NSData dataWithBytes:payload_json length:strlen(payload_json)]
            : [NSData data];
        NSError *parseErr = nil;
        id parsed = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&parseErr];
        if (![parsed isKindOfClass:NSDictionary.class] || parseErr) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(LooiScheduleFormatError(
                    @"ERR_INVALID_NOTIFICATION_PAYLOAD",
                    parseErr,
                    @"Expected notification JSON object"));
            }
            return 0;
        }
        NSDictionary *dict = (NSDictionary *)parsed;
        NSString *rawId = [dict[@"id"] isKindOfClass:NSString.class] ? dict[@"id"] : @"";
        NSString *ruleId = [dict[@"ruleId"] isKindOfClass:NSString.class] ? dict[@"ruleId"] : @"";
        NSString *runId = [dict[@"runId"] isKindOfClass:NSString.class] ? dict[@"runId"] : @"";
        NSString *sessionId = [dict[@"sessionId"] isKindOfClass:NSString.class] ? dict[@"sessionId"] : @"";
        NSString *title = [dict[@"title"] isKindOfClass:NSString.class] ? dict[@"title"] : @"";
        NSString *body = [dict[@"body"] isKindOfClass:NSString.class] ? dict[@"body"] : @"";
        BOOL silent = [dict[@"silent"] respondsToSelector:@selector(boolValue)]
            ? [dict[@"silent"] boolValue]
            : NO;

        if (title.length == 0) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(@"ERR_INVALID_NOTIFICATION_PAYLOAD: title cannot be empty");
            }
            return 0;
        }

        NSString *ident = [rawId hasPrefix:kSchedulePostPrefix]
            ? rawId
            : [kSchedulePostPrefix stringByAppendingString:(rawId.length > 0 ? rawId : [NSUUID UUID].UUIDString)];

        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.title = title;
        if (body.length > 0) content.body = body;
        content.sound = silent ? nil : [UNNotificationSound defaultSound];
        content.userInfo = @{
            @"looiScheduleRuleId": ruleId,
            @"looiScheduleRunId": runId,
            @"looiScheduleSessionId": sessionId,
            @"looiScheduleSource": @"notification",
            @"looiScheduleSilent": @(silent),
        };

        UNNotificationRequest *req =
            [UNNotificationRequest requestWithIdentifier:ident content:content trigger:nil];
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];

        __block NSError *postErr = nil;
        __block BOOL completed = NO;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        [center addNotificationRequest:req withCompletionHandler:^(NSError *error) {
            postErr = error;
            completed = YES;
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));

        if (!completed) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(@"ERR_IOS_NOTIFICATION_POST_TIMEOUT: Timed out posting notification");
            }
            return 0;
        }
        if (postErr) {
            if (error_out) {
                *error_out = LooiScheduleDupCString(LooiScheduleFormatError(
                    @"ERR_IOS_NOTIFICATION_POST_FAILED",
                    postErr,
                    @"Failed to deliver notification"));
            }
            return 0;
        }
        if (id_out) *id_out = LooiScheduleDupCString(ident);
        return 1;
    }
}

int32_t looi_schedule_begin_background_grace(
    const char *label,
    char **handle_out,
    char **error_out
) {
    @autoreleasepool {
        LooiScheduleEnsureGlobals();
        NSString *taskName = (label && strlen(label) > 0)
            ? [NSString stringWithUTF8String:label]
            : @"looi.schedule.grace";

        [gScheduleLock lock];
        uint64_t seq = gNextBgSeq++;
        NSString *handle = [NSString stringWithFormat:@"ios_bg_%llu", (unsigned long long)seq];
        [gPendingBgHandles addObject:handle];
        [gScheduleLock unlock];

        UIApplication *app = [UIApplication sharedApplication];
        __block UIBackgroundTaskIdentifier blockTaskId = UIBackgroundTaskInvalid;
        UIBackgroundTaskIdentifier taskId = [app beginBackgroundTaskWithName:taskName expirationHandler:^{
            [gScheduleLock lock];
            BOOL wasPending = [gPendingBgHandles containsObject:handle];
            if (wasPending) {
                [gPendingBgHandles removeObject:handle];
                [gExpiredBgHandles addObject:handle];
            }
            NSNumber *stored = gBgTasks[handle];
            if (stored) {
                [gBgTasks removeObjectForKey:handle];
            }
            [gScheduleLock unlock];

            LooiScheduleEnqueueEvent(@{
                @"kind": @"ios_grace_expiring",
                @"ruleId": @"",
                @"notificationId": @"",
                @"handle": handle,
                @"payloadJson": LooiScheduleJsonString(@{ @"label": taskName }),
                @"occurredAtMs": @((double)([[NSDate date] timeIntervalSince1970] * 1000.0)),
            });

            UIBackgroundTaskIdentifier resolved = stored
                ? (UIBackgroundTaskIdentifier)[stored unsignedIntegerValue]
                : blockTaskId;
            if (resolved != UIBackgroundTaskInvalid) {
                [[UIApplication sharedApplication] endBackgroundTask:resolved];
            }
        }];
        blockTaskId = taskId;

        [gScheduleLock lock];
        [gPendingBgHandles removeObject:handle];
        BOOL expiredEarly = [gExpiredBgHandles containsObject:handle];
        [gExpiredBgHandles removeObject:handle];
        if (taskId == UIBackgroundTaskInvalid) {
            [gScheduleLock unlock];
            if (error_out) {
                *error_out = LooiScheduleDupCString(@"ERR_IOS_BACKGROUND_TASK_INVALID: UIApplication rejected beginBackgroundTaskWithName");
            }
            return 0;
        }
        if (expiredEarly) {
            [gScheduleLock unlock];
            [app endBackgroundTask:taskId];
            if (handle_out) *handle_out = LooiScheduleDupCString(handle);
            return 1;
        }
        gBgTasks[handle] = @((NSUInteger)taskId);
        [gScheduleLock unlock];

        if (handle_out) *handle_out = LooiScheduleDupCString(handle);
        return 1;
    }
}

void looi_schedule_end_background_grace(const char *handle) {
    @autoreleasepool {
        if (!handle || strlen(handle) == 0) return;
        LooiScheduleEnsureGlobals();
        NSString *handleStr = [NSString stringWithUTF8String:handle];
        [gScheduleLock lock];
        NSNumber *stored = gBgTasks[handleStr];
        if (stored) {
            [gBgTasks removeObjectForKey:handleStr];
        }
        [gScheduleLock unlock];

        if (stored) {
            UIBackgroundTaskIdentifier taskId = (UIBackgroundTaskIdentifier)[stored unsignedIntegerValue];
            if (taskId != UIBackgroundTaskInvalid) {
                [[UIApplication sharedApplication] endBackgroundTask:taskId];
            }
        }
    }
}

char *looi_schedule_drain_events(void) {
    @autoreleasepool {
        LooiScheduleEnsureGlobals();
        [gScheduleLock lock];
        NSArray<NSDictionary *> *snapshot = [gEventQueue copy];
        [gEventQueue removeAllObjects];
        [gScheduleLock unlock];

        if (!snapshot || snapshot.count == 0) {
            return LooiScheduleDupCString(@"[]");
        }
        NSError *err = nil;
        NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:&err];
        if (!data || err) {
            return LooiScheduleDupCString(@"[]");
        }
        NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        return LooiScheduleDupCString(json ?: @"[]");
    }
}

void looi_schedule_free_string(char *ptr) {
    free(ptr);
}
