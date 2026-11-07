use super::{ACTIVE, Navigation, Shared};
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
    sel,
};
use objc2_core_foundation::CGRect;
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
use std::{cell::RefCell, ptr};

#[link(name = "WebKit", kind = "framework")]
unsafe extern "C" {}
#[link(name = "UIKit", kind = "framework")]
unsafe extern "C" {
    static UIApplicationDidEnterBackgroundNotification: *const NSString;
}

thread_local! {
    static UI: RefCell<Option<BrowserUi>> = const { RefCell::new(None) };
    // Remains installed after UI dismissal to invalidate unconsumed callbacks/exchanges.
    static LIFECYCLE_OBSERVER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}
struct BrowserUi {
    id: u64,
    shared: Shared,
    controller: Retained<AnyObject>,
    web: Retained<AnyObject>,
    _delegate: Retained<LoginDelegate>,
    timer: Retained<AnyObject>,
    auth: String,
}
struct DelegateState {
    id: u64,
    shared: Shared,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateState]
    struct LoginDelegate;
    unsafe impl NSObjectProtocol for LoginDelegate {}
    impl LoginDelegate {
        #[unsafe(method(cancelLogin))]
        fn cancel_login(&self) { cancel(&self.ivars().shared, false); close(self.ivars().id); }
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(&self, _web: &AnyObject, action: &AnyObject, handler: &block2::Block<dyn Fn(isize)>) {
            let (main, has_frame, url) = unsafe {
                let frame: Option<Retained<AnyObject>> = msg_send![action, targetFrame];
                let main = frame.as_ref().is_some_and(|frame| msg_send![frame, isMainFrame]);
                let request: Retained<AnyObject> = msg_send![action, request];
                let url: Option<Retained<AnyObject>> = msg_send![&request, URL];
                let value: Option<Retained<NSString>> = url.and_then(|url| msg_send![&url, absoluteString]);
                (main, frame.is_some(), value.map(|v| v.to_string()).unwrap_or_default())
            };
            let decision = if has_frame { self.ivars().shared.lock().unwrap().navigation(&url, main) }
                else { Navigation::Block };
            handler.call(((decision == Navigation::Allow) as isize,));
            if decision == Navigation::Callback { close(self.ivars().id); }
        }
        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn failed_start(&self, _web: &AnyObject, _nav: Option<&AnyObject>, _error: &AnyObject) {
            self.failed();
        }
        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn failed_navigation(&self, _web: &AnyObject, _nav: Option<&AnyObject>, _error: &AnyObject) {
            self.failed();
        }
    }
);
impl LoginDelegate {
    fn new(mtm: MainThreadMarker, shared: Shared) -> Retained<Self> {
        let id = shared.lock().unwrap().id;
        let object = Self::alloc(mtm).set_ivars(DelegateState { id, shared });
        unsafe { msg_send![super(object), init] }
    }
    fn failed(&self) {
        let mut state = self.ivars().shared.lock().unwrap();
        // Policy cancellation itself can emit didFail; preserve captured callbacks.
        if state.status == "loading" {
            state.status = "failed";
            state.callback = None;
        }
        drop(state);
        close(self.ivars().id);
    }
}
fn class(name: &std::ffi::CStr) -> Result<&'static AnyClass, String> {
    AnyClass::get(name).ok_or_else(|| "miot_browser_unavailable".into())
}
fn cancel(shared: &Shared, failed: bool) {
    let mut state = shared.lock().unwrap();
    state.cancel();
    if failed {
        state.status = "failed";
    }
}
pub(super) fn open(shared: &Shared, auth: &str) -> Result<(), String> {
    let shared = shared.clone();
    let auth = auth.to_owned();
    let show_browser = || {
        let id = shared.lock().unwrap().id;
        if shared.lock().unwrap().status != "loading" {
            return Err("miot_login_cancelled".into());
        }
        let result = show(shared.clone(), auth);
        if result.is_err() {
            cancel(&shared, true);
            close(id);
        }
        result
    };
    if MainThreadMarker::new().is_some() {
        show_browser()
    } else {
        let mut result = Ok(());
        DispatchQueue::main().exec_sync(|| {
            result = show_browser();
        });
        result
    }
}

pub(super) fn close(id: u64) {
    // Deferred to avoid releasing a delegate during its own callback.
    DispatchQueue::main().exec_async(move || {
        let ui = UI.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.as_ref().is_some_and(|ui| ui.id == id) { slot.take() } else { None }
        });
        if let Some(ui) = ui {
            ui.shared.lock().unwrap().presented = false; unsafe {
            let _: () = msg_send![&ui.timer, invalidate];
            let _: () = msg_send![&ui.web, setNavigationDelegate: ptr::null::<AnyObject>()];
            let _: () = msg_send![&ui.web, stopLoading];
            let _: () = msg_send![&ui.controller, dismissViewControllerAnimated: false, completion: ptr::null::<AnyObject>()];
        } }
    });
}
fn show(shared: Shared, auth: String) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("miot_browser_unavailable")?;
    if UI.with(|slot| slot.borrow().is_some()) {
        return Err("miot_login_busy".into());
    }
    let id = shared.lock().unwrap().id;
    unsafe {
        let app: Retained<AnyObject> = msg_send![class(c"UIApplication")?, sharedApplication];
        let active: isize = msg_send![&app, applicationState];
        if active != 0 {
            return Err("miot_browser_unavailable".into());
        }
        let window: Option<Retained<AnyObject>> = msg_send![&app, keyWindow];
        let window = window.ok_or("miot_browser_unavailable")?;
        let mut presenter: Retained<AnyObject> = msg_send![&window, rootViewController];
        while let Some(next) = msg_send![&presenter, presentedViewController] {
            presenter = next;
        }
        let delegate = LoginDelegate::new(mtm, shared.clone());
        let config: Retained<AnyObject> = msg_send![class(c"WKWebViewConfiguration")?, new];
        let data: Retained<AnyObject> =
            msg_send![class(c"WKWebsiteDataStore")?, nonPersistentDataStore];
        let _: () = msg_send![&config, setWebsiteDataStore: &*data];
        let prefs: Retained<AnyObject> = msg_send![&config, preferences];
        let _: () = msg_send![&prefs, setJavaScriptCanOpenWindowsAutomatically: false];
        let root: Retained<AnyObject> = msg_send![class(c"UIViewController")?, new];
        let view: Retained<AnyObject> = msg_send![&root, view];
        let bounds: CGRect = msg_send![&view, bounds];
        let web: Allocated<AnyObject> = msg_send![class(c"WKWebView")?, alloc];
        let web: Retained<AnyObject> =
            msg_send![web, initWithFrame: bounds, configuration: &*config];
        let _: () = msg_send![&web, setAutoresizingMask: 18usize];
        let _: () = msg_send![&web, setNavigationDelegate: &*delegate];
        let _: () = msg_send![&view, addSubview: &*web];
        let nav: Retained<AnyObject> = msg_send![&root, navigationItem];
        let title = NSString::from_str("米家登录");
        let _: () = msg_send![&nav, setTitle: &*title];
        let button: Allocated<AnyObject> = msg_send![class(c"UIBarButtonItem")?, alloc];
        let button: Retained<AnyObject> = msg_send![button, initWithTitle: &*NSString::from_str("取消"), style: 0isize, target: &*delegate, action: sel!(cancelLogin)];
        let _: () = msg_send![&nav, setLeftBarButtonItem: &*button];
        let controller: Allocated<AnyObject> = msg_send![class(c"UINavigationController")?, alloc];
        let controller: Retained<AnyObject> =
            msg_send![controller, initWithRootViewController: &*root];
        let _: () = msg_send![&controller, setModalPresentationStyle: 0isize];
        let center: Retained<AnyObject> = msg_send![class(c"NSNotificationCenter")?, defaultCenter];
        LIFECYCLE_OBSERVER.with(|slot| {
            if slot.borrow().is_some() { return; }
            let background = RcBlock::new(move |_note: *mut AnyObject| {
                let session = ACTIVE.get().and_then(|slot| slot.lock().ok()?.upgrade());
                if let Some(session) = session {
                    let id = { let mut state = session.lock().unwrap(); state.cancel(); state.id };
                    close(id);
                }
            });
            let observer: Retained<AnyObject> = msg_send![&center, addObserverForName: UIApplicationDidEnterBackgroundNotification,
                object: ptr::null::<AnyObject>(), queue: ptr::null::<AnyObject>(), usingBlock: &*background];
            *slot.borrow_mut() = Some(observer);
        });
        let timeout_state = shared.clone();
        let timeout = RcBlock::new(move |_timer: *mut AnyObject| {
            {
                let mut state = timeout_state.lock().unwrap();
                state.status = "expired";
                state.callback = None;
            }
            close(id);
        });
        let timer: Retained<AnyObject> = msg_send![class(c"NSTimer")?, scheduledTimerWithTimeInterval: 600.0f64, repeats: false, block: &*timeout];
        UI.with(|slot| {
            *slot.borrow_mut() = Some(BrowserUi {
                id,
                shared: shared.clone(),
                controller: controller.clone(),
                web,
                _delegate: delegate,
                timer,
                auth,
            })
        });
        let _: () = msg_send![&presenter, presentViewController: &*controller, animated: false, completion: ptr::null::<AnyObject>()];
        shared.lock().unwrap().presented = true;
        // Install a native WebKit resource blocker before loading ANY page.
        let store: Retained<AnyObject> = msg_send![class(c"WKContentRuleListStore")?, defaultStore];
        let rules = NSString::from_str(
            r#"[{"trigger":{"url-filter":"^https?://homeassistant[.]local(:[0-9]+)?/","url-filter-is-case-sensitive":false},"action":{"type":"block"}}]"#,
        );
        let complete_state = shared.clone();
        let complete = RcBlock::new(move |list: *mut AnyObject, error: *mut AnyObject| {
            if MainThreadMarker::new().is_none() || list.is_null() || !error.is_null() {
                cancel(&complete_state, true);
                close(id);
                return;
            }
            UI.with(|slot| {
                let slot = slot.borrow();
                let Some(ui) = slot.as_ref().filter(|ui| ui.id == id) else { return; };
                if ui.shared.lock().unwrap().status != "loading" { return; }
                let config: Retained<AnyObject> = msg_send![&ui.web, configuration];
                let content: Retained<AnyObject> = msg_send![&config, userContentController];
                let _: () = msg_send![&content, addContentRuleList: list];
                let url: Retained<AnyObject> = msg_send![AnyClass::get(c"NSURL").unwrap(), URLWithString: &*NSString::from_str(&ui.auth)];
                let request: Retained<AnyObject> = msg_send![AnyClass::get(c"NSURLRequest").unwrap(), requestWithURL: &*url];
                let _: Option<Retained<AnyObject>> = msg_send![&ui.web, loadRequest: &*request];
            });
        });
        let _: () = msg_send![&store, compileContentRuleListForIdentifier: &*NSString::from_str("super-looi-miot-callback-block"), encodedContentRuleList: &*rules, completionHandler: &*complete];
    }
    Ok(())
}
