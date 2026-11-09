//! Process-owned foreground screen policy, independent of JS reloads and pages.
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::{msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::NSString;
use std::{cell::RefCell, ptr, sync::Once};

#[link(name = "UIKit", kind = "framework")]
unsafe extern "C" {
    static UIApplicationDidBecomeActiveNotification: *const NSString;
    static UIApplicationWillResignActiveNotification: *const NSString;
}

thread_local! {
    // UIKit notifications and the observer handles belong to the main thread.
    static OBSERVERS: RefCell<Vec<Retained<AnyObject>>> = const { RefCell::new(Vec::new()) };
}

pub fn install() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        DispatchQueue::main().exec_async(|| unsafe {
            let application: Retained<AnyObject> =
                msg_send![objc2::class!(UIApplication), sharedApplication];
            let state: isize = msg_send![&application, applicationState];
            set_idle_timer_disabled(state == 0);

            let center: Retained<AnyObject> =
                msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
            for (name, active) in [
                (UIApplicationDidBecomeActiveNotification, true),
                (UIApplicationWillResignActiveNotification, false),
            ] {
                let callback = RcBlock::new(move |_note: *mut AnyObject| {
                    set_idle_timer_disabled(active);
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
    });
}

// Called only on the main queue or synchronously from UIKit lifecycle notifications.
unsafe fn set_idle_timer_disabled(disabled: bool) {
    unsafe {
        let application: Retained<AnyObject> =
            msg_send![objc2::class!(UIApplication), sharedApplication];
        let _: () = msg_send![&application,
            setIdleTimerDisabled: objc2::runtime::Bool::new(disabled)
        ];
    }
}
