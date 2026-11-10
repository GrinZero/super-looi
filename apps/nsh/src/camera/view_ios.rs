use super::{Session, media::ios::*, sessions};
use nsh_core::JsonValue;
use nsh_platform_ios::{ComponentContext, ComponentFactory, NativeComponent};
use objc2_ui_kit::UIView;
use std::{ffi::c_void, rc::Rc, sync::Arc, time::Duration};

struct CameraView {
    view: *mut c_void,
    context: ComponentContext,
    session: Option<Arc<Session>>,
    observer: Option<tokio::task::JoinHandle<()>>,
}
impl NativeComponent for CameraView {
    fn view(&self) -> &UIView {
        unsafe { &*self.view.cast::<UIView>() }
    }
    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        if name != "sessionId" {
            return;
        }
        if let Some(observer) = self.observer.take() {
            observer.abort();
        }
        self.session = value
            .and_then(|v| v.as_str())
            .and_then(|id| sessions().lock().unwrap().get(id).and_then(|s| s.upgrade()));
        unsafe {
            looi_camera_view_bind(
                self.view,
                self.session
                    .as_ref()
                    .map_or(std::ptr::null_mut(), |s| s.decoder.0),
            );
        }
        if let Some(session) = &self.session {
            let weak = Arc::downgrade(session);
            let context = self.context.clone();
            self.observer = Some(session.runtime.spawn(async move {
                loop {
                    let Some(session) = weak.upgrade() else {
                        return;
                    };
                    context.emit("state", session.status());
                    drop(session);
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }));
        }
    }
}
impl Drop for CameraView {
    fn drop(&mut self) {
        if let Some(observer) = self.observer.take() {
            observer.abort();
        }
        unsafe {
            looi_camera_view_release(self.view);
        }
    }
}
pub fn factory() -> ComponentFactory {
    Rc::new(|context| {
        Box::new(CameraView {
            view: unsafe { looi_camera_view_create() },
            context,
            session: None,
            observer: None,
        })
    })
}
