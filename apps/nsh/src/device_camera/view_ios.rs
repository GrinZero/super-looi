//! Native iOS preview view component (`looi.DeviceCameraPreview`) borrowing an active `DeviceCameraHost` session.
use super::{Session, SessionBackend, ios::*, lookup_session, tokio_handle};
use nsh_core::JsonValue;
use nsh_platform_ios::{ComponentContext, ComponentFactory, NativeComponent};
use objc2_ui_kit::UIView;
use std::{
    ffi::c_void,
    rc::Rc,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

struct ViewHandle(*mut c_void);

// `looi_device_camera_view_bind` and `looi_device_camera_view_release` hop to the main queue when called off-main.
unsafe impl Send for ViewHandle {}
unsafe impl Sync for ViewHandle {}

impl Drop for ViewHandle {
    fn drop(&mut self) {
        unsafe {
            looi_device_camera_view_release(self.0);
        }
    }
}

fn active_platform_handle(session: Option<&Session>) -> *mut c_void {
    match session {
        Some(s) if !s.closed.load(Ordering::Acquire) => match &s.backend {
            SessionBackend::Platform(p) => p.0,
            SessionBackend::Sample(_) => std::ptr::null_mut(),
        },
        _ => std::ptr::null_mut(),
    }
}

struct DeviceCameraPreviewView {
    view: Arc<ViewHandle>,
    context: ComponentContext,
    observer: Option<tokio::task::JoinHandle<()>>,
}

impl NativeComponent for DeviceCameraPreviewView {
    fn view(&self) -> &UIView {
        unsafe { &*self.view.0.cast::<UIView>() }
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        if name != "sessionId" {
            return;
        }
        if let Some(observer) = self.observer.take() {
            observer.abort();
        }
        let session_id = value
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);

        let initial_session = session_id.as_deref().and_then(lookup_session);
        let initial_handle = active_platform_handle(initial_session.as_deref());
        unsafe {
            looi_device_camera_view_bind(self.view.0, initial_handle);
        }
        let mut initial_sample_seq: Option<u64> = None;
        if let Some((facing, seq, face)) = initial_session
            .as_deref()
            .and_then(Session::sample_preview_snapshot)
        {
            let (ox, oy, fw, fh) = face
                .as_ref()
                .map(|f| {
                    (
                        f.offset_x as f32,
                        f.offset_y as f32,
                        f.width as f32,
                        f.height as f32,
                    )
                })
                .unwrap_or((0.0, 0.0, 0.0, 0.0));
            unsafe {
                looi_device_camera_view_present_sample(self.view.0, facing, seq, ox, oy, fw, fh);
            }
            initial_sample_seq = Some(seq);
        }

        let Some(target_id) = session_id else {
            return;
        };
        let Some(runtime) = initial_session
            .as_ref()
            .map(|s| s.runtime.clone())
            .or_else(tokio_handle)
        else {
            return;
        };
        let mut bound_session_ptr = initial_session
            .as_ref()
            .map(|s| Arc::as_ptr(s) as usize)
            .unwrap_or(0);
        drop(initial_session);

        let weak_view = Arc::downgrade(&self.view);
        let context = self.context.clone();
        let mut bound_addr = initial_handle as usize;
        let mut last_closed_ptr: usize = 0;
        let mut last_sample_seq = initial_sample_seq;

        self.observer = Some(runtime.spawn(async move {
            loop {
                let mut is_sample_active = false;
                {
                    let Some(view_handle) = weak_view.upgrade() else {
                        return;
                    };
                    let current = lookup_session(&target_id);
                    let next_handle = active_platform_handle(current.as_deref());
                    let next_addr = next_handle as usize;
                    let next_session_ptr = current
                        .as_ref()
                        .map(|s| Arc::as_ptr(s) as usize)
                        .unwrap_or(0);
                    if next_addr != bound_addr || next_session_ptr != bound_session_ptr {
                        unsafe {
                            looi_device_camera_view_bind(view_handle.0, next_handle);
                        }
                        bound_addr = next_addr;
                        bound_session_ptr = next_session_ptr;
                        last_sample_seq = None;
                    }
                    if let Some(session) = &current {
                        if let Some((facing, seq, face)) = session.sample_preview_snapshot() {
                            is_sample_active = true;
                            if last_sample_seq != Some(seq) {
                                let (ox, oy, fw, fh) = face
                                    .as_ref()
                                    .map(|f| {
                                        (
                                            f.offset_x as f32,
                                            f.offset_y as f32,
                                            f.width as f32,
                                            f.height as f32,
                                        )
                                    })
                                    .unwrap_or((0.0, 0.0, 0.0, 0.0));
                                unsafe {
                                    looi_device_camera_view_present_sample(
                                        view_handle.0,
                                        facing,
                                        seq,
                                        ox,
                                        oy,
                                        fw,
                                        fh,
                                    );
                                }
                                last_sample_seq = Some(seq);
                            }
                        } else if last_sample_seq.take().is_some() {
                            unsafe {
                                looi_device_camera_view_bind(view_handle.0, next_handle);
                            }
                        }
                        let session_ptr = Arc::as_ptr(session) as usize;
                        let is_closed = session.closed.load(Ordering::Acquire);
                        if !is_closed || last_closed_ptr != session_ptr {
                            if is_closed {
                                last_closed_ptr = session_ptr;
                            }
                            context.emit("state", session.status_json());
                        }
                    } else if last_sample_seq.take().is_some() {
                        unsafe {
                            looi_device_camera_view_bind(view_handle.0, std::ptr::null_mut());
                        }
                    }
                }
                let interval_ms = if is_sample_active { 120 } else { 250 };
                tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            }
        }));
    }
}

impl Drop for DeviceCameraPreviewView {
    fn drop(&mut self) {
        if let Some(observer) = self.observer.take() {
            observer.abort();
        }
    }
}

pub fn factory() -> ComponentFactory {
    Rc::new(|context| {
        Box::new(DeviceCameraPreviewView {
            view: Arc::new(ViewHandle(unsafe { looi_device_camera_view_create() })),
            context,
            observer: None,
        })
    })
}
