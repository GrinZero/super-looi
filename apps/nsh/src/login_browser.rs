//! App-owned OAuth browser. No JS injection, persistent callback storage or URL logs.
use nsh_core::prelude::*;
use std::sync::{
    Arc, Mutex, OnceLock, Weak,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
mod policy;
use policy::{Navigation, Policy};
#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
mod ios;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE: OnceLock<Mutex<Weak<Mutex<Session>>>> = OnceLock::new();
type Shared = Arc<Mutex<Session>>;

struct Session {
    id: u64,
    policy: Policy,
    deadline: Instant,
    status: &'static str,
    callback: Option<String>,
    presented: bool,
}
impl Session {
    fn expire(&mut self) {
        if self.deadline <= Instant::now()
            && matches!(self.status, "loading" | "callback" | "consumed")
        {
            self.status = "expired";
            self.callback = None;
        }
    }
    fn navigation(&mut self, url: &str, main_frame: bool) -> Navigation {
        self.expire();
        if self.status != "loading" {
            return Navigation::Block;
        }
        let decision = self.policy.navigation(url, main_frame);
        if decision == Navigation::Callback {
            self.callback = Some(url.to_owned());
            self.status = "callback";
        }
        decision
    }
    fn cancel(&mut self) {
        self.status = "cancelled";
        self.presented = false;
        self.callback = None;
    }
}

/// Dedicated native OAuth window; does not expose web content to JavaScript.
#[class]
pub struct MiotLoginBrowser {
    session: Option<Shared>,
}

#[class]
impl MiotLoginBrowser {
    /// Construct an idle browser without loading a page.
    pub fn new() -> Self {
        Self { session: None }
    }
    /// Validate an OAuth session and present its private login surface.
    pub fn open(&mut self, authorization_url: String, redirect_uri: String) -> Result<(), String> {
        let policy = Policy::new(&authorization_url, &redirect_uri)?;
        self.cancel();
        let session = Arc::new(Mutex::new(Session {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            policy,
            deadline: Instant::now() + Duration::from_secs(600),
            status: "loading",
            callback: None,
            presented: false,
        }));
        {
            let mut active = ACTIVE
                .get_or_init(|| Mutex::new(Weak::new()))
                .lock()
                .unwrap();
            if active.upgrade().is_some_and(|other| {
                let mut other = other.lock().unwrap();
                other.expire();
                matches!(other.status, "loading" | "callback" | "consumed")
            }) {
                return Err("miot_login_busy".into());
            }
            *active = Arc::downgrade(&session);
        }
        self.session = Some(session.clone());
        if let Err(error) = platform_open(&session, &authorization_url) {
            self.cancel();
            return Err(error);
        }
        Ok(())
    }
    /// Current lifecycle state, never a URL or server error description.
    pub fn status(&self) -> String {
        self.session
            .as_ref()
            .map(|session| {
                let mut session = session.lock().unwrap();
                session.expire();
                session.status.to_owned()
            })
            .unwrap_or_else(|| "idle".into())
    }
    /// True only after the native window has been presented.
    pub fn is_presented(&self) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| session.lock().unwrap().presented)
    }
    /// Consumed at most once; validation of OAuth state/code remains in MiotOAuthClient.
    pub fn take_callback(&self) -> String {
        let Some(session) = &self.session else {
            return String::new();
        };
        let mut session = session.lock().unwrap();
        session.expire();
        let result = session.callback.take().unwrap_or_default();
        if !result.is_empty() {
            session.status = "consumed";
        }
        result
    }
    /// Cancel the session and erase any unconsumed callback.
    pub fn cancel(&mut self) {
        if let Some(session) = self.session.take() {
            let id = {
                let mut session = session.lock().unwrap();
                session.cancel();
                session.id
            };
            platform_close(id);
        }
    }
}
impl Drop for MiotLoginBrowser {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn platform_open(session: &Shared, url: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android::open(session, url)
    }
    #[cfg(target_os = "ios")]
    {
        ios::open(session, url)
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (session, url);
        Err("miot_browser_unavailable".into())
    }
}
fn platform_close(id: u64) {
    #[cfg(target_os = "android")]
    android::close(id);
    #[cfg(target_os = "ios")]
    ios::close(id);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = id;
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> Session {
        let redirect = "http://homeassistant.local:8123/api/webhook/test";
        let mut url = url::Url::parse("https://account.xiaomi.com/oauth2/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("redirect_uri", redirect)
            .append_pair("response_type", "code")
            .append_pair("state", &"a".repeat(40));
        Session {
            id: 1,
            policy: Policy::new(url.as_str(), redirect).unwrap(),
            deadline: Instant::now() + Duration::from_secs(10),
            status: "loading",
            callback: None,
            presented: false,
        }
    }
    #[test]
    fn callback_is_one_shot_and_cancel_scrubs_unconsumed_code() {
        let mut state = session();
        let callback = "http://homeassistant.local:8123/api/webhook/test?code=secret";
        assert_eq!(state.navigation(callback, true), Navigation::Callback);
        assert_eq!(state.navigation(callback, true), Navigation::Block);
        state.cancel();
        assert!(state.callback.is_none());
        assert_eq!(state.navigation(callback, true), Navigation::Block);
    }
    #[test]
    fn expired_callback_cannot_be_consumed() {
        let mut state = session();
        state.navigation(
            "http://homeassistant.local:8123/api/webhook/test?code=secret",
            true,
        );
        state.deadline = Instant::now();
        let browser = MiotLoginBrowser {
            session: Some(Arc::new(Mutex::new(state))),
        };
        assert_eq!(browser.take_callback(), "");
        assert_eq!(browser.status(), "expired");
    }
    #[test]
    fn taking_callback_twice_returns_empty_second_time() {
        let mut state = session();
        state.navigation(
            "http://homeassistant.local:8123/api/webhook/test?code=secret",
            true,
        );
        let browser = MiotLoginBrowser {
            session: Some(Arc::new(Mutex::new(state))),
        };
        assert!(browser.take_callback().contains("code=secret"));
        assert_eq!(browser.take_callback(), "");
        assert_eq!(browser.status(), "consumed");
    }
    #[test]
    fn consumed_session_is_still_cancelled_or_expired_before_token_commit() {
        let mut state = session();
        state.status = "consumed";
        state.deadline = Instant::now();
        state.expire();
        assert_eq!(state.status, "expired");
        state.status = "consumed";
        state.cancel();
        assert_eq!(state.status, "cancelled");
        assert!(state.callback.is_none());
    }
}
