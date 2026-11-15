//! Process-owned foreground state and screen policy, independent of JS reloads.
use block2::RcBlock;
use objc2::{MainThreadMarker, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::NSString;
use std::{
    cell::RefCell,
    ptr,
    sync::{
        Once,
        atomic::{AtomicBool, Ordering},
    },
};

static ACTIVE: AtomicBool = AtomicBool::new(false);

#[link(name = "UIKit", kind = "framework")]
unsafe extern "C" {
    static UIApplicationDidBecomeActiveNotification: *const NSString;
    static UIApplicationWillResignActiveNotification: *const NSString;
}

thread_local! {
    // UIKit notifications and the observer handles belong to the main thread.
    static OBSERVERS: RefCell<Vec<Retained<AnyObject>>> = const { RefCell::new(Vec::new()) };
}

// AppView registers native components on the main thread before starting its engine.
pub fn install(_mtm: MainThreadMarker) {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| unsafe {
        let application: Retained<AnyObject> =
            msg_send![objc2::class!(UIApplication), sharedApplication];
        let state: isize = msg_send![&application, applicationState];
        set_active(state == 0);

        let center: Retained<AnyObject> =
            msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
        for (name, active) in [
            (UIApplicationDidBecomeActiveNotification, true),
            (UIApplicationWillResignActiveNotification, false),
        ] {
            let callback = RcBlock::new(move |_note: *mut AnyObject| {
                set_active(active);
            });
            let observer: Retained<AnyObject> = msg_send![&center,
                addObserverForName: name,
                object: ptr::null::<AnyObject>(),
                queue: ptr::null::<AnyObject>(),
                usingBlock: &*callback
            ];
            OBSERVERS.with(|observers| observers.borrow_mut().push(observer));
        }
    });
}

// Engine calls must never synchronously wait for the main queue: reload joins the engine there.
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Acquire)
}

// Called only on the main queue or synchronously from UIKit lifecycle notifications.
unsafe fn set_active(active: bool) {
    ACTIVE.store(active, Ordering::Release);
    unsafe {
        let application: Retained<AnyObject> =
            msg_send![objc2::class!(UIApplication), sharedApplication];
        let _: () = msg_send![&application,
            setIdleTimerDisabled: objc2::runtime::Bool::new(active)
        ];
    }
}
